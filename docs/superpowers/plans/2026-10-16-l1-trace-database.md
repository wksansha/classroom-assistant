# L1 事件统一入库（trace_events + event_explanations）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 两条 L1 通道（实时 `/api/events`、批量归档 `/api/trace/archive`）统一落 SQLite `trace_events` 原始表（event_id 主键幂等），LLM 解释独立到 `event_explanations` 侧表，实时通道放开全 6 surface，旧 `events` 表退役。

**Architecture:** 服务端先把存储层换成两表（Task 2）与解释 source 透传（Task 3），再重写入口解析与两条路由（Task 4/5）；客户端 reporter 重写为新格式并放开 surface 门控（Task 8/9）；archiver/位点机制零改动。两仓库同批发布，旧 flat 协议不保留兼容。

**Tech Stack:** TypeScript、Express 5、better-sqlite3（WAL）、vitest、supertest；客户端 VS Code 扩展（vitest + vscode-mock）。

**Spec:** [2026-10-16-l1-trace-database-design.md](../specs/2026-10-16-l1-trace-database-design.md)（执行前先通读，本计划按其 §3–§8 逐条落地）

## Global Constraints

- 两个仓库：服务端 `d:\ruan\classroom-assistant`，客户端 `D:\ruan\vscode-pylearner`。各自创建分支 `feat/l1-trace-db`（沿用 feat 分支惯例）。
- 表结构严格按 spec §3.1/§3.2 DDL，不自增删列/索引。
- 事件 `id` 形如 `<surface>:<ulid>`，服务端校验正则 `/^(edit|run|chat|debug|diag|behavior):[0-9A-Za-z-]{6,64}$/`。
- `student_id` 白名单 `/^[A-Za-z0-9_-]+$/` 且不为 `unknown`；`class_id` 缺省 `default`。
- 实时通道：新事件 diag/run 才解释（成功事件不解释）+ 推 SSE；幂等命中返回 `{ok:true, duplicated:true}` 且不解释不推。归档通道永远只入库。
- 不新增依赖包；不迁移旧 `events` 数据（直接 DROP）。
- 测试运行环境 PowerShell：服务端测试在 `d:\ruan\classroom-assistant\packages\server` 下执行 `npx vitest run [文件]`；客户端测试在 `D:\ruan\vscode-pylearner` 下执行 `npx vitest run [文件]`。
- **dev server 运行期间不要并行跑服务端测试**（共享 git/数据目录，历史教训：index.lock 冲突）。
- 提交信息用 conventional commits（`feat(server): ...` / `feat(client): ...` / `test: ...` / `docs: ...`）。

## File Structure（改动地图）

服务端（packages/server/src，除注明外）：

| 文件 | 动作 | 职责 |
|---|---|---|
| packages/shared/src/events.ts | 修改 | `TraceSurface`/`IngressEvent` 类型 |
| persistence.ts | 重写事件部分 | 两表 DDL、insertTraceEvent(s)、saveExplanation、getters JOIN、DROP events |
| explainService/cache.ts + index.ts | 修改 | 解释结果带 `source: "llm"/"mock"` |
| eventIngress.ts | 重写 | 单一新格式解析 + `isDiagRunEvent` 守卫 |
| index.ts | 重写 /api/events | 入库→条件解释→条件推送流程；traceArchive 依赖接线（Task 5） |
| routes/traceArchive.ts | 重写 | 校验不变，落点换 `insertTraceEvents` |
| `__tests__/`{persistence,eventIngress,traceArchive,routes,integration,cache,explain}.test.ts | 更新/重写 | 覆盖新行为 |

客户端（D:\ruan\vscode-pylearner/src）：

| 文件 | 动作 |
|---|---|
| teacher/reporter.ts | 重写：原样平铺上报 + 10s 超时 |
| storage/l1Writer.ts | 删 `shouldReportToTeacher` 门控 |
| `test/identity/reporter-gating.test.ts` | 更新 |
| `test/storage/l1Writer-report-all.test.ts` | 新增 |
| tools（服务端仓库）simulator.js / demo-error-resolution.js | 升级新格式 |

---

### Task 1: shared 类型扩展（TraceSurface + IngressEvent）

**Files:**
- Modify: `d:\ruan\classroom-assistant\packages\shared\src\events.ts`

**Interfaces:**
- Produces: `export const TRACE_SURFACES = ["edit","run","chat","debug","diag","behavior"] as const;`、`export type TraceSurface = (typeof TRACE_SURFACES)[number];`、`export interface IngressEvent extends Omit<NormalizedEvent, "eventType"> { id: string; surface: TraceSurface; kind: string; payload: Record<string, unknown>; sessionId?: string; eventType?: "diag" | "run"; }`

- [ ] **Step 1: 在 events.ts 顶部（NormalizedEvent 定义之前）追加**

```ts
export const TRACE_SURFACES = ["edit", "run", "chat", "debug", "diag", "behavior"] as const;
export type TraceSurface = (typeof TRACE_SURFACES)[number];
```

- [ ] **Step 2: 在 NormalizedEvent 定义之后追加 IngressEvent**

```ts
/**
 * /api/events 新格式（spec §4.1）：TraceEvent 原样平铺 + 身份三字段。
 * eventType 仅 diag/run 有值（stateManager/解释链路专用）；其他 surface 为 undefined。
 */
export interface IngressEvent extends Omit<NormalizedEvent, "eventType"> {
  id: string;
  surface: TraceSurface;
  kind: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  eventType?: "diag" | "run";
}
```

- [ ] **Step 3: typecheck 验证不破坏现有消费方**

Run（在 packages/server 下）: `npx tsc --noEmit`
Expected: PASS（IngressEvent 是纯新增；Omit 保证 stateManager/explainService 现有签名不受影响）

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/events.ts
git commit -m "feat(shared): TraceSurface 与 IngressEvent 事件类型"
```

---

### Task 2: persistence 两表 + 新接口 + events 退役

**Files:**
- Modify: `d:\ruan\classroom-assistant\packages\server\src\persistence.ts`
- Rewrite: `d:\ruan\classroom-assistant\packages\server\src\__tests__\persistence.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export interface TraceEventRow { eventId: string; studentId: string; studentName: string; classId: string; surface: TraceSurface; kind: string; ts: string; sessionId: string | null; payload: string; date: string; }`（`ts` 为 ISO-8601 UTC，`payload` 为 JSON 字符串，`date` 为 `YYYY-MM-DD`）
  - `insertTraceEvent(row: TraceEventRow, explanation?: { category: string; subtype: string; knowledge: string; source: string }): boolean` —— INSERT OR IGNORE，返回是否新插入；带 explanation 时两者同事务
  - `insertTraceEvents(rows: TraceEventRow[]): { accepted: number; duplicated: number }` —— 单事务批量
  - `saveExplanation(eventId: string, exp: { category; subtype; knowledge; source }): void`（INSERT OR REPLACE，第二阶段补跑用）
  - `hasExplanation(eventId: string): boolean`
  - `getRecentEvents(limit)`/`getEventStats()` 改基于 trace_events（字段见下）
- 保留不动: `insertEvent`/`EventRow` 暂留（Task 5 随路由删除后一并删除），避免本任务编译失败。

- [ ] **Step 1: 写失败测试 —— 用以下内容整体替换 `persistence.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPersistence, type TraceEventRow } from "../persistence";

const exp = { category: "运算错误", subtype: "除数为0", knowledge: "除数不能为 0", source: "llm" as const };

const row = (over: Partial<TraceEventRow> = {}): TraceEventRow => ({
  eventId: "run:01J0ARZ9V8B", studentId: "stu001", studentName: "张三", classId: "3A",
  surface: "run", kind: "execution_error", ts: "2026-10-16T02:00:00.000Z",
  sessionId: null, payload: JSON.stringify({ error_message: "division by zero" }),
  date: "2026-10-16", ...over,
});

describe("persistence trace_events / event_explanations（SQLite，:memory:）", () => {
  let p: ReturnType<typeof createPersistence>;
  beforeEach(() => { p = createPersistence(":memory:"); });

  it("insertTraceEvent 新事件返回 true，getRecentEvents 读回字段完整", () => {
    expect(p.insertTraceEvent(row())).toBe(true);
    const rows = p.getRecentEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe("run:01J0ARZ9V8B");
    expect(rows[0].student_id).toBe("stu001");
    expect(rows[0].surface).toBe("run");
    expect(rows[0].kind).toBe("execution_error");
    expect(rows[0].payload).toBe(JSON.stringify({ error_message: "division by zero" }));
    expect(rows[0].date).toBe("2026-10-16");
    expect(rows[0].category).toBeNull(); // 未写解释
  });

  it("同 event_id 幂等：第二次返回 false，不产生重复行", () => {
    expect(p.insertTraceEvent(row())).toBe(true);
    expect(p.insertTraceEvent(row())).toBe(false);
    expect(p.getRecentEvents(10)).toHaveLength(1);
  });

  it("解释随原始行同事务写入；幂等命中不重复写解释", () => {
    expect(p.insertTraceEvent(row(), exp)).toBe(true);
    expect(p.insertTraceEvent(row(), exp)).toBe(false);
    const rows = p.getRecentEvents(10);
    expect(rows[0].category).toBe("运算错误");
    expect(rows[0].subtype).toBe("除数为0");
    expect(rows[0].knowledge).toBe("除数不能为 0");
  });

  it("insertTraceEvents 批量计数 accepted/duplicated（单事务）", () => {
    const r = p.insertTraceEvents([row({ eventId: "a:1" }), row({ eventId: "a:2" }), row({ eventId: "a:1" })]);
    expect(r).toEqual({ accepted: 2, duplicated: 1 });
    expect(p.getRecentEvents(10)).toHaveLength(2);
  });

  it("saveExplanation INSERT OR REPLACE；hasExplanation 判断", () => {
    p.insertTraceEvent(row({ eventId: "a:1" }));
    expect(p.hasExplanation("a:1")).toBe(false);
    p.saveExplanation("a:1", exp);
    expect(p.hasExplanation("a:1")).toBe(true);
    p.saveExplanation("a:1", { ...exp, subtype: "除数为零" });
    expect(p.getRecentEvents(1)[0].subtype).toBe("除数为零");
  });

  it("getEventStats：total/todayCount 基于 trace_events，byCategory 基于侧表", () => {
    p.insertTraceEvent(row({ eventId: "a:1" }), exp);
    p.insertTraceEvent(row({ eventId: "a:2", surface: "chat", kind: "user_message" }));
    const s = p.getEventStats();
    expect(s.total).toBe(2);
    expect(s.todayCount).toBe(2);
    expect(s.byCategory).toEqual([{ category: "运算错误", count: 1 }]);
  });

  it("启动迁移：旧 events 表被 DROP，error_cache/roster 等无损", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-mig-"));
    const file = path.join(dir, "t.db");
    const pre = new Database(file);
    pre.exec("CREATE TABLE events (id INTEGER PRIMARY KEY)");
    pre.exec("CREATE TABLE error_cache (raw_hash TEXT UNIQUE NOT NULL)");
    pre.close();
    const p2 = createPersistence(file);
    expect(p2.getRecentEvents(5)).toEqual([]);
    expect((p2 as any).getCacheStats().total).toBe(0); // error_cache 表存活即可
    p2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run（在 packages/server 下）: `npx vitest run src/__tests__/persistence.test.ts`
Expected: FAIL（`insertTraceEvent` 不存在 / 旧 events 逻辑）

- [ ] **Step 3: 实现 persistence.ts**

3a. 顶部 import 增加 `import type { TraceSurface } from "@classroom/shared";`；删除 `export interface EventRow {...}`（整个），在其原位置加：

```ts
export interface TraceEventRow {
  eventId: string;
  studentId: string;
  studentName: string;
  classId: string;
  surface: TraceSurface;
  kind: string;
  ts: string;      // ISO-8601 UTC（字典序即时间序）
  sessionId: string | null;
  payload: string; // 原样 payload JSON
  date: string;    // YYYY-MM-DD（UTC）
}

export interface EventExplanation {
  category: string;
  subtype: string;
  knowledge: string;
  source: string; // 'llm' | 'mock'
}
```

3b. `Persistence` 接口：删除 `insertEvent(row: EventRow): void;`，加入：

```ts
insertTraceEvent(row: TraceEventRow, explanation?: EventExplanation): boolean;
insertTraceEvents(rows: TraceEventRow[]): { accepted: number; duplicated: number };
saveExplanation(eventId: string, exp: EventExplanation): void;
hasExplanation(eventId: string): boolean;
```

3c. 迁移段（`if (tableExists("submissions")) ...` 之后）加：

```ts
if (tableExists("events")) db.exec("DROP TABLE events"); // 事件表退役（spec §5.4，无 event_id 不迁移）
```

3d. 建表 exec 模板中，删除 `CREATE TABLE IF NOT EXISTS events (...)` 与其两个 `idx_events_*` 索引，替换为（spec §3.1/§3.2 原文）：

```ts
CREATE TABLE IF NOT EXISTS trace_events (
  event_id     TEXT PRIMARY KEY,
  student_id   TEXT NOT NULL,
  student_name TEXT NOT NULL,
  class_id     TEXT NOT NULL DEFAULT 'default',
  surface      TEXT NOT NULL CHECK(surface IN ('edit','run','chat','debug','diag','behavior')),
  kind         TEXT NOT NULL,
  ts           TEXT NOT NULL,
  session_id   TEXT,
  payload      TEXT NOT NULL,
  date         TEXT NOT NULL,
  ingested_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trace_student_surface_ts ON trace_events(student_id, surface, ts);
CREATE INDEX IF NOT EXISTS idx_trace_class_ts           ON trace_events(class_id, ts);
CREATE INDEX IF NOT EXISTS idx_trace_date               ON trace_events(date);
CREATE TABLE IF NOT EXISTS event_explanations (
  event_id  TEXT PRIMARY KEY,
  category  TEXT NOT NULL,
  subtype   TEXT NOT NULL,
  knowledge TEXT NOT NULL,
  source    TEXT NOT NULL
);
```

3e. 实现方法（`insertEvent` 的旧实现暂留勿动；`getRecentEvents`/`getEventStats` 整体替换）：

```ts
insertTraceEvent(row, explanation) {
  const insertRow = db.prepare(`INSERT OR IGNORE INTO trace_events
    (event_id, student_id, student_name, class_id, surface, kind, ts, session_id, payload, date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const args = [row.eventId, row.studentId, row.studentName, row.classId, row.surface, row.kind, row.ts, row.sessionId, row.payload, row.date];
  if (!explanation) {
    return insertRow.run(...args).changes === 1;
  }
  const insertExp = db.prepare(`INSERT INTO event_explanations (event_id, category, subtype, knowledge, source) VALUES (?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    const ok = insertRow.run(...args).changes === 1;
    if (ok) insertExp.run(row.eventId, explanation.category, explanation.subtype, explanation.knowledge, explanation.source);
    return ok;
  });
  return tx();
},
insertTraceEvents(rows) {
  const ins = db.prepare(`INSERT OR IGNORE INTO trace_events
    (event_id, student_id, student_name, class_id, surface, kind, ts, session_id, payload, date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction((rs: TraceEventRow[]) => {
    let accepted = 0;
    for (const r of rs) {
      if (ins.run(r.eventId, r.studentId, r.studentName, r.classId, r.surface, r.kind, r.ts, r.sessionId, r.payload, r.date).changes === 1) accepted++;
    }
    return accepted;
  });
  const accepted = tx(rows);
  return { accepted, duplicated: rows.length - accepted };
},
saveExplanation(eventId, exp) {
  db.prepare(`INSERT INTO event_explanations (event_id, category, subtype, knowledge, source) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET category = excluded.category, subtype = excluded.subtype,
      knowledge = excluded.knowledge, source = excluded.source`)
    .run(eventId, exp.category, exp.subtype, exp.knowledge, exp.source);
},
hasExplanation(eventId) {
  return !!db.prepare("SELECT 1 FROM event_explanations WHERE event_id = ?").get(eventId);
},
getRecentEvents(limit) {
  return db.prepare(`SELECT t.event_id, t.student_id, t.class_id, t.surface, t.kind, t.ts, t.session_id,
       t.payload, t.date, t.ingested_at,
       x.category, x.subtype, x.knowledge
     FROM trace_events t LEFT JOIN event_explanations x ON x.event_id = t.event_id
     ORDER BY t.ingested_at DESC, t.event_id DESC LIMIT ?`).all(limit);
},
getEventStats() {
  const total = (db.prepare("SELECT COUNT(*) AS c FROM trace_events").get() as { c: number }).c;
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = (db.prepare("SELECT COUNT(*) AS c FROM trace_events WHERE date = ?").get(today) as { c: number }).c;
  const byCategory = db.prepare("SELECT category, COUNT(*) AS count FROM event_explanations GROUP BY category ORDER BY count DESC").all() as { category: string; count: number }[];
  return { total, todayCount, byCategory };
},
```

- [ ] **Step 4: 运行测试确认通过**

Run（在 packages/server 下）: `npx vitest run src/__tests__/persistence.test.ts src/__tests__/persistenceV2.test.ts`
Expected: PASS（persistenceV2 不涉及 events；若其引用了被改的 getter，按同字段形状最小修正）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/persistence.ts packages/server/src/__tests__/persistence.test.ts
git commit -m "feat(server): trace_events/event_explanations 两表与幂等写入接口"
```

---

### Task 3: 解释链路 source 透传（llm/mock）

**Files:**
- Modify: `packages/server/src/persistence.ts`（getCachedExplanation 返回 source）
- Modify: `packages/server/src/explainService/cache.ts`
- Modify: `packages/server/src/explainService/index.ts`
- Update: `packages/server/src/__tests__/cache.test.ts`、`packages/server/src/__tests__/explain.test.ts`

**Interfaces:**
- Consumes: Task 2 的表。
- Produces: `ExplainService.explain(ev)` 返回 `Explanation & { source: "llm" | "mock" }`（后续路由写 event_explanations.source 用）。`Cache.getExplanation(rawHash, fetcher)` 返回 `{ exp: Explanation; source: "llm" | "mock" }`。`persistence.getCachedExplanation(rawHash)` 返回 `(Explanation & { source: string }) | null`。

- [ ] **Step 1: persistence.getCachedExplanation 返回 source**

```ts
getCachedExplanation(rawHash) {
  const row = db.prepare("SELECT category, subtype, knowledge, source FROM error_cache WHERE raw_hash = ?").get(rawHash) as (Explanation & { source: string }) | undefined;
  if (!row) return null;
  db.prepare("UPDATE error_cache SET hit_count = hit_count + 1 WHERE raw_hash = ?").run(rawHash);
  return { category: row.category, subtype: row.subtype, knowledge: row.knowledge, source: row.source };
},
```

- [ ] **Step 2: 先通读 explainService/cache.ts 现实现**，然后将 `getExplanation` 改为返回 `{ exp, source }`：
  - 命中缓存：`source` 取缓存行的 source；
  - LLM 解析成功：`source: "llm"`；
  - 解析失败走 `mockExplain` 兜底：`source: "mock"`。
  - `saveCache(...)` 的 source 参数沿用该值（行为不变）。

- [ ] **Step 3: explainService/index.ts 的 explain 返回带 source**

```ts
export interface ExplainService {
  explain(ev: NormalizedEvent): Promise<Explanation & { source: "llm" | "mock" }>;
}
```

`explain` 内部：`const { exp, source } = await cache.getExplanation(...)`；成功 run 事件分支 `{ ...llm, category: categoryFor(ev.errorType) }` 改为 `{ ...llm, category: categoryFor(ev.errorType), source }`；无 cacheKey 的兜底分支返回 `{ category: "其他", subtype: "未知错误", knowledge: "请检查代码与输入是否正确", source: "mock" }`。

- [ ] **Step 4: 更新两个测试文件**

先运行 `npx vitest run src/__tests__/cache.test.ts src/__tests__/explain.test.ts` 看失败点，然后把对 `getExplanation(...)`/`explain(...)` 返回值的断言改为解构形状，并补断言：

```ts
// cache.test.ts 示例：mock 路径
const r = await cache.getExplanation("hash-x", async () => { throw new Error("llm down"); });
expect(r.source).toBe("mock");

// explain.test.ts 示例：LLM 正常解析路径
const result = await service.explain(ev);
expect(result.source).toBe("llm");
expect(result.category).toBe("运算错误");
```

Run: `npx vitest run src/__tests__/cache.test.ts src/__tests__/explain.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/persistence.ts packages/server/src/explainService packages/server/src/__tests__/cache.test.ts packages/server/src/__tests__/explain.test.ts
git commit -m "feat(server): 解释结果携带 llm/mock source"
```

---

### Task 4: eventIngress 单格式重写 + /api/events 新路由

**Files:**
- Rewrite: `packages/server/src/eventIngress.ts`
- Modify: `packages/server/src/index.ts`（仅 /api/events handler，行 71–133）
- Rewrite: `packages/server/src/__tests__/eventIngress.test.ts`
- Update: `packages/server/src/__tests__/routes.test.ts`、`packages/server/src/__tests__/integration.test.ts`（旧 flat 请求体 → 新格式）

**Interfaces:**
- Consumes: Task 1 `IngressEvent`、Task 2 `insertTraceEvent`、Task 3 带 source 的 explain。
- Produces:
  - `normalize(body: unknown): IngressEvent | null`（新单一格式）
  - `export function isDiagRunEvent(ev: IngressEvent): ev is IngressEvent & { eventType: "diag" | "run" }`
  - 响应：新事件/幂等命中均 `200 { ok: true, duplicated: boolean }`；校验失败 400。

- [ ] **Step 1: 整体替换 eventIngress.ts**

```ts
import type { IngressEvent, TraceSurface } from "@classroom/shared";
import { logEvent } from "./logger";

type AnyBody = Record<string, any>;

const SURFACE_VALUES = new Set<string>(["edit", "run", "chat", "debug", "diag", "behavior"]);
const EVENT_ID_PATTERN = /^(edit|run|chat|debug|diag|behavior):[0-9A-Za-z-]{6,64}$/;

export function isDiagRunEvent(ev: IngressEvent): ev is IngressEvent & { eventType: "diag" | "run" } {
  return ev.eventType === "diag" || ev.eventType === "run";
}

export function normalize(body: unknown): IngressEvent | null {
  if (!body || typeof body !== "object") {
    logEvent({ event: "event.invalid_body", level: "debug", data: { body } });
    return null;
  }
  const b = body as AnyBody;
  const idOk = typeof b.id === "string" && EVENT_ID_PATTERN.test(b.id);
  const surfaceOk = typeof b.surface === "string" && SURFACE_VALUES.has(b.surface);
  if (!idOk || !surfaceOk || typeof b.kind !== "string" || b.kind === "") {
    logEvent({ event: "event.unrecognized", level: "debug", data: { body } });
    return null;
  }
  const surface = b.surface as TraceSurface;
  const p: AnyBody = b.payload && typeof b.payload === "object" && !Array.isArray(b.payload) ? b.payload : {};
  const ts = toMs(b.ts);
  const isDiagRun = surface === "diag" || surface === "run";
  const exitCode = typeof p.exit_code === "number" ? p.exit_code : undefined;
  const success = isDiagRun && surface === "run" && exitCode === 0;
  const samples: string[] = isDiagRun && Array.isArray(p.samples) ? p.samples : [];
  const errorType = surface === "run" ? (p.error_type ?? null) : null;

  const ev: IngressEvent = {
    id: b.id,
    surface,
    kind: b.kind,
    payload: p,
    sessionId: typeof b.session_id === "string" ? b.session_id : undefined,
    studentId: p.student_id ?? b.student_id ?? null,
    studentName: b.student_name ?? b.student_id ?? "unknown",
    classId: b.class_id ?? "default",
    eventType: isDiagRun ? surface : undefined,
    success: isDiagRun ? success : false,
    errorType,
    errorMessage: surface === "diag" ? samples.join("; ") : (p.error_message ?? null),
    samples,
    rawMessage: surface === "diag" ? (samples[0] ?? "") : (p.error_message ?? ""),
    codeSnippet: p.code_snippet,
    cacheKey: isDiagRun ? extractCacheKey(surface as "diag" | "run", success, errorType, p.error_message, samples) : null,
    command: p.command,
    exitCode,
    filePath: p.file ?? p.file_path,
    lineNo: p.line,
    ts,
  };

  logEvent({ event: "event.normalized", level: "debug", data: {
    surface, kind: ev.kind, success: ev.success, cacheKey: ev.cacheKey, studentId: ev.studentId,
  } });
  return ev;
}

function extractCacheKey(
  eventType: "diag" | "run",
  success: boolean,
  errorType: string | null | undefined,
  errorMessage: string | null | undefined,
  samples: string[],
): string | null {
  if (success) return null;
  if (eventType === "diag") {
    return samples.length ? [...samples].sort((a, b) => a.length - b)[0] : null;
  }
  if (errorType && errorMessage) return `${errorType}: ${errorMessage}`;
  return null;
}

function toMs(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}
```

- [ ] **Step 2: 整体替换 index.ts 的 /api/events handler（行 71–133）**

注意：Task 4 阶段 traceArchive 仍是文件版（不动 `registerTraceArchiveRoutes` 调用与 `resolveTraceDir`，Task 5 再删）。`toRow` 辅助函数加在 `createApp` 内 `buildSnapshot` 旁：

```ts
const toRow = (ev: IngressEvent): TraceEventRow => {
  const tsIso = new Date(ev.ts).toISOString();
  return {
    eventId: ev.id, studentId: ev.studentId, studentName: ev.studentName, classId: ev.classId,
    surface: ev.surface, kind: ev.kind, ts: tsIso,
    sessionId: ev.sessionId ?? null,
    payload: JSON.stringify(ev.payload ?? {}),
    date: tsIso.slice(0, 10),
  };
};
```

（顶部 import 相应改为 `import { normalize, isDiagRunEvent } from "./eventIngress";`、`import type { IngressEvent } from "@classroom/shared";`、`import type { TraceEventRow } from "./persistence";`）

handler 主体：

```ts
app.post("/api/events", async (req, res) => {
  const startTime = Date.now();
  try {
    const ev = normalize(req.body);
    if (!ev) {
      logEvent({ event: "route.invalid_body", level: "warn", data: { path: req.path, bodyKeys: Object.keys(req.body ?? {}) } });
      return res.status(400).json({ error: "缺少必要字段" });
    }
    if (!ev.studentId || !/^[A-Za-z0-9_-]+$/.test(ev.studentId) || ev.studentId === "unknown") {
      logEvent({ event: "route.missing_student_id", level: "warn", data: { path: req.path, studentId: ev.studentId } });
      return res.status(400).json({ error: "student_id 非法" });
    }

    logEvent({ event: "route.event_received", data: {
      eventId: ev.id, studentId: ev.studentId, studentName: ev.studentName, classId: ev.classId,
      surface: ev.surface, kind: ev.kind, success: ev.success, ts: ev.ts,
    } });

    // 非 diag/run：仅入库（spec §2：原始行必写，不解释、不进内存看板）
    if (!isDiagRunEvent(ev)) {
      persistence.insertTraceEvent(toRow(ev));
      logEvent({ event: "route.event_stored", data: { eventId: ev.id, surface: ev.surface, kind: ev.kind }, durationMs: Date.now() - startTime });
      return res.json({ ok: true, duplicated: false });
    }

    // diag/run：成功事件只记活动信号不解释（现状语义保持）
    const explanation = ev.success ? null : await explainService.explain(ev);
    const inserted = persistence.insertTraceEvent(toRow(ev), explanation ? {
      category: explanation.category, subtype: explanation.subtype,
      knowledge: explanation.knowledge, source: explanation.source,
    } : undefined);

    if (!inserted) {
      // 幂等命中（典型：归档补传先到）：不解释、不推看板
      logEvent({ event: "route.event_duplicated", data: { eventId: ev.id, studentId: ev.studentId } });
      return res.json({ ok: true, duplicated: true });
    }

    stateManager.apply(ev, explanation);
    hub.publish(buildSnapshot());
    logEvent({ event: "route.event_processed", data: {
      eventId: ev.id, studentId: ev.studentId, surface: ev.surface, success: ev.success,
      explanationCategory: explanation?.category,
    }, durationMs: Date.now() - startTime });
    return res.json({ ok: true, duplicated: false });
  } catch (err) {
    logEvent({ event: "route.event_error", level: "error", data: {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }, durationMs: Date.now() - startTime });
    return res.status(500).json({ error: "服务器内部错误" });
  }
});
```

- [ ] **Step 3: 整体替换 eventIngress.test.ts**

```ts
import { describe, it, expect } from "vitest";
import { normalize, isDiagRunEvent } from "../eventIngress";

const base = {
  id: "diag:01J0ARZ9V8BABCDE", ts: "2026-10-16T06:31:14.754Z", surface: "diag",
  kind: "diagnostics_change",
  payload: { file: "a.py", samples: ["NameError: name 'x' is not defined"], errors: 1 },
  student_id: "2024001", student_name: "张三", class_id: "3A",
};

describe("normalize（spec §4.1 单一格式）", () => {
  it("diag：派生字段齐全，eventType=diag", () => {
    const ev = normalize(base)!;
    expect(ev.id).toBe(base.id);
    expect(ev.surface).toBe("diag");
    expect(ev.kind).toBe("diagnostics_change");
    expect(ev.studentId).toBe("2024001");
    expect(ev.eventType).toBe("diag");
    expect(ev.success).toBe(false);
    expect(ev.rawMessage).toBe("NameError: name 'x' is not defined");
    expect(ev.cacheKey).toBe("NameError: name 'x' is not defined");
  });

  it("run success（exit_code 0）：success=true、cacheKey=null", () => {
    const ev = normalize({ ...base, id: "run:01J0ARZ9V8BABCDE", surface: "run", kind: "execution_success",
      payload: { command: "python a.py", exit_code: 0 } })!;
    expect(ev.success).toBe(true);
    expect(ev.cacheKey).toBeNull();
    expect(isDiagRunEvent(ev)).toBe(true);
  });

  it("非 diag/run（chat）：eventType undefined，不派生 cacheKey/samples", () => {
    const ev = normalize({ ...base, id: "chat:01J0ARZ9V8BABCDE", surface: "chat", kind: "user_message",
      payload: { text: "你好" }, session_id: "s1" })!;
    expect(isDiagRunEvent(ev)).toBe(false);
    expect(ev.eventType).toBeUndefined();
    expect(ev.cacheKey).toBeNull();
    expect(ev.samples).toEqual([]);
    expect(ev.sessionId).toBe("s1");
  });

  it.each([
    ["缺 id", { ...base, id: undefined }],
    ["id 非 <surface>: 前缀", { ...base, id: "abc123" }],
    ["非法 surface", { ...base, surface: "hack" }],
    ["缺 kind", { ...base, kind: "" }],
  ])("%s → null", (_name, body) => {
    expect(normalize(body)).toBeNull();
  });
});
```

- [ ] **Step 4: 更新 routes.test.ts / integration.test.ts 中的旧 flat 请求体**

先运行 `npx vitest run src/__tests__/routes.test.ts src/__tests__/integration.test.ts`，将所有 POST `/api/events` 的请求体按下面映射改写（字段搬运，断言语义保持）：

| 旧 flat 字段 | 新格式位置 |
|---|---|
| `event_type: "run"` | `surface: "run", kind: "execution_error"/"execution_success"` |
| `error_type/error_message/command/exit_code/file_path/line_no/source/code_snippet` | 全部放进 `payload: { error_type, error_message, command, exit_code, file, line, source, code_snippet }`（file_path→file，line_no→line） |
| `timestamp` | `ts` |
| `samples/raw_message`（diag） | `payload: { file, samples, errors }` |
| `student_id/student_name/class_id` | 保留平铺 |

并必须补一个唯一 `id`（如 `run:t1`、`diag:t2`）。新增两条断言用例（放 routes.test.ts）：

```ts
it("重复 id → duplicated:true 且不重复解释/推送", async () => {
  const body = { id: "run:dup-test-0001", ts: new Date().toISOString(), surface: "run", kind: "execution_error",
    payload: { error_type: "ZeroDivisionError", error_message: "division by zero", exit_code: 1 },
    student_id: "2024001", student_name: "张三", class_id: "default" };
  await request(app).post("/api/events").send(body).expect(200).expect((r) => expect(r.body).toEqual({ ok: true, duplicated: false }));
  await request(app).post("/api/events").send(body).expect(200).expect((r) => expect(r.body).toEqual({ ok: true, duplicated: true }));
});

it("非 diag/run 事件只入库不进看板", async () => {
  await request(app).post("/api/events").send({
    id: "chat:chat-test-0001", ts: new Date().toISOString(), surface: "chat", kind: "user_message",
    payload: { text: "你好" }, student_id: "2024001", student_name: "张三" }).expect(200);
  // 快照中学生数不因此事件变化（无 stateManager.apply）
});
```

Run: `npx vitest run src/__tests__/routes.test.ts src/__tests__/integration.test.ts src/__tests__/eventIngress.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/eventIngress.ts packages/server/src/index.ts packages/server/src/__tests__/eventIngress.test.ts packages/server/src/__tests__/routes.test.ts packages/server/src/__tests__/integration.test.ts
git commit -m "feat(server): /api/events 单一 TraceEvent 格式并入库 trace_events"
```

---

### Task 5: traceArchive 落库重写 + traceDir 退役

**Files:**
- Rewrite: `packages/server/src/routes/traceArchive.ts`
- Modify: `packages/server/src/index.ts`（AppDeps、resolveTraceDir、registerTraceArchiveRoutes 调用）
- Modify: `packages/server/src/persistence.ts`（删除 insertEvent/EventRow）
- Rewrite: `packages/server/src/__tests__/traceArchive.test.ts`
- Update: `packages/server/src/__tests__/routes.test.ts` / `integration.test.ts`（createApp 调用若传了 `traceDir`，删除该参数）

**Interfaces:**
- Consumes: Task 2 `insertTraceEvents`。
- Produces: `registerTraceArchiveRoutes(app, { persistence })`；响应形状不变 `{ ok, accepted, duplicated }`（无 id 的坏事件计入 duplicated）。

- [ ] **Step 1: 整体替换 traceArchive.ts**

```ts
// packages/server/src/routes/traceArchive.ts
import type { Express } from "express";
import type { Persistence } from "../persistence";
import { logEvent } from "../logger";

const SURFACE_VALUES = new Set(["edit", "run", "chat", "debug", "diag", "behavior"]);
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;   // student_id/class_id 白名单（沿用，防注入语义不变）
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface TraceArchiveDeps {
  persistence: Persistence;
}

export function registerTraceArchiveRoutes(app: Express, deps: TraceArchiveDeps): void {
  app.post("/api/trace/archive", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const studentId = typeof body.student_id === "string" ? body.student_id : "";
    const studentName = typeof body.student_name === "string" && body.student_name !== "" ? body.student_name : studentId;
    const classId = typeof body.class_id === "string" && body.class_id !== "" ? body.class_id : "default";
    const surface = typeof body.surface === "string" ? body.surface : "";
    const date = typeof body.date === "string" ? body.date : "";
    const events = Array.isArray(body.events) ? body.events : [];

    if (!studentId || !NAME_PATTERN.test(studentId) || studentId === "unknown") {
      logEvent({ event: "archive.batch_rejected", level: "warn", data: { reason: "student_id", studentId } });
      return res.status(400).json({ error: "student_id 非法" });
    }
    if (!NAME_PATTERN.test(classId)) return res.status(400).json({ error: "class_id 非法" });
    if (!SURFACE_VALUES.has(surface)) return res.status(400).json({ error: "surface 非法" });
    if (!DATE_PATTERN.test(date)) return res.status(400).json({ error: "date 非法" });
    if (events.length === 0) return res.status(400).json({ error: "events 不能为空" });

    const rows = [];
    let malformed = 0;
    for (const item of events) {
      const it = (item ?? {}) as Record<string, unknown>;
      const eventId = typeof it.id === "string" && it.id !== "" ? it.id : null;
      if (!eventId) { malformed++; continue; }
      const rawTs = typeof it.ts === "string" && !Number.isNaN(Date.parse(it.ts)) ? Date.parse(it.ts) : Date.now();
      rows.push({
        eventId, studentId, studentName, classId,
        surface: surface as TraceEventRow["surface"],
        kind: typeof it.kind === "string" && it.kind !== "" ? it.kind : "unknown",
        ts: new Date(rawTs).toISOString(),
        sessionId: typeof it.session_id === "string" ? it.session_id : null,
        payload: JSON.stringify(it.payload ?? {}),
        date, // 批次头 date（客户端按天文件命名，批次内必属同一天）
      });
    }

    try {
      const { accepted, duplicated } = deps.persistence.insertTraceEvents(rows);
      logEvent({ event: "archive.batch_received", data: { studentId, classId, surface, date, accepted, duplicated: duplicated + malformed } });
      return res.json({ ok: true, accepted, duplicated: duplicated + malformed });
    } catch (err) {
      logEvent({ event: "archive.batch_error", level: "error", data: { error: err instanceof Error ? err.message : String(err) } });
      return res.status(500).json({ error: "服务器内部错误" });
    }
  });
}
```

（`TraceEventRow` 从 `../persistence` import。）

- [ ] **Step 2: index.ts 清理**

- `AppDeps` 删除 `traceDir?: string;` 字段及其注释；
- 删除 `resolveTraceDir` 整个函数（行 36–42）与 `import path from "node:path"`（若仅它使用）；
- `registerTraceArchiveRoutes(app, { traceDir: resolveTraceDir(deps.traceDir) })` 改为 `registerTraceArchiveRoutes(app, { persistence });`，其上注释更新为「L1 全量归档 → trace_events 批量入库（spec §4.2）」。

- [ ] **Step 3: persistence.ts 删除 `insertEvent` 实现与 `EventRow`**（Task 2 暂留的部分；确认 `__tests__` 中已无引用后删除）。

- [ ] **Step 4: 重写 traceArchive.test.ts（落库断言替代文件断言）**

```ts
// packages/server/src/__tests__/traceArchive.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createPersistence, type Persistence } from "../persistence";
import { registerTraceArchiveRoutes } from "../routes/traceArchive";

const ev = (id: string, over: Record<string, unknown> = {}) => ({
  id, ts: "2026-10-13T00:00:00.000Z", surface: "edit", kind: "code_change", payload: { n: 1 }, ...over });
const post = (app: express.Express, body: Record<string, unknown>) =>
  request(app).post("/api/trace/archive").send(body);

describe("POST /api/trace/archive（落库）", () => {
  let p: Persistence;
  let app: express.Express;
  beforeEach(() => {
    p = createPersistence(":memory:");
    app = express();
    app.use(express.json({ limit: "2mb" }));
    registerTraceArchiveRoutes(app, { persistence: p });
  });

  it("批量入库 accepted 计数；date/surface 取批次头", async () => {
    const res = await post(app, { student_id: "2024001", student_name: "张三", surface: "edit", date: "2026-10-13", events: [ev("e1"), ev("e2")] }).expect(200);
    expect(res.body).toEqual({ ok: true, accepted: 2, duplicated: 0 });
    const rows = p.getRecentEvents(10);
    expect(rows).toHaveLength(2);
    expect(rows[0].event_id).toBe("e1");
    expect(rows[0].date).toBe("2026-10-13");
    expect(rows[0].surface).toBe("edit");
    expect(rows[0].student_name).toBe("张三");
  });

  it("同 id 跨批次/乱序重传零重复", async () => {
    const batch = { student_id: "2024001", student_name: "张三", surface: "edit", date: "2026-10-13", events: [ev("e1"), ev("e2")] };
    await post(app, batch).expect(200);
    const res = await post(app, batch).expect(200);
    expect(res.body).toEqual({ ok: true, accepted: 0, duplicated: 2 });
    expect(p.getRecentEvents(10)).toHaveLength(2);
  });

  it("含 diag/run 的批次不产生解释行（归档永不解释）", async () => {
    await post(app, { student_id: "2024001", student_name: "张三", surface: "diag", date: "2026-10-13",
      events: [ev("d1", { surface: "diag", kind: "diagnostics_change", payload: { samples: ["X"], errors: 1 } })] }).expect(200);
    expect(p.getRecentEvents(1)[0].category).toBeNull();
  });

  it.each([
    [{ student_id: "unknown", surface: "edit", date: "2026-10-13", events: [ev("x")] }, "student_id 非法"],
    [{ student_id: "2024001", surface: "hack", date: "2026-10-13", events: [ev("x")] }, "surface 非法"],
    [{ student_id: "2024001", surface: "edit", date: "2026/10/13", events: [ev("x")] }, "date 非法"],
    [{ student_id: "2024001", surface: "edit", date: "2026-10-13", events: [] }, "events 不能为空"],
  ])("校验失败 400", async (body) => {
    await post(app, body).expect(400);
  });
});
```

- [ ] **Step 5: 全套回归 + typecheck**

Run（在 packages/server 下）: `npx tsc --noEmit` 然后 `npx vitest run`
Expected: 全绿（含 stateManager/aggregator/teacherHub/reviews/roster/llmProxy 回归；若 grep 到 `insertEvent|traceDir|resolveTraceDir` 残留引用逐一清除）

- [ ] **Step 6: Commit**

```bash
git add -A packages/server
git commit -m "feat(server): 归档通道落库 trace_events，events 表与 traceDir 退役"
```

---

### Task 6: tools 脚本升级为新格式

**Files:**
- Modify: `d:\ruan\classroom-assistant\tools\simulator.js`（post/nextEvent，行 76–102）
- Modify: `d:\ruan\classroom-assistant\tools\demo-error-resolution.js`（全文）

**Interfaces:** Consumes Task 4 新格式。Produces: 对 `/api/events` 打出新格式流量（手工验证用）。

- [ ] **Step 1: simulator.js —— 顶部加 `const crypto = require("node:crypto");`，替换 post 之后的部分**

```js
function makeEvent(surface, kind, payload) {
  return {
    id: `${surface}:${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`,
    ts: new Date().toISOString(),
    surface,
    kind,
    payload,
  };
}

function nextEvent() {
  const i = Math.floor(Math.random() * N);
  const student = {
    student_id: `stu${String(i + 1).padStart(3, "0")}`,
    student_name: NAMES[i % NAMES.length],
    class_id: "3A",
  };
  if (Math.random() < SUCCESS_RATIO) {
    return { ...student, ...makeEvent("run", "execution_success", { command: "python simple_functions.py", exit_code: 0, source: "terminal" }) };
  }
  if (Math.random() < 0.5) {
    const sample = pick(DIAG_SAMPLES);
    return { ...student, ...makeEvent("diag", "diagnostics_change", { file: "simple_functions.py", samples: [sample], errors: 1, code_snippet: codeSnippetFor(sample) }) };
  }
  const e = pick(RUN_ERRORS);
  return { ...student, ...makeEvent("run", "execution_error", { error_type: e.error_type, error_message: e.error_message, command: "python simple_functions.py", exit_code: 1, file: e.file, line: e.line, source: "terminal", code_snippet: codeSnippetFor(e.error_message) }) };
}
```

- [ ] **Step 2: demo-error-resolution.js —— STUDENT 去掉 timestamp 字段；两次 post 体替换**

```js
function makeEvent(surface, kind, payload) {
  return { id: `${surface}:${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`,
    ts: new Date().toISOString(), surface, kind, payload };
}
// 错误上报
const error = await post({
  ...STUDENT,
  ...makeEvent("run", "execution_error", { error_type: "SyntaxError", error_message: 'expected ":"',
    exit_code: 1, file: "simple_functions.py", line: 12, command: "python simple_functions.py", source: "terminal" }),
});
// 成功上报
const success = await post({
  ...STUDENT,
  ...makeEvent("run", "execution_success", { exit_code: 0, command: "python simple_functions.py", source: "terminal" }),
});
```

（顶部加 `const crypto = require('node:crypto');`）

- [ ] **Step 3: 手工冒烟（dev server 启动后）**

Run: `node tools/demo-error-resolution.js`（或临时把 120s 等待缩短观察）
Expected: 日志无 400/500；`GET /api/stats` 的 events.total 增长；看板该学生状态变化。

- [ ] **Step 4: Commit**

```bash
git add tools/simulator.js tools/demo-error-resolution.js
git commit -m "chore(tools): simulator/demo 升级 TraceEvent 新格式"
```

---

### Task 7: 服务端文档更新

**Files:**
- Modify: `d:\ruan\classroom-assistant\docs\database-schema.md`（§二.1 events 段落 37–59、ER 图 20–34、表间关系 §四）
- Modify: `d:\ruan\classroom-assistant\docs\architecture.md`（行 141 表清单、276/466 API 行、295 数据流、353 DDL 片段）

- [ ] **Step 1: database-schema.md** —— 删除「### 1. events —— 错误/运行事件表」整节，替换为「### 1. trace_events —— L1 原始事件表」与「### 2a. event_explanations —— LLM 解释侧表」两节，DDL 与字段说明从 spec §3.1/§3.2 拷贝（含幂等语义、`ingested_at` 与 `ts` 区别、归档通道不解释的规则）；ER 图与「表间关系汇总」中 events 引用替换为 `trace_events 1—1 event_explanations`。
- [ ] **Step 2: architecture.md** —— 行 141 表清单行改为 `trace_events | L1 原始事件 | event_id(PK), student_id, student_name, class_id, surface, kind, ts, session_id, payload, date, ingested_at` 与 `event_explanations | 解释侧表 | event_id(PK/FK 语义), category, subtype, knowledge, source`；行 276 API 行改 `POST /api/events | 学生事件上报（全 surface，TraceEvent 原样平铺）`；行 295 数据流改 `Reporter → POST /api/events → normalize → insertTraceEvent（幂等）→ [diag/run 新事件] explain → event_explanations + stateManager + SSE`；行 353 DDL 片段替换为 trace_events DDL；行 456/466 响应示例加 `duplicated` 字段。
- [ ] **Step 3: Commit**

```bash
git add docs/database-schema.md docs/architecture.md
git commit -m "docs: 数据库与架构文档同步 trace_events 两表"
```

---

### Task 8: 客户端 reporter 重写（原样上报 + 10s 超时）

**Files:**
- Rewrite: `D:\ruan\vscode-pylearner\src\teacher\reporter.ts`
- Update: `D:\ruan\vscode-pylearner\src\test\identity\reporter-gating.test.ts`

**Interfaces:**
- Consumes: `TraceEvent`（src/events/types.ts，已含 id/session_id）。
- Produces: `createTeacherReporter(deps)` 签名不变（`report(event): Promise<void>`），请求体为新 §4.1 格式；`buildPayload` 删除。

- [ ] **Step 1: 整体替换 reporter.ts**

```ts
/**
 * 教师端上报器（spec §6.1）
 *
 * 将 L1 TraceEvent 原样平铺上报（全 surface，服务端决定是否解释/进看板）。
 * 由 L1Writer.setTeacherReporter() 注入。10s 超时；失败只打日志不重试
 * （幂等与补传由归档通道承担）。
 */

import type { TraceEvent } from "../events/types";

export interface TeacherReporterDeps {
  teacherUrl: string;
  /** 每次上报时调用（而非激活时固化），学号/姓名修改后下一次上报立即生效 */
  getIdentity: () => { studentId: string | null; studentName: string | null; classId?: string };
}

const FETCH_TIMEOUT_MS = 10_000;

export function createTeacherReporter(deps: TeacherReporterDeps) {
  const { teacherUrl } = deps;

  return {
    async report(event: TraceEvent): Promise<void> {
      const identity = deps.getIdentity();
      // 身份门控（A8）：未设身份不上报，本地 L1 照记
      if (!identity.studentId || !identity.studentName) {
        console.log("[TeacherReporter] 身份未设置，跳过上报（本地 L1 照记）");
        return;
      }
      const body = {
        id: event.id,
        ts: event.ts,
        surface: event.surface,
        kind: event.kind,
        payload: event.payload,
        ...(event.session_id ? { session_id: event.session_id } : {}),
        student_id: identity.studentId,
        student_name: identity.studentName,
        class_id: identity.classId || "default",
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(teacherUrl + "/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          console.warn(`[TeacherReporter] 上报失败 (${res.status}):`, await res.text().catch(() => ""));
        }
      } catch (err) {
        // 网络不可用/超时只打日志，不影响 L1 写入
        console.warn("[TeacherReporter] 无法连接教师端:", err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
```

- [ ] **Step 2: reporter-gating.test.ts 保留原身份门控用例，追加两例**

```ts
it("全 surface 原样上报：请求体平铺 id/ts/surface/kind/payload/session_id + 身份", async () => {
  const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
  vi.stubGlobal("fetch", fetchSpy);
  const reporter = createTeacherReporter({
    teacherUrl: "http://t:3000",
    getIdentity: () => ({ studentId: "2024001", studentName: "张三", classId: "3A" }),
  });
  await reporter.report({ id: "chat:01J0ARZ9V8B", ts: "2026-10-16T06:00:00.000Z", surface: "chat", kind: "user_message", payload: { text: "你好" }, session_id: "s1" });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://t:3000/api/events");
  expect(JSON.parse(String(init.body))).toMatchObject({
    id: "chat:01J0ARZ9V8B", surface: "chat", kind: "user_message",
    payload: { text: "你好" }, session_id: "s1",
    student_id: "2024001", student_name: "张三", class_id: "3A",
  });
});

it("10s 超时：abort 只记日志不抛错、不重试", async () => {
  vi.useFakeTimers();
  const fetchSpy = vi.fn((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
  vi.stubGlobal("fetch", fetchSpy);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const reporter = createTeacherReporter({
    teacherUrl: "http://t:3000",
    getIdentity: () => ({ studentId: "2024001", studentName: "张三" }),
  });
  const p = reporter.report({ id: "edit:01J0ARZ9V8B", ts: "2026-10-16T06:00:00.000Z", surface: "edit", kind: "code_change", payload: {} });
  await vi.advanceTimersByTimeAsync(10_000);
  await p;
  expect(fetchSpy).toHaveBeenCalledTimes(1); // 不重试
  expect(warnSpy).toHaveBeenCalled();
  warnSpy.mockRestore();
  vi.useRealTimers();
});
```

- [ ] **Step 3: 运行测试**

Run（在 vscode-pylearner 下）: `npx vitest run src/test/identity/reporter-gating.test.ts src/test/llm/teacher.test.ts`
Expected: PASS（teacher.test 是聊天 provider 测试，确认 reporter 改动无连带破坏）

- [ ] **Step 4: Commit（客户端仓库）**

```bash
git add src/teacher/reporter.ts src/test/identity/reporter-gating.test.ts
git commit -m "feat(client): reporter 原样平铺上报全 surface 并加 10s 超时"
```

---

### Task 9: 客户端 l1Writer 放开 surface 门控

**Files:**
- Modify: `D:\ruan\vscode-pylearner\src\storage\l1Writer.ts`（行 60 门控条件、行 136–141 函数删除）
- Create: `D:\ruan\vscode-pylearner\src\test\storage\l1Writer-report-all.test.ts`

**Interfaces:** Consumes Task 8 reporter。无对外签名变化。

- [ ] **Step 1: l1Writer.ts —— append 中门控条件改为恒真语义**

```ts
    // 异步上报到教师端（非阻塞，失败不影响 L1 持久化；全 surface 均上报，spec §6.2）
    if (this.reporter) {
      this.reporter.report(event).catch((err: unknown) => {
        console.warn("[L1Writer] 教师端上报失败:", err instanceof Error ? err.message : String(err));
      });
    }
```

删除文件末尾整个 `function shouldReportToTeacher(...) {...}`。

- [ ] **Step 2: 新增 l1Writer-report-all.test.ts（沿用 vscode-mock 模式）**

```ts
import { describe, it, expect, vi } from "vitest";
import "../vscode-mock";
import * as vscode from "vscode";
import { L1Writer } from "../../storage/l1Writer";

describe("L1Writer 全 surface 上报（spec §6.2：门控放开）", () => {
  it("edit/chat/behavior/debug 事件均调用 reporter.report，session_id 透传", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(new Uint8Array(0));
    const writer = new L1Writer({ fsPath: "/tmp/x", toString: () => "file:///tmp/x" } as never);
    const report = vi.fn().mockResolvedValue(undefined);
    writer.setTeacherReporter({ report } as never);
    await writer.append("edit", "code_change", { file: "a.py" });
    await writer.append("chat", "user_message", { text: "你好" }, "s1");
    await writer.append("behavior", "typing_session", {});
    await writer.append("debug", "breakpoint_change", {});
    expect(report).toHaveBeenCalledTimes(4);
    const surfaces = report.mock.calls.map((c) => (c[0] as { surface: string }).surface);
    expect(surfaces).toEqual(["edit", "chat", "behavior", "debug"]);
    const chat = report.mock.calls[1][0] as { session_id?: string };
    expect(chat.session_id).toBe("s1");
  });
});
```

- [ ] **Step 3: 运行存储域测试**

Run（在 vscode-pylearner 下）: `npx vitest run src/test/storage src/test/archive`
Expected: PASS（l1Writer-identity/submission、archiver/batcher/archiveState 全部保持——协议与位点未改）

- [ ] **Step 4: Commit（客户端仓库）**

```bash
git add src/storage/l1Writer.ts src/test/storage/l1Writer-report-all.test.ts
git commit -m "feat(client): L1Writer 全 surface 实时上报"
```

---

### Task 10: 双端全量回归 + 手工端到端验证

**Files:** 无代码改动；发现问题回对应 Task 修复后重跑本任务。

- [ ] **Step 1: 服务端全量**

Run（在 packages/server 下）: `npx tsc --noEmit` 然后 `npx vitest run`
Expected: 全绿

- [ ] **Step 2: 客户端全量**

Run（在 vscode-pylearner 下）: `npx vitest run`
Expected: 全绿

- [ ] **Step 3: 手工端到端（dev server + VS Code 扩展开发宿主）**

1. 打包安装新扩展（或 F5 扩展开发宿主），设好身份；
2. 学生端随便改代码/跑 F5/发一条聊天 → 服务端 `GET /api/stats` events.total 增长，diag/run 事件在看板可见，chat/behavior 不在看板出现；
3. 重启 VS Code（触发归档）→ 服务端日志 `archive.batch_received`，`GET /api/events`（调试接口）能查到含 chat/behavior 的行且 category 为 null；重复激活再归档 → duplicated 计数增长、无重复行；
4. 断网（停服务）→ 学生端正常写本地、上报 warn 日志；恢复服务 → 重启 VS Code 后缺口被归档补齐。

- [ ] **Step 4: 双仓库推送**

```bash
git push -u origin feat/l1-trace-db   # 两个仓库各执行一次
```

---

## Self-Review 结论（已执行）

- **Spec 覆盖**：§3 两表→Task 2；§4.1→Task 4；§4.2→Task 5；§5.1–5.4→Task 2/3/4/5；§6.1–6.2→Task 8/9；§6.3/6.4 无改动（不建任务）；§7 边界由 Task 4/5 校验与测试覆盖；§8 测试计划→各任务测试步骤 + Task 10；simulator/demo→Task 6；文档→Task 7。spec §10 为第二阶段预留，不建任务（正确）。
- **占位符扫描**：无 TBD/“适当处理”类步骤；Task 3 Step 2 与 Task 4 Step 4 均给出目标形状 + 具体断言示例。
- **类型一致性**：`TraceEventRow`/`EventExplanation`（Task 2）与 Task 4 `toRow`、Task 5 rows 构造字段一致；`explain` 返回 `source`（Task 3）与 Task 4 路由消费一致；`IngressEvent`/`isDiagRunEvent`（Task 1/4）与 stateManager 现签名兼容（窄化类型可赋值给 NormalizedEvent）。
