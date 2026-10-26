# 测试学生标记（花名册 is_test）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 花名册支持「测试学生」标记——标记后服务端不收集该学号任何数据（实时/归档/心跳），大屏完全不展示，评审链路照常（教师测全流程用）。

**Architecture:** roster 表加 `is_test` 列（PRAGMA 迁移）→ 三个入口（/api/events、/api/trace/archive、/api/heartbeat）各设门禁 → `buildSnapshot` 按 isTest 过滤三处（records / rosterGhosts / rosterTotal）→ RosterPanel 行开关 + 徽章。实时丢弃用 200（防 warn 刷屏），归档用 400（复用客户端「跳尾不重试」语义）。

**Tech Stack:** TypeScript / Express 5 / better-sqlite3 / Vue 3 / vitest / supertest

**Spec:** `docs/superpowers/specs/2026-10-26-test-student-roster-flag-design.md`（本计划从该 spec 论证，执行者需同时阅读）

## Global Constraints

- 实时 `/api/events` 对测试学号返回 `200 {ok:true, dropped:true}`，**不允许 400**（测试学生持续产生 edit 事件，400 会刷爆 warn 日志）
- 归档 `/api/trace/archive` 对测试学号返回 **400 "student is test"**（客户端语义 = 不重试、位点跳尾，与既有名册门禁一致）
- 评审链路**不拦**：测试学生的 review_results 照常落行（spec 已声明的例外）
- `POST /api/roster`（全量导入）后所有 is_test 归零（spec 边界 1，学期换血语义，不保留）
- 历史已入库数据不清洗；取消标记即时恢复收集与展示
- 学号参数白名单一律 `/^[A-Za-z0-9_-]+$/`（既有约定）
- 测试环境 `createApp({ dbPath: ":memory:", llmConfig: null, reviewConfig: null })`；无 ADMIN_PASSWORD 环境变量时 /api/roster 路由不设防（既有行为，测试无需带 token）

---

### Task 1: shared 类型 + persistence is_test 列与读写

**Files:**
- Modify: `packages/shared/src/assignment.ts:14`（RosterEntry）
- Modify: `packages/server/src/persistence.ts`（roster 建表 ~L135、迁移块 ~L96、getRoster/getRosterEntry ~L259-264、Persistence 接口 ~L57-63、新增 setRosterTest）
- Modify: `packages/server/src/controllers/rosterController.ts:11`（parseRosterText 构造补 isTest）
- Modify: `packages/server/src/routes/roster.ts:57`（provisionEntries 调用点构造补 isTest）
- Test: `packages/server/src/__tests__/testStudent.test.ts`（新建）

**Interfaces:**
- Produces: `RosterEntry { studentId: string; studentName: string; isTest: boolean }`（shared，全链路共用）
- Produces: `persistence.setRosterTest(studentId: string, isTest: boolean): boolean`（Task 2 路由调用）
- Produces: `persistence.getRosterEntry(id)` 返回值含 `isTest: boolean`（Task 3 三个门禁调用）

- [ ] **Step 1: 写失败测试**

新建 `packages/server/src/__tests__/testStudent.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createPersistence } from "../persistence";

describe("roster is_test 列（测试学生标记）", () => {
  it("新建库：默认 isTest=false；setRosterTest 可切换且影响读取", () => {
    const p = createPersistence(":memory:");
    p.upsertRosterEntry("9001", "测试生");
    expect(p.getRoster()[0]).toMatchObject({ studentId: "9001", studentName: "测试生", isTest: false });
    expect(p.setRosterTest("9001", true)).toBe(true);
    expect(p.getRosterEntry("9001")?.isTest).toBe(true);
    expect(p.setRosterTest("9001", false)).toBe(true);
    expect(p.getRosterEntry("9001")?.isTest).toBe(false);
  });

  it("setRosterTest：学号不存在返回 false", () => {
    const p = createPersistence(":memory:");
    expect(p.setRosterTest("ghost", true)).toBe(false);
  });

  it("老库迁移：无 is_test 列的 roster 表自动补列，数据无损", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-mig-"));
    const dbPath = path.join(dir, "assistant.db");
    const old = new Database(dbPath);   // 模拟老库：roster 无 is_test 列
    old.exec("CREATE TABLE roster (student_id TEXT PRIMARY KEY, student_name TEXT NOT NULL, created_at INTEGER NOT NULL)");
    old.prepare("INSERT INTO roster (student_id, student_name, created_at) VALUES (?, ?, ?)").run("9002", "老数据", Date.now());
    old.close();

    const p = createPersistence(dbPath);   // 启动迁移
    expect(p.getRoster()[0]).toMatchObject({ studentId: "9002", studentName: "老数据", isTest: false });
    p.setRosterTest("9002", true);
    expect(p.getRosterEntry("9002")?.isTest).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/testStudent.test.ts`
Expected: FAIL（`isTest` 不存在于 RosterEntry / `setRosterTest` 不存在于 Persistence）

- [ ] **Step 3: shared 类型加字段**

`packages/shared/src/assignment.ts:14`：

```ts
export interface RosterEntry { studentId: string; studentName: string; /** 测试学生：大屏排除 + 服务端不收集（spec 2026-10-26） */ isTest: boolean; }
```

- [ ] **Step 4: persistence 改造**

建表语句（~L135）加列：

```sql
CREATE TABLE IF NOT EXISTS roster (
  student_id TEXT PRIMARY KEY,
  student_name TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

CREATE TABLE exec 块之后（`colsOf` 已定义于 ~L88）加迁移：

```ts
// 测试学生标记（spec 2026-10-26 §数据层）：老库补列；新库 CREATE 已带列，此检查幂等跳过
if (!colsOf("roster").includes("is_test")) {
  db.exec("ALTER TABLE roster ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0");
}
```

getRoster / getRosterEntry 改为映射（SQLite 返回 0/1，需转 boolean）：

```ts
getRoster() {
  const rows = db.prepare("SELECT student_id AS studentId, student_name AS studentName, is_test AS isTest FROM roster ORDER BY student_id").all() as Array<RosterEntry & { isTest: number }>;
  return rows.map((r) => ({ ...r, isTest: !!r.isTest }));
},
getRosterEntry(studentId) {
  const r = db.prepare("SELECT student_id AS studentId, student_name AS studentName, is_test AS isTest FROM roster WHERE student_id = ?").get(studentId) as (RosterEntry & { isTest: number }) | undefined;
  return r ? { ...r, isTest: !!r.isTest } : null;
},
```

Persistence 接口（~L62 updateRosterEntry 之后）加：

```ts
setRosterTest(studentId: string, isTest: boolean): boolean;
```

实现（updateRosterEntry 之后）：

```ts
setRosterTest(studentId, isTest) {
  return db.prepare("UPDATE roster SET is_test = ? WHERE student_id = ?").run(isTest ? 1 : 0, studentId).changes > 0;
},
```

- [ ] **Step 5: 适配两个 RosterEntry 构造点（类型收窄）**

`packages/server/src/controllers/rosterController.ts:11`：

```ts
if (m) entries.push({ studentId: m[1], studentName: m[2].trim(), isTest: false });
```

`packages/server/src/routes/roster.ts:57`：

```ts
if (deps.gitea) provisionEntries(deps.persistence, deps.gitea, [{ studentId, studentName, isTest: false }]);
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/testStudent.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/assignment.ts packages/server/src/persistence.ts packages/server/src/controllers/rosterController.ts packages/server/src/routes/roster.ts packages/server/src/__tests__/testStudent.test.ts
git commit -m "feat(roster): is_test 列迁移与 setRosterTest——测试学生数据层"
```

---

### Task 2: PATCH /api/roster/entry/:studentId 扩展 isTest

**Files:**
- Modify: `packages/server/src/routes/roster.ts:61-69`（PATCH 路由）
- Test: `packages/server/src/__tests__/testStudent.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `persistence.setRosterTest(studentId, isTest)`（Task 1）
- Produces: `PATCH body { studentName?, isTest? }` → `200 { ok, studentId, studentName, isTest }`（Task 5 前端调用）

- [ ] **Step 1: 追加失败测试**

`testStudent.test.ts` 顶部改导入并追加 describe（supertest + createApp，沿用 loginState.test.ts 的 makeApp 模式）：

```ts
import request from "supertest";
import { createApp } from "../index";

function makeApp() {
  const { app } = createApp({ dbPath: ":memory:", llmConfig: null, reviewConfig: null });
  return { app };
}

describe("PATCH /api/roster/entry/:studentId isTest 开关", () => {
  it("设为测试 → 读取为 true；取消 → false", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "9001 测试生\n9002 张三" }).expect(200);
    await request(app).patch("/api/roster/entry/9001").send({ isTest: true }).expect(200);
    let roster = (await request(app).get("/api/roster").expect(200)).body;
    expect(roster.find((e: { studentId: string }) => e.studentId === "9001").isTest).toBe(true);
    expect(roster.find((e: { studentId: string }) => e.studentId === "9002").isTest).toBe(false);
    await request(app).patch("/api/roster/entry/9001").send({ isTest: false }).expect(200);
    roster = (await request(app).get("/api/roster").expect(200)).body;
    expect(roster.find((e: { studentId: string }) => e.studentId === "9001").isTest).toBe(false);
  });

  it("改名与 isTest 可同传；非法学号 400；学号不存在 404；空 body 400", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "9001 测试生" }).expect(200);
    await request(app).patch("/api/roster/entry/9001").send({ studentName: "新名", isTest: true }).expect(200);
    const roster = (await request(app).get("/api/roster").expect(200)).body;
    expect(roster[0]).toMatchObject({ studentName: "新名", isTest: true });
    await request(app).patch("/api/roster/entry/bad%2Fid").send({ isTest: true }).expect(400);
    await request(app).patch("/api/roster/entry/ghost").send({ isTest: true }).expect(404);
    await request(app).patch("/api/roster/entry/9001").send({}).expect(400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/testStudent.test.ts`
Expected: 新 describe FAIL（现 PATCH 只接受 studentName，空 body 返回「姓名不能为空」400）

- [ ] **Step 3: 改 PATCH 路由**

替换 `routes/roster.ts` L61-69 整段：

```ts
// —— 单条更新：改姓名 与 设为/取消测试学生（可同传；学号是主键不可改，spec roster §1.1 / 2026-10-26）——
app.patch("/api/roster/entry/:studentId", (req, res) => {
  const studentId = (req.params.studentId ?? "").trim();
  if (!isValidStudentId(studentId)) return res.status(400).json({ error: "invalid studentId" });
  const hasName = typeof req.body?.studentName === "string" && req.body.studentName.trim() !== "";
  const hasTest = typeof req.body?.isTest === "boolean";
  if (!hasName && !hasTest) return res.status(400).json({ error: "缺少可更新字段" });
  if (!deps.persistence.getRosterEntry(studentId)) return res.status(404).json({ error: "该学号不在名册中" });
  if (hasName) {
    if (!deps.persistence.updateRosterEntry(studentId, req.body.studentName.trim())) return res.status(404).json({ error: "该学号不在名册中" });
    logEvent({ event: "api.roster_entry_renamed", level: "info", data: { studentId } });
  }
  if (hasTest) {
    if (!deps.persistence.setRosterTest(studentId, req.body.isTest)) return res.status(404).json({ error: "该学号不在名册中" });
    logEvent({ event: "api.roster_entry_test_toggled", level: "info", data: { studentId, isTest: req.body.isTest } });
    deps.onRosterChanged?.();   // 测试标记影响大屏排除与通过率分母，需即时刷新
  }
  const updated = deps.persistence.getRosterEntry(studentId)!;
  res.json({ ok: true, studentId, studentName: updated.studentName, isTest: updated.isTest });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/testStudent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/roster.ts packages/server/src/__tests__/testStudent.test.ts
git commit -m "feat(roster): PATCH entry 支持 isTest 开关"
```

---

### Task 3: 三个入口门禁（events 丢弃 / archive 400 / heartbeat 不记账）

**Files:**
- Modify: `packages/server/src/index.ts`（/api/events 校验块之后 ~L142、/api/heartbeat 校验之后 ~L218）
- Modify: `packages/server/src/routes/traceArchive.ts`（名册门禁之后 ~L41）
- Test: `packages/server/src/__tests__/testStudent.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `persistence.getRosterEntry(id)?.isTest`（Task 1）
- Produces: `/api/events` 对测试学号返回 `200 { ok: true, dropped: true }`；`/api/trace/archive` 返回 `400 { error: "student is test" }`；`/api/heartbeat` 返回 `200 { ok: true }` 不记账

- [ ] **Step 1: 追加失败测试**

```ts
describe("测试学号数据收集门禁", () => {
  async function setup(app: ReturnType<typeof createApp>["app"]) {
    await request(app).post("/api/roster").send({ text: "9001 测试生\n9002 张三" }).expect(200);
    await request(app).patch("/api/roster/entry/9001").send({ isTest: true }).expect(200);
  }

  it("/api/events：测试学号 200 静默丢弃（不入库、不进大屏、不点告警）；普通学号不受影响", async () => {
    const { app } = makeApp();
    await setup(app);
    await request(app).post("/api/events").send({
      id: "run:testdroptest0000000000000000001", ts: Date.now(), surface: "run", kind: "execution_error",
      student_id: "9001", student_name: "测试生", class_id: "3A",
      payload: { file: "l1/a.py", exit_code: 1, error_type: "NameError", error_message: "x" },
    }).expect(200, { ok: true, dropped: true });
    await request(app).post("/api/events").send({
      id: "run:testdroptest0000000000000000002", ts: Date.now(), surface: "run", kind: "execution_error",
      student_id: "9002", student_name: "张三", class_id: "3A",
      payload: { file: "l1/a.py", exit_code: 1, error_type: "NameError", error_message: "x" },
    }).expect(200, { ok: true, duplicated: false });
    const s = (await request(app).get("/api/summary").expect(200)).body;
    expect(s.students.some((x: { studentId: string }) => x.studentId === "9001")).toBe(false);   // 测试学号不出现
    expect(s.alerts.some((a: { studentId: string }) => a.studentId === "9001")).toBe(false);
    expect(s.alerts.some((a: { studentId: string }) => a.studentId === "9002")).toBe(true);      // 普通学号照常
  });

  it("/api/heartbeat：测试学号 200 但不记账（summary 不出现）", async () => {
    const { app } = makeApp();
    await setup(app);
    await request(app).post("/api/heartbeat").send({ student_id: "9001", student_name: "测试生", machine_id: "m1" }).expect(200);
    const s = (await request(app).get("/api/summary").expect(200)).body;
    expect(s.students.some((x: { studentId: string }) => x.studentId === "9001")).toBe(false);
  });

  it("/api/trace/archive：测试学号 400（客户端跳尾语义）；普通学号照常", async () => {
    const { app } = makeApp();
    await setup(app);
    await request(app).post("/api/trace/archive").send({
      student_id: "9001", student_name: "测试生", class_id: "3A", surface: "edit", date: "2026-10-26", events: [],
    }).expect(400, { error: "student is test" });
    await request(app).post("/api/trace/archive").send({
      student_id: "9002", student_name: "张三", class_id: "3A", surface: "edit", date: "2026-10-26", events: [],
    }).expect(200);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/testStudent.test.ts`
Expected: 新 describe 3 用例 FAIL（门禁不存在：events 正常入库、heartbeat 建档、archive 200）

- [ ] **Step 3: /api/events 门禁**

`index.ts` /api/events 内、studentId 格式校验块（`return res.status(400).json({ error: "student_id 非法" })`）之后、`logEvent({ event: "route.event_received" ... })` 之前插入：

```ts
// 测试学生门禁（spec 2026-10-26）：标记 is_test 的学号数据不收集——不入库、不进内存看板。
// 200 静默丢弃（勿用 400：测试学生持续产生 edit 事件，400 会刷爆 warn 日志；实时通道无重试）
if (persistence.getRosterEntry(ev.studentId)?.isTest) {
  logEvent({ event: "route.test_student_dropped", level: "debug", data: { eventId: ev.id, studentId: ev.studentId, surface: ev.surface } });
  return res.json({ ok: true, dropped: true });
}
```

- [ ] **Step 4: /api/heartbeat 门禁**

`index.ts` /api/heartbeat 内、参数校验 `return res.status(400)...` 之后插入：

```ts
// 测试学生门禁（spec 2026-10-26）：心跳不记账（不建机器会话）
if (persistence.getRosterEntry(studentId)?.isTest) {
  return res.json({ ok: true });
}
```

- [ ] **Step 5: 归档门禁**

`routes/traceArchive.ts` 花名册门禁块（`getRoster().length === 0` 分支的 `}` 之后、`NAME_PATTERN.test(classId)` 之前）插入：

```ts
// 测试学生门禁（spec 2026-10-26）：400 语义 = 客户端不重试、位点跳尾（与名册门禁一致），测试期间本地数据不上云
if (deps.persistence.getRosterEntry(studentId)?.isTest) {
  logEvent({ event: "archive.test_student_rejected", level: "info", data: { studentId } });
  return res.status(400).json({ error: "student is test" });
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/testStudent.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/index.ts packages/server/src/routes/traceArchive.ts packages/server/src/__tests__/testStudent.test.ts
git commit -m "feat(server): 测试学号数据收集门禁——events 丢弃/archive 400/心跳不记账"
```

---

### Task 4: buildSnapshot 三处排除

**Files:**
- Modify: `packages/server/src/index.ts`（buildSnapshot ~L59-80）
- Test: `packages/server/src/__tests__/testStudent.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `persistence.getRoster()` 返回含 isTest（Task 1）
- Produces: 快照 `students` 不含测试学号；`exerciseProgress[].total/passRate` 分母不含测试学生

- [ ] **Step 1: 追加失败测试**

```ts
describe("buildSnapshot 测试学生排除", () => {
  it("矩阵/花名册补空/通过率分母均排除测试学号", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "9001 测试生\n9002 张三" }).expect(200);
    await request(app).patch("/api/roster/entry/9001").send({ isTest: true }).expect(200);
    await request(app).post("/api/events").send({
      id: "run:testsnaptest00000000000000000001", ts: Date.now(), surface: "run", kind: "execution_error",
      student_id: "9002", student_name: "张三", class_id: "3A",
      payload: { file: "l1/a.py", exit_code: 1, error_type: "NameError", error_message: "x" },
    }).expect(200);
    const s = (await request(app).get("/api/summary").expect(200)).body;
    expect(s.students.map((x: { studentId: string }) => x.studentId)).toEqual(["9002"]);   // 矩阵只有普通学生
    expect(s.exerciseProgress[0]).toMatchObject({ total: 1, passRate: 0 });                // 分母 = 1（非测试名册人数）
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/testStudent.test.ts`
Expected: FAIL（`total: 2`——分母含测试学生；矩阵 ghosts 含 9001）

- [ ] **Step 3: 改 buildSnapshot**

`index.ts` buildSnapshot 中、`const records = stateManager.listRecords();` 起替换为（原 `getRoster()` 三次独立调用合并为一次局部变量）：

```ts
const roster = persistence.getRoster();
const testIds = new Set(roster.filter((e) => e.isTest).map((e) => e.studentId));
const records = stateManager.listRecords().filter((r) => !testIds.has(r.studentId));   // 防御：标记翻转前残留的内存记录
// 矩阵显示全班（spec 决策 #15）：花名册中无事件记录的学生补空记录（排除测试学生）
const seenIds = new Set(records.map((r) => r.studentId));
const rosterGhosts = roster
  .filter((e) => !seenIds.has(e.studentId) && !e.isTest)
  .map((e) => ({ ...同原实现... }));
```

`rosterTotal` 行改为：

```ts
const rosterTotal = roster.filter((e) => !e.isTest).length;   // 通过率分母：非测试花名册人数（spec 2026-10-26）
```

（ghosts 的 map 体内 `classId: records[0]?.classId ?? "default"` 等保持原样，仅 `machines: new Map()` 等字段照旧）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/testStudent.test.ts && pnpm --filter @classroom/server test`
Expected: testStudent 全 PASS；server 全套回归 PASS（dashboardV2 的 total 断言用普通名册，不受影响）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/index.ts packages/server/src/__tests__/testStudent.test.ts
git commit -m "feat(dashboard): 快照三处排除测试学生——记录/补空/通过率分母"
```

---

### Task 5: adminApi + RosterPanel 徽章与行开关

**Files:**
- Modify: `packages/dashboard/src/api/admin.ts`（adminApi 加 setRosterTest）
- Modify: `packages/dashboard/src/components/RosterPanel.vue`（toggleTest 函数、学号徽章、操作按钮、样式）
- Test: `packages/dashboard/src/__tests__/RosterPanel.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `PATCH /api/roster/entry/:studentId { isTest }`
- Produces: `adminApi.setRosterTest(studentId: string, isTest: boolean): Promise<{ ok: true; ... }>`

- [ ] **Step 1: 更新失败测试**

`RosterPanel.test.ts`：mock 增加 `setRosterTest: vi.fn(async () => ({ ok: true }))`；fixture 改为含 isTest：

```ts
const roster = [
  { studentId: "0001", studentName: "张三", isTest: true },
  { studentId: "0002", studentName: "李四", isTest: false },
];
```

追加用例（describe 内）：

```ts
it("测试徽章：isTest 行显示「测试」标记，普通行不显示", () => {
  const w = mountPanel();
  expect(w.find(".test-badge").text()).toBe("测试");
  expect(w.findAll(".test-badge")).toHaveLength(1);
});

it("行开关：未标记行显示「设为测试」→ 点击调 setRosterTest(id, true) + refreshed", async () => {
  const w = mountPanel();
  const btn = w.findAll("button.test-entry").find((b) => b.text() === "设为测试")!;
  await btn.trigger("click");
  await new Promise((r) => setTimeout(r, 0));
  expect(adminApi.setRosterTest).toHaveBeenCalledWith("0002", true);
  expect(w.emitted("refreshed")).toBeTruthy();
});

it("行开关：已标记行显示「取消测试」→ 点击调 setRosterTest(id, false)", async () => {
  const w = mountPanel();
  const btn = w.findAll("button.test-entry").find((b) => b.text() === "取消测试")!;
  await btn.trigger("click");
  await new Promise((r) => setTimeout(r, 0));
  expect(adminApi.setRosterTest).toHaveBeenCalledWith("0001", false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/dashboard exec vitest run src/__tests__/RosterPanel.test.ts`
Expected: FAIL（adminApi 无 setRosterTest；徽章/按钮不存在）

- [ ] **Step 3: adminApi 加方法**

`api/admin.ts` adminApi 对象内（renameRosterEntry 之后）：

```ts
  /** 设为/取消测试学生（大屏排除 + 服务端不收集，spec 2026-10-26） */
  setRosterTest: (studentId: string, isTest: boolean) =>
    send<{ ok: true; studentId: string; studentName: string; isTest: boolean }>(
      `/api/roster/entry/${encodeURIComponent(studentId)}`, "PATCH", { isTest },
    ),
```

- [ ] **Step 4: RosterPanel 改造**

script（removeEntry 之后）加：

```ts
// —— 行操作：设为/取消测试学生（大屏排除 + 服务端不收集，spec 2026-10-26）——
async function toggleTest(r: RosterEntry) {
  try {
    await adminApi.setRosterTest(r.studentId, !r.isTest);
    toast.success(r.isTest ? `已取消 ${r.studentId} 的测试标记` : `已将 ${r.studentId} 设为测试学生（大屏隐藏、服务端不收集）`);
    emit("refreshed");
  } catch (e) { toast.error(`操作失败：${errMsg(e)}`); }
}
```

template 学号列加徽章：

```html
<td class="sid">{{ r.studentId }}<span v-if="r.isTest" class="test-badge">测试</span></td>
```

操作列（移出按钮之前）加：

```html
<button class="test-entry" @click="toggleTest(r)">{{ r.isTest ? "取消测试" : "设为测试" }}</button>
```

style 加（沿用面板既有按钮样式变量）：

```css
.test-badge { display: inline-block; margin-left: 6px; padding: 1px 6px; font-size: 11px; border-radius: 8px; background: #fef3c7; color: #b45309; }
.test-entry { margin-right: 6px; }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @classroom/dashboard exec vitest run src/__tests__/RosterPanel.test.ts`
Expected: PASS（含既有用例回归）

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/api/admin.ts packages/dashboard/src/components/RosterPanel.vue packages/dashboard/src/__tests__/RosterPanel.test.ts
git commit -m "feat(dashboard): 花名册面板测试学生开关与徽章"
```

---

### Task 6: 全量回归

**Files:** 无新改动

- [ ] **Step 1: 三包全量测试**

Run: `pnpm test`（仓库根，递归 shared/server/dashboard）
Expected: 全 PASS。重点回归：dashboardV2.test.ts（rosterTotal 相关断言）、routes.test.ts（roster CRUD 既有用例——旧 PATCH 请求只带 studentName 仍须通过）

- [ ] **Step 2: 提交状态检查**

Run: `git status --short`
Expected: 干净（全部已提交）

---

## Self-Review 记录

- **Spec 覆盖**：语义表 5 行 → Task 1（数据层）/Task 2（开关入口）/Task 3（events/archive/heartbeat）/Task 4（大屏三处）；评审链路不拦 = 无需改动（自然满足）；边界 1/2（导入重置、软删重置）= replaceRoster/upsert/delete 不带 is_test 写入即默认 0，自然满足，无需代码 ✓
- **占位符**：Task 4 Step 3 中 ghosts map 体用「同原实现」标注——执行者就地保留原字段（machines: new Map() 等），仅外层加过滤，属既有代码原样引用，非待定项 ✓
- **类型一致性**：`setRosterTest(studentId: string, isTest: boolean): boolean` 在 Task 1 定义、Task 2 路由与 Task 5 adminApi 按此签名调用 ✓；`isTest: boolean` 在 RosterEntry/persistence 映射/响应体三处一致 ✓
