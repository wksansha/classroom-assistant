# 实时助教大屏 V2 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec 重设计实时助教大屏：按天数据窗口、题目全集矩阵化进度（Gitea 文件树 × 花名册，全班通过率人数统计）、作业完成度堆叠柱等四图表、idle 第四态、布局 D（左右两栏 + 底部图表行）。

**Architecture:** 服务端新增 dayStart（按天窗口）、ExerciseCatalog（只读列 Gitea main 分支文件树）、ExerciseProgress（题目×学生矩阵追踪器）、trend（5 分钟分桶）四个可注入模块；评审结果落 SQLite `review_results` 支撑重启全量回放；快照 `TeacherSnapshot` 向后兼容追加 exerciseProgress/trend/stats；前端重构为 StatusBar + StudentMatrix + AIPanel/ExerciseProgress 右栏 + ChartsRow 四卡（完成度堆叠柱打头，管理页复用 ExerciseProgress 作课后查看视图）。

**Tech Stack:** Express 5 + better-sqlite3 + vitest（server）；Vue 3 + Pinia + chart.js + @vue/test-utils（dashboard）；共享类型在 packages/shared。

**Spec:** docs/superpowers/specs/2026-10-21-dashboard-v2-design.md（含 2026-10-22 修订：砍课堂窗口改按天、题目全集矩阵化；本计划从 spec 论证，执行者须同时读两者）

## Global Constraints

- 学生插件（vscode-pylearner）零改动；`#/admin` 花名册功能零改动；归档/评审链路既有协议不动
- **分两期实现（spec 决策 #17）**：第一期无四图表（作业完成度/错误分布/状态饼/课堂节奏）——App 图表区不渲染，旧 ErrorAggPanel 一期下线；ChartsRow 二期实现（Task 16）
- **决策 #18（2026-10-23）**：题目面板**当天涌现**——只展示当天有 run/评审事件的题（filePath 直出），每题统计为**当天人数**（passed/stuck/unreviewed）；重启仅回放当天 review_results；**ExerciseCatalog/题目目录服务取消（Task 3 废弃，编号保留缺口）**；顶栏无「已通过评审」统计
- 学生矩阵显示花名册全班：无事件学生补空记录（lastActivityAt=0 → **online=false**）；**决策 #19**：`StatusColor` 保持三值（green/yellow/red），未在线不占状态——`StudentState` 新增独立字段 `online: boolean`，矩阵瓦片变暗+灰点标识
- server 与 dashboard 同仓同部署一起上线，无跨端兼容垫片
- 评审结果 pass/fail/unreviewed 三态均落 `review_results`（题目进度事实源；**缓存表**「unreviewed 不缓存」约束不变）
- 评审结果写入失败不阻塞评审响应（try/catch + `review.result_persist_failed` 日志）
- 窗口边界：恰好等于窗口起点的事件/活动计入（`ts >= windowStart`）
- **双窗口口径（spec §4.1，决策 #18 后无累计域）**：大屏全部数据（状态/告警/聚合/趋势/抽屉/统计条/题目涌现）= 当天 00:00 起
- **无课堂会话机制**：没有 `/api/class/start` 路由、没有 classSession、没有 AdminView 课堂控制卡（2026-10-22 拍板砍掉）
- `dayStart` 用服务器本地时区 `setHours(0,0,0,0)`；部署要求 `TZ=Asia/Shanghai`（docker compose 层面，不在本计划代码内处理）
- edit 事件不改题目进度；不触发常规快照推送，仅跨越「无活动 ↔ 有活动」边界（边沿触发）时推
- 评审 unreviewed（无有效结论）→ 生成「待评审」格；pass/fail 强信号不覆盖；run 失败置 fail（spec 决策 #14）
- 题目涌现按三态总和降序（最活跃在前），**输出不含学生名单**（2026-10-22 拍板）
- 测试命令：server `pnpm --filter @classroom/server exec vitest run <file>`；dashboard `pnpm --filter @classroom/dashboard exec vitest run <file>`；全量 `pnpm -r test`
- 常量锚点：桶宽 5 分钟（`5 * 60_000`）；trend 内存桶 24h 修剪

---

### Task 1: shared DTO V2 + dashboard 测试夹具同步

**Files:**
- Modify: `packages/shared/src/dto.ts`
- Modify: `packages/dashboard/src/__tests__/helpers.ts`

**Interfaces:**
- Produces（后续所有任务依赖的共享类型）:
  - `type StatusColor = "green" | "yellow" | "red"`（**保持三值不变**，决策 #19）
  - `StudentState` 新增 `online: boolean`（当天无活动=false，决策 #19）
  - `type ExerciseStatus = "pass" | "fail" | "unreviewed"`（涌现格子三态，spec 决策 #14/#18）
  - `interface ExerciseProgressItem { id: string; displayName: string; isProject: boolean; passed: number; stuck: number; unreviewed: number; total: number; passRate: number }`（三态为**当天人数**；total=花名册人数、passRate=passed/total 由装配层注入——决策 #18/#20；无学生名单）
  - `interface TrendBucket { tStart: number; runs: number; errors: number }`
  - `interface ClassStats { online: number; total: number; needHelp: number; runs: number }`（无 passedReview，决策 #18）
  - `TeacherSnapshot` 追加字段 `exerciseProgress` / `trend` / `stats`（**无** classSession）

- [ ] **Step 1: 修改 `packages/shared/src/dto.ts`**

`StatusColor` **保持三值不动**（删除原计划中的扩四值改动）。`StudentState` 接口追加 `online` 字段（`recentErrors` 之前）：

```ts
export interface StudentState {
  studentId: string;
  studentName: string;
  status: StatusColor;
  /** 未在线标识（决策 #19）：当天无任何活动 = false，矩阵瓦片变暗+灰点（不占状态） */
  online: boolean;
  priorityScore: number;
  lastActivityAt: number | null;
  lastErrorAt: number | null;
  errorCountTotal: number;
  /** 最近 3 条错误，新的在前（矩阵悬停用） */
  recentErrors: RecentError[];
}
```

在 `SuggestionItem` 接口之后、`TeacherSnapshot` 之前添加：

```ts
/** 题目涌现格子的三态（spec 决策 #14/#18）：格子因评审/run 事件而生，无"未开始"预置。
 * 仅用于服务端内部计数，快照不输出学生名单（2026-10-22 拍板） */
export type ExerciseStatus = "pass" | "fail" | "unreviewed";

export interface ExerciseProgressItem {
  /** 文件路径（当天涌现，决策 #18） */
  id: string;
  /** 文件名（basename，兼容 Windows 反斜杠路径） */
  displayName: string;
  isProject: boolean;
  /** 均为当天人数 */
  passed: number;
  stuck: number;
  unreviewed: number;
  /** 班级总人数（花名册，决策 #20；装配层注入） */
  total: number;
  /** passed/total（决策 #20；装配层注入） */
  passRate: number;
}

export interface TrendBucket {
  /** 桶起点（epoch ms），桶宽 5 分钟 */
  tStart: number;
  runs: number;
  errors: number;
}

/** 顶栏统计条预聚合（spec §3①；无「已通过评审」，决策 #18） */
export interface ClassStats {
  /** 当天有活动的学生数（非 idle） */
  online: number;
  /** 本节课出现过的学生总数 */
  total: number;
  /** 红色状态学生数 */
  needHelp: number;
  /** 当天 run 成功总次数 */
  runs: number;
}
```

`TeacherSnapshot` 改为（保留原有 alerts/alertSummary 字段，向后兼容；**不新增** classSession）：

```ts
export interface TeacherSnapshot {
  ts: number;
  classId: string;
  students: StudentState[];
  /** ≤5，score 降序 */
  alerts: AlertItem[];
  /** "其余 N 人正常" */
  alertSummary: string;
  /** 按 subtype 分组，count 降序 */
  aggregates: AggItem[];
  suggestions: SuggestionItem[];
  /** 通过率升序全量（作业累计域，spec §5.3） */
  exerciseProgress: ExerciseProgressItem[];
  /** 当天全量桶，tStart 升序 */
  trend: TrendBucket[];
  stats: ClassStats;
}
```

- [ ] **Step 2: 修改 `packages/dashboard/src/__tests__/helpers.ts` 的 makeSnapshot**

```ts
export function makeSnapshot(overrides: Partial<TeacherSnapshot> = {}): TeacherSnapshot {
  return {
    ts: 1, classId: "3A", students: [], alerts: [],
    alertSummary: "其余 0 人正常", aggregates: [], suggestions: [],
    exerciseProgress: [], trend: [],
    stats: { online: 0, total: 0, needHelp: 0, runs: 0 },
    ...overrides,
  };
}
```

- [ ] **Step 3: 验证编译与既有测试**

Run: `pnpm --filter @classroom/shared build && pnpm --filter @classroom/dashboard exec vitest run`
Expected: shared 编译通过；dashboard 既有测试全部 PASS（运行时无组件读取新字段，不破坏现状）

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/dto.ts packages/dashboard/src/__tests__/helpers.ts
git commit -m "feat(shared): TeacherSnapshot V2 矩阵化进度字段与 idle 第四态类型（dashboard-v2 Task 1）"
```

---

### Task 2: classDay 模块（按天窗口起点）

**Files:**
- Create: `packages/server/src/classDay.ts`
- Test: `packages/server/src/__tests__/classDay.test.ts`（新建）

**Interfaces:**
- Produces: `dayStart(now: number): number`（当天本地 00:00 的 epoch ms）

- [ ] **Step 1: 写失败测试 `packages/server/src/__tests__/classDay.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { dayStart } from "../classDay";

describe("dayStart（按天窗口起点，spec dashboard-v2 §4）", () => {
  it("任意时刻归到当天本地 00:00", () => {
    const now = new Date();
    now.setHours(15, 30, 45, 123);
    const expected = new Date(now);
    expected.setHours(0, 0, 0, 0);
    expect(dayStart(now.getTime())).toBe(expected.getTime());
  });
  it("跨午夜：00:00 前一毫秒归属前一天", () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const before = today.getTime() - 1;
    const prevDay = new Date(before);
    prevDay.setHours(0, 0, 0, 0);
    expect(dayStart(before)).toBe(prevDay.getTime());
    expect(dayStart(before)).toBeLessThan(today.getTime());
  });
  it("恰好 00:00:00.000 计入当天", () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    expect(dayStart(today.getTime())).toBe(today.getTime());
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/classDay.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `packages/server/src/classDay.ts`**

```ts
/** 当天窗口起点：服务器本地时区 00:00（spec dashboard-v2 §4）。
 * 部署要求 TZ=Asia/Shanghai——UTC 服务器上北京时间 16-24 点的课会被归到"昨天" */
export function dayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/classDay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/classDay.ts packages/server/src/__tests__/classDay.test.ts
git commit -m "feat(server): dayStart 按天窗口起点（dashboard-v2 Task 2）"
```

---

### Task 3:【已取消】Gitea 题目目录服务

> **决策 #18（2026-10-23）**：题目面板改当天涌现口径（只展示当天有 run/评审事件的题），不再需要题目全集——本任务整段废弃，实施时**直接跳过**；Task 7 tracker 无 catalog 依赖（构造无参），Task 9 装配无 Gitea 列树。编号保留缺口以维持后续任务交叉引用稳定。

---

### Task 4: aggregator 窗口参数化 + idle 第四态

**Files:**
- Modify: `packages/server/src/aggregator.ts`
- Modify: `packages/server/src/__tests__/aggregator-status.test.ts`
- Modify: `packages/server/src/__tests__/aggregator-snapshot.test.ts`

**Interfaces:**
- Consumes: 调用方（Task 9 的 index.ts）传 `windowStart = dayStart(now)`；aggregator 本身保持纯函数
- Produces（签名变更）:
  - `computeStatus(r: StudentRecord, now: number, windowStart: number): StatusColor`
  - `computeScore(r: StudentRecord, now: number, windowStart: number): number`
  - `Aggregator.recompute(records: StudentRecord[], now: number, windowStart: number): Omit<TeacherSnapshot, "ts" | "classId">`

- [ ] **Step 1: 修改 `packages/server/src/aggregator.ts`**

删除文件头部的 `CLASS_WINDOW_MS` 常量与旧 `isWithinClassWindow(ts, now)` 函数，替换为：

```ts
/** 事件是否落在当前数据窗口内（spec dashboard-v2 §4）：窗口起点（含）之后的事件计入 */
function isWithinClassWindow(ts: number, windowStart: number): boolean {
  return ts >= windowStart;
}
```

`computeStatus` **保持三值**（决策 #19 删除 idle 分支）：

```ts
export function computeStatus(r: StudentRecord, now: number, windowStart: number): StatusColor {
  const score = computeScore(r, now, windowStart);
  if (score >= 40) return "red";
  if (score > 0) return "yellow";
  return "green";
}
```

（未在线学生不参与状态——`lastActivityAt < windowStart` 的学生 lastErrorAt 也必然在窗口外 → score 0 → green；未在线用独立字段表达，见下。）

`recompute` 的 students 输出追加 `online` 字段（决策 #19）：

```ts
      const students: StudentState[] = records.map((r) => ({
        studentId: r.studentId, studentName: r.studentName,
        status: computeStatus(r, now, windowStart),
        online: r.lastActivityAt >= windowStart,   // 未在线标识：当天无活动 = false（变暗+灰点，不占状态）
        priorityScore: computeScore(r, now, windowStart),
        lastActivityAt: r.lastActivityAt, lastErrorAt: r.lastErrorAt,
        errorCountTotal: errors.length, recentErrors,
      }));
```

```ts
export function computeScore(r: StudentRecord, now: number, windowStart: number): number {
  if (r.lastErrorAt === null) return 0;
  if (!isUnresolved(r)) return 0;
  if (!isWithinClassWindow(r.lastErrorAt, windowStart)) return 0;
  const repeat = maxSubtypeRepeat(r.events, now);
  let score = 10 + repeat * 10;
  if (r.consecutiveErrors >= 5) score += 30;
  return score;
}
```

`Aggregator` 接口与 `recompute` 签名加 `windowStart`，并把函数体内**全部 6 处** `isWithinClassWindow(x, now)` 调用改为 `isWithinClassWindow(x, windowStart)`（students errors 过滤、alerts lastErr、聚合 groups 循环、suggestions errorStudents、suggestions stuck、computeScore 内部 1 处），`computeStatus`/`computeScore` 调用处传入 `windowStart`：

```ts
export interface Aggregator {
  recompute(records: StudentRecord[], now: number, windowStart: number): Omit<TeacherSnapshot, "ts" | "classId">;
  ack(id: string): void;
}
```

- [ ] **Step 2: 更新 `aggregator-status.test.ts`**

文件头部加 `const WIN = new Date(NOW); WIN.setHours(0, 0, 0, 0); const WIN_START = WIN.getTime();`（当天窗口起点），所有 `computeStatus(r, NOW)` → `computeStatus(r, NOW, WIN_START)`、`computeScore(r, NOW)` → `computeScore(r, NOW, WIN_START)`。

「报错超过 120 分钟」用例改为窗口外构造（**不要用 `NOW - 121 * MIN`**：按天窗口下"几分钟前"是否在窗口外取决于服务器时区，用 `WIN_START - 60_000` 构造才时区无关）：

```ts
  it("报错在窗口外（昨天）→ 分数清 0，状态回 green（未在线不占状态，决策 #19）", () => {
    const r = record({
      events: [err(WIN_START - 60_000, "缺少冒号")],
      lastActivityAt: WIN_START - 60_000, lastErrorAt: WIN_START - 60_000,
      consecutiveErrors: 1,
    });
    expect(computeScore(r, NOW, WIN_START)).toBe(0);
    expect(computeStatus(r, NOW, WIN_START)).toBe("green");
  });
```

（其余既有用例均以 NOW 为锚点、NOW 取当天中午以后，任何时区下都在当天窗口内，期望值不变。）

追加 online 用例（决策 #19，StatusColor 保持三值）：

```ts
describe("online 未在线标识（spec 决策 #19）", () => {
  it("lastActivityAt 早于当天起点 → 状态仍按分数判（无错=green），未在线由 online 字段表达", () => {
    const r = record({ events: [], lastActivityAt: WIN_START - 1 });
    expect(computeStatus(r, NOW, WIN_START)).toBe("green");
  });
  it("恰好等于当天起点的活动计入 → green", () => {
    const r = record({ events: [], lastActivityAt: WIN_START });
    expect(computeStatus(r, NOW, WIN_START)).toBe("green");
  });
  it("有活动但有未解决错误 → 仍按分数判红黄", () => {
    const r = record({
      events: [err(NOW - MIN, "缺少冒号")],
      lastActivityAt: NOW - MIN, lastErrorAt: NOW - MIN, consecutiveErrors: 3,
    });
    expect(computeStatus(r, NOW, WIN_START)).toBe("red");
  });
});
```

- [ ] **Step 3: 更新 `aggregator-snapshot.test.ts`**

头部加与上同款的 `WIN_START` 常量，全部 5 处 `recompute(recs, NOW)` → `recompute(recs, NOW, WIN_START)`（含 `agg.recompute(recs, NOW)` 的 ack 用例）。

- [ ] **Step 4: 运行 server 测试**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/aggregator-status.test.ts src/__tests__/aggregator-snapshot.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/aggregator.ts packages/server/src/__tests__/aggregator-status.test.ts packages/server/src/__tests__/aggregator-snapshot.test.ts
git commit -m "feat(server): aggregator 按天窗口参数化与 idle 第四态判定（dashboard-v2 Task 4）"
```

---

### Task 5: stateManager.touchActivity（edit 活动信号）

**Files:**
- Modify: `packages/server/src/stateManager.ts`
- Test: `packages/server/src/__tests__/stateManager.test.ts`

**Interfaces:**
- Produces: `StateManager.touchActivity(studentId: string, studentName: string, classId: string, ts: number): number | null`（返回更新前 lastActivityAt；新建档返回 null）

- [ ] **Step 1: 在 `stateManager.test.ts` 追加失败测试**

```ts
describe("touchActivity（edit 活动信号，spec dashboard-v2 §5.5）", () => {
  it("新学生建档（不产事件）返回 null；已有学生返回旧值且取更大值", () => {
    const sm = createStateManager();
    expect(sm.touchActivity("stu001", "张三", "3A", 1000)).toBeNull();
    const r = sm.listRecords()[0];
    expect(r.lastActivityAt).toBe(1000);
    expect(r.events).toHaveLength(0);
    expect(sm.touchActivity("stu001", "张三", "3A", 500)).toBe(1000); // 不回退
    expect(sm.listRecords()[0].lastActivityAt).toBe(1000);
    expect(sm.touchActivity("stu001", "张三", "3A", 2000)).toBe(1000);
    expect(sm.listRecords()[0].lastActivityAt).toBe(2000);
  });
  it("不影响错误计数与事件列表", () => {
    const sm = createStateManager();
    sm.apply(errorEvent("stu001", 1000), exp);
    sm.touchActivity("stu001", "张三", "3A", 1500);
    const r = sm.listRecords()[0];
    expect(r.consecutiveErrors).toBe(1);
    expect(r.events).toHaveLength(1);
    expect(r.lastErrorAt).toBe(1000);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/stateManager.test.ts`
Expected: FAIL（touchActivity 不存在）

- [ ] **Step 3: 实现**

`StateManager` 接口追加方法声明；实现放在 `apply` 之后：

```ts
export interface StateManager {
  apply(ev: NormalizedEvent, explanation: Explanation | null, opts?: ApplyOptions): void;
  /** edit 活动信号（spec dashboard-v2 §5.5）：仅推进 lastActivityAt（取更大值），
   * 不入事件列表、不解释。返回更新前的 lastActivityAt；新建档返回 null（此前无记录） */
  touchActivity(studentId: string, studentName: string, classId: string, ts: number): number | null;
  listRecords(): StudentRecord[];
  getStudentDetail(id: string): { /* 现状不变 */ } | null;
}
```

```ts
    touchActivity(studentId, studentName, classId, ts) {
      const r = records.get(studentId);
      if (!r) {
        records.set(studentId, {
          studentId, studentName, classId, events: [],
          lastActivityAt: ts, lastErrorAt: null, lastResolvedAt: null, consecutiveErrors: 0,
        });
        logEvent({ event: "state.touch_new_record", level: "debug", data: { studentId, ts } });
        return null;
      }
      const prev = r.lastActivityAt;
      r.lastActivityAt = Math.max(r.lastActivityAt, ts);
      return prev;
    },
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/stateManager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/stateManager.ts packages/server/src/__tests__/stateManager.test.ts
git commit -m "feat(server): stateManager.touchActivity 轻量活动信号（dashboard-v2 Task 5）"
```

---

### Task 6: persistence review_results 表与预热查询

**Files:**
- Modify: `packages/server/src/persistence.ts`
- Test: `packages/server/src/__tests__/reviewResults.test.ts`（新建）

**Interfaces:**
- Produces（Persistence 新增三个方法）:
  - `saveReviewResult(row: { studentId: string; classId: string | null; filePath: string; status: "pass" | "fail" | "unreviewed"; reason: string | null; ts: number }): void`（三态均落行——本表是进度事实源；缓存表 unreviewed 不缓存的约束不受影响）
  - `getReviewResultsSince(windowStartMs: number): { studentId: string; studentName: string; filePath: string; status: "pass" | "fail" | "unreviewed"; ts: number }[]`（ts 升序；studentName LEFT JOIN roster，缺失回退 studentId；传 0 = 全量回放）
  - `getRunEventsSince(windowStartMs: number): { ts: number; success: boolean }[]`（trace_events surface='run'，kind 映射成败；ts 升序）

- [ ] **Step 1: 写失败测试 `packages/server/src/__tests__/reviewResults.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";

describe("review_results 与预热查询（spec dashboard-v2 §5.2/§5.4）", () => {
  it("saveReviewResult 三态落行；getReviewResultsSince 窗口过滤 + 升序 + 名册姓名回填", () => {
    const p = createPersistence(":memory:");
    p.upsertRosterEntry("s1", "张三");
    p.saveReviewResult({ studentId: "s1", classId: null, filePath: "l1/a.py", status: "fail", reason: "死循环", ts: 1000 });
    p.saveReviewResult({ studentId: "s2", classId: null, filePath: "l1/a.py", status: "unreviewed", reason: "评审不可用", ts: 1500 });
    p.saveReviewResult({ studentId: "s3", classId: null, filePath: "l1/a.py", status: "pass", reason: "通过", ts: 2000 });
    expect(p.getReviewResultsSince(0)).toEqual([
      { studentId: "s1", studentName: "张三", filePath: "l1/a.py", status: "fail", ts: 1000 },
      { studentId: "s2", studentName: "s2", filePath: "l1/a.py", status: "unreviewed", ts: 1500 },
      { studentId: "s3", studentName: "s3", filePath: "l1/a.py", status: "pass", ts: 2000 },
    ]);
    expect(p.getReviewResultsSince(1600)).toEqual([
      { studentId: "s3", studentName: "s3", filePath: "l1/a.py", status: "pass", ts: 2000 },
    ]);
  });

  it("getRunEventsSince：surface=run 且 kind 区分成败；edit/chat 不入", () => {
    const p = createPersistence(":memory:");
    const common = { studentName: "张三", classId: "3A", sessionId: null as string | null, payload: "{}", date: "2026-10-22" };
    p.insertTraceEvents([
      { eventId: "run:a", studentId: "s1", ...common, surface: "run", kind: "execution_success", ts: "2026-10-22T01:00:00.000Z" },
      { eventId: "run:b", studentId: "s1", ...common, surface: "run", kind: "execution_error", ts: "2026-10-22T01:05:00.000Z" },
      { eventId: "edit:c", studentId: "s1", ...common, surface: "edit", kind: "code_change", ts: "2026-10-22T01:06:00.000Z" },
    ]);
    expect(p.getRunEventsSince(Date.parse("2026-10-22T00:00:00.000Z"))).toEqual([
      { ts: Date.parse("2026-10-22T01:00:00.000Z"), success: true },
      { ts: Date.parse("2026-10-22T01:05:00.000Z"), success: false },
    ]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/reviewResults.test.ts`
Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现**

`persistence.ts` 的 `db.exec` schema 末尾（student_tokens 之后）追加：

```sql
    CREATE TABLE IF NOT EXISTS review_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      class_id TEXT,
      file_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pass','fail','unreviewed')),
      reason TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_results_path_ts ON review_results(file_path, ts);
```

`Persistence` 接口追加（放在「评审缓存」区块之后）：

```ts
  // —— 评审结果持久化（题目进度/重启回放，spec dashboard-v2 §5.2；三态事实表，缓存表约束不变）——
  saveReviewResult(row: { studentId: string; classId: string | null; filePath: string; status: "pass" | "fail" | "unreviewed"; reason: string | null; ts: number }): void;
  getReviewResultsSince(windowStartMs: number): { studentId: string; studentName: string; filePath: string; status: "pass" | "fail" | "unreviewed"; ts: number }[];
  getRunEventsSince(windowStartMs: number): { ts: number; success: boolean }[];
```

实现（放在 saveReviewCache 之后）：

```ts
    saveReviewResult(row) {
      db.prepare(`INSERT INTO review_results (student_id, class_id, file_path, status, reason, ts)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(row.studentId, row.classId, row.filePath, row.status, row.reason, row.ts);
    },
    getReviewResultsSince(windowStartMs) {
      return db.prepare(`SELECT r.student_id AS studentId, COALESCE(ro.student_name, r.student_id) AS studentName,
          r.file_path AS filePath, r.status, r.ts
        FROM review_results r LEFT JOIN roster ro ON ro.student_id = r.student_id
        WHERE r.ts >= ? ORDER BY r.ts`).all(windowStartMs) as
        { studentId: string; studentName: string; filePath: string; status: "pass" | "fail" | "unreviewed"; ts: number }[];
    },
    getRunEventsSince(windowStartMs) {
      // trace_events.ts 为 ISO-8601 文本（字典序即时间序），窗口起点转 ISO 比较
      const iso = new Date(windowStartMs).toISOString();
      const rows = db.prepare("SELECT ts, kind FROM trace_events WHERE surface = 'run' AND ts >= ? ORDER BY ts")
        .all(iso) as { ts: string; kind: string }[];
      return rows.map((r) => ({ ts: Date.parse(r.ts), success: r.kind === "execution_success" }));
    },
```

- [ ] **Step 4: 运行确认通过 + 全量 persistence 测试无回归**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/reviewResults.test.ts src/__tests__/persistenceV2.test.ts src/__tests__/persistence.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/persistence.ts packages/server/src/__tests__/reviewResults.test.ts
git commit -m "feat(server): review_results 持久化与 run 事件预热查询（dashboard-v2 Task 6）"
```

---

### Task 7: ExerciseProgress 当天涌现追踪器

**Files:**
- Create: `packages/server/src/exerciseProgress.ts`
- Test: `packages/server/src/__tests__/exerciseProgress.test.ts`（新建）

**Interfaces:**
- Consumes: shared 的 `ExerciseProgressItem`（无 catalog 依赖——决策 #18 涌现口径，构造无参）
- Produces:
  - `createExerciseProgressTracker(): ExerciseProgressTracker`
  - `ExerciseProgressTracker = { applyReview(studentId, studentName, filePath, status: "pass" | "fail", ts: number): void; applyUnreviewed(studentId, studentName, filePath, ts: number): void; applyRunFailure(studentId, studentName, filePath, ts: number): void; warmUpFromReviews(rows: { studentId: string; studentName: string; filePath: string; status: "pass" | "fail" | "unreviewed"; ts: number }[]): void; list(dayStartMs: number): ExerciseProgressItem[] }`

- [ ] **Step 1: 写失败测试 `packages/server/src/__tests__/exerciseProgress.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { createExerciseProgressTracker } from "../exerciseProgress";

const NOW = Date.parse("2026-10-23T08:00:00.000Z");
const TODAY_START = NOW - 8 * 60 * 60_000;   // 模拟当天起点（昨天 = 更早）

describe("ExerciseProgressTracker（当天涌现，spec dashboard-v2 §5.3 / 决策 #18）", () => {
  it("事件生格：评审 fail → stuck=1；pass 翻转 latest", () => {
    const t = createExerciseProgressTracker();
    t.applyReview("s1", "张三", "l1/a.py", "fail", NOW);
    expect(t.list(TODAY_START)).toEqual([
      { id: "l1/a.py", displayName: "a.py", isProject: false, passed: 0, stuck: 1, unreviewed: 0 },
    ]);
    t.applyReview("s1", "张三", "l1/a.py", "pass", NOW + 1000);
    expect(t.list(TODAY_START)).toEqual([
      { id: "l1/a.py", displayName: "a.py", isProject: false, passed: 1, stuck: 0, unreviewed: 0 },
    ]);
  });

  it("unreviewed → 待评审；pass/fail 强信号不覆盖", () => {
    const t = createExerciseProgressTracker();
    t.applyUnreviewed("s1", "张三", "l1/a.py", NOW);
    expect(t.list(TODAY_START)[0]).toMatchObject({ unreviewed: 1 });
    t.applyReview("s2", "李四", "l1/a.py", "pass", NOW);
    t.applyUnreviewed("s2", "李四", "l1/a.py", NOW + 1000);   // pass 不覆盖
    t.applyReview("s3", "王五", "l1/a.py", "fail", NOW);
    t.applyUnreviewed("s3", "王五", "l1/a.py", NOW + 1000);   // fail 不覆盖
    expect(t.list(TODAY_START)[0]).toMatchObject({ passed: 1, stuck: 1, unreviewed: 1 });
  });

  it("run 失败 → fail（强负面信号）", () => {
    const t = createExerciseProgressTracker();
    t.applyRunFailure("s1", "张三", "l1/a.py", NOW);
    expect(t.list(TODAY_START)[0]).toMatchObject({ stuck: 1 });
  });

  it("list 当天过滤：昨天格子的学生不计、昨天活跃的题不出现", () => {
    const t = createExerciseProgressTracker();
    t.applyReview("s1", "张三", "l1/a.py", "fail", TODAY_START - 1000);   // 昨天
    t.applyReview("s2", "李四", "l1/b.py", "fail", NOW);                  // 今天
    expect(t.list(TODAY_START)).toEqual([
      { id: "l1/b.py", displayName: "b.py", isProject: false, passed: 0, stuck: 1, unreviewed: 0 },
    ]);
    // 同题：昨天 fail 的 s1 不计入今天统计
    t.applyReview("s3", "王五", "l1/a.py", "pass", NOW + 2000);
    expect(t.list(TODAY_START).find((i) => i.id === "l1/a.py")).toMatchObject({ passed: 1, stuck: 0 });
  });

  it("排序：三态总和降序（最活跃在前）", () => {
    const t = createExerciseProgressTracker();
    t.applyReview("s1", "张三", "l1/a.py", "pass", NOW);
    t.applyReview("s2", "李四", "l2/b.py", "pass", NOW);
    t.applyReview("s3", "王五", "l2/b.py", "pass", NOW);
    const items = t.list(TODAY_START);
    expect(items[0].id).toBe("l2/b.py");   // 2 人 > 1 人
  });

  it("Windows 反斜杠路径取 basename；输出不含学生名单", () => {
    const t = createExerciseProgressTracker();
    t.applyReview("s1", "张三", "lesson5\\weather_app.py", "pass", NOW);
    const item = t.list(TODAY_START)[0];
    expect(item.displayName).toBe("weather_app.py");
    expect(item).not.toHaveProperty("students");
    expect(Object.keys(item).sort()).toEqual(["displayName", "id", "isProject", "passed", "stuck", "unreviewed"]);
  });

  it("warmUpFromReviews：仅回放当天行（unreviewed 不覆盖 pass/fail）", () => {
    const t = createExerciseProgressTracker();
    t.warmUpFromReviews([
      { studentId: "s1", studentName: "张三", filePath: "l1/a.py", status: "unreviewed", ts: TODAY_START - 500 },   // 昨天 → 忽略
      { studentId: "s2", studentName: "李四", filePath: "l1/a.py", status: "pass", ts: TODAY_START + 100 },
      { studentId: "s2", studentName: "李四", filePath: "l1/a.py", status: "unreviewed", ts: TODAY_START + 200 },   // 不覆盖 pass
      { studentId: "s3", studentName: "王五", filePath: "l1/b.py", status: "unreviewed", ts: TODAY_START + 300 },
    ]);
    const items = t.list(TODAY_START);
    expect(items.find((i) => i.id === "l1/a.py")).toMatchObject({ passed: 1, unreviewed: 0 });
    expect(items.find((i) => i.id === "l1/b.py")).toMatchObject({ unreviewed: 1 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/exerciseProgress.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `packages/server/src/exerciseProgress.ts`**

```ts
import type { ExerciseProgressItem, ExerciseStatus } from "@classroom/shared";

interface Entry {
  studentName: string;
  latest: ExerciseStatus;
  /** 最近一次事件时间（epoch ms），list 当天过滤用 */
  lastTs: number;
}

export interface ReviewResultRow {
  studentId: string;
  studentName: string;
  filePath: string;
  status: "pass" | "fail" | "unreviewed";
  ts: number;
}

export interface ExerciseProgressTracker {
  /** 评审结果驱动：fail → latest=fail；pass → latest=pass */
  applyReview(studentId: string, studentName: string, filePath: string, status: "pass" | "fail", ts: number): void;
  /** 评审请求无有效结论（LLM 未配置/挂/mock 兜底/不确定，spec 决策 #14）：latest=unreviewed；pass/fail 强信号不覆盖 */
  applyUnreviewed(studentId: string, studentName: string, filePath: string, ts: number): void;
  /** run 失败驱动：latest=fail（强负面信号） */
  applyRunFailure(studentId: string, studentName: string, filePath: string, ts: number): void;
  /** 服务端重启回放（spec §5.3）：仅传当天行；按 ts 升序回放 latest（unreviewed 不覆盖 pass/fail） */
  warmUpFromReviews(rows: ReviewResultRow[]): void;
  /** 当天涌现题（spec 决策 #18）：任一格 lastTs >= dayStartMs 的题才输出；每题只统计当天格子；三态总和降序；不含学生名单 */
  list(dayStartMs: number): ExerciseProgressItem[];
}

export function createExerciseProgressTracker(): ExerciseProgressTracker {
  // 题 id（filePath）→ 学生 id → 格子（仅服务端内存计数用，决策 #18 涌现口径）
  const files = new Map<string, Map<string, Entry>>();

  const entryOf = (id: string, studentId: string, studentName: string, ts: number): Entry => {
    let m = files.get(id);
    if (!m) { m = new Map(); files.set(id, m); }
    let e = m.get(studentId);
    if (!e) { e = { studentName, latest: "unreviewed", lastTs: ts }; m.set(studentId, e); }
    e.studentName = studentName;
    e.lastTs = Math.max(e.lastTs, ts);
    return e;
  };

  return {
    applyReview(studentId, studentName, filePath, status, ts) {
      const e = entryOf(filePath, studentId, studentName, ts);
      e.latest = status;   // pass / fail
    },
    applyUnreviewed(studentId, studentName, filePath, ts) {
      const e = entryOf(filePath, studentId, studentName, ts);
      if (e.latest !== "pass" && e.latest !== "fail") e.latest = "unreviewed";   // 强信号不覆盖
    },
    applyRunFailure(studentId, studentName, filePath, ts) {
      const e = entryOf(filePath, studentId, studentName, ts);
      e.latest = "fail";
    },
    warmUpFromReviews(rows) {
      const sorted = [...rows].sort((a, b) => a.ts - b.ts);
      for (const r of sorted) {
        const e = entryOf(r.filePath, r.studentId, r.studentName, r.ts);
        if (r.status === "unreviewed") {
          if (e.latest !== "pass" && e.latest !== "fail") e.latest = "unreviewed";   // 与实时语义一致
        } else {
          e.latest = r.status;
        }
      }
    },
    list(dayStartMs) {
      const items: ExerciseProgressItem[] = [];
      for (const [id, students] of files) {
        let passed = 0, stuck = 0, unreviewed = 0;
        let active = false;
        for (const e of students.values()) {
          if (e.lastTs < dayStartMs) continue;   // 当天口径：只统计今天动过的格子
          active = true;
          if (e.latest === "pass") passed++;
          else if (e.latest === "fail") stuck++;
          else unreviewed++;
        }
        if (!active) continue;   // 题目筛选：当天无提交/运行记录的题不显示
        items.push({
          id,
          displayName: id.split(/[\\/]/).pop() ?? id,
          isProject: !id.endsWith(".py"),
          passed, stuck, unreviewed,
        });
      }
      return items.sort((a, b) => {
        const sumA = a.passed + a.stuck + a.unreviewed;
        const sumB = b.passed + b.stuck + b.unreviewed;
        return sumA !== sumB ? sumB - sumA : a.id < b.id ? -1 : 1;
      });
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/exerciseProgress.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/exerciseProgress.ts packages/server/src/__tests__/exerciseProgress.test.ts
git commit -m "feat(server): ExerciseProgress 当天涌现追踪器（dashboard-v2 Task 7）"
```

---

### Task 8: trend 追踪器（课堂节奏分桶）

**Files:**
- Create: `packages/server/src/trend.ts`
- Test: `packages/server/src/__tests__/trend.test.ts`（新建）

**Interfaces:**
- Produces: `createTrendTracker(): TrendTracker`，`TrendTracker = { record(ts: number, success: boolean): void; list(): TrendBucket[] }`（无 reset——按天过滤在快照组装处做，累计内存桶 24h 修剪）

- [ ] **Step 1: 写失败测试 `packages/server/src/__tests__/trend.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { createTrendTracker } from "../trend";

const BUCKET_MS = 5 * 60_000;
const T0 = Date.parse("2026-10-22T08:00:00.000Z");

describe("TrendTracker（课堂节奏，spec dashboard-v2 §5.4）", () => {
  it("跨桶落桶：5 分钟一桶，成功/失败分计，tStart 升序", () => {
    const t = createTrendTracker();
    t.record(T0 + 1, true);
    t.record(T0 + 2, true);
    t.record(T0 + BUCKET_MS + 1, false);
    expect(t.list()).toEqual([
      { tStart: T0, runs: 2, errors: 0 },
      { tStart: T0 + BUCKET_MS, runs: 0, errors: 1 },
    ]);
  });
  it("record 修剪超 24h 旧桶（防内存膨胀）", () => {
    const t = createTrendTracker();
    t.record(Date.now() - 25 * 60 * 60_000, true);
    t.record(Date.now(), true);
    expect(t.list()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/trend.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `packages/server/src/trend.ts`**

```ts
import type { TrendBucket } from "@classroom/shared";

const BUCKET_MS = 5 * 60_000;
const PRUNE_MS = 24 * 60 * 60_000;

export interface TrendTracker {
  /** run 事件驱动：success → runs++，否则 errors++（幂等命中由调用方跳过，spec §5.4） */
  record(ts: number, success: boolean): void;
  /** tStart 升序全量桶（当天过滤在快照组装处做） */
  list(): TrendBucket[];
}

export function createTrendTracker(): TrendTracker {
  const buckets = new Map<number, TrendBucket>();
  return {
    record(ts, success) {
      const tStart = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
      const b = buckets.get(tStart) ?? { tStart, runs: 0, errors: 0 };
      if (success) b.runs += 1; else b.errors += 1;
      buckets.set(tStart, b);
      for (const [k, v] of buckets) if (ts - v.tStart > PRUNE_MS) buckets.delete(k);
    },
    list() {
      return [...buckets.values()].sort((a, b) => a.tStart - b.tStart);
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/trend.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/trend.ts packages/server/src/__tests__/trend.test.ts
git commit -m "feat(server): trend 课堂节奏 5 分钟分桶追踪器（dashboard-v2 Task 8）"
```

---

### Task 9: index.ts 装配（按天窗口 + 预热 + 事件驱动）+ 花名册联动

**Files:**
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/routes/roster.ts`
- Test: `packages/server/src/__tests__/dashboardV2.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2/3/4/5/7/8 的 dayStart / exerciseCatalog / exerciseProgress / touchActivity / trend
- Produces:
  - `TeacherSnapshot` 组装：`exerciseProgress` / `trend` / `stats` 全部就位（无 classSession）
  - `registerRosterRoutes` deps 新增可选 `onRosterChanged?: () => void`（导入/增/删/清除四站点调用）
  - 题目目录 TTL 刷新定时器（`unref` 防测试挂起）

- [ ] **Step 1: 写失败测试 `packages/server/src/__tests__/dashboardV2.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../index";

function makeApp() {
  const { app, hub } = createApp({ dbPath: ":memory:", llmConfig: null, reviewConfig: null });
  const pushes = vi.spyOn(hub, "publish");
  return { app, pushes };
}

const editBody = (n: number) => ({
  id: `edit:dashboardv2test000${n}`, ts: Date.now(), surface: "edit", kind: "code_change",
  student_id: "2025001", student_name: "张三", class_id: "3A",
  payload: { file: "l1/a.py", changes: 1 },
});
const runErrorBody = (n: number) => ({
  id: `run:dashboardv2test000${n}`, ts: Date.now(), surface: "run", kind: "execution_error",
  student_id: "2025001", student_name: "张三", class_id: "3A",
  payload: { file: "lesson1/a.py", exit_code: 1, error_type: "NameError", error_message: "name 'x' is not defined" },
});

describe("按天窗口与 V2 快照（spec dashboard-v2）", () => {
  it("快照字段就位：exerciseProgress/trend/stats；无 classSession 字段", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/summary").expect(200);
    expect(res.body.exerciseProgress).toEqual([]);
    expect(res.body.trend).toEqual([]);
    expect(res.body.stats).toEqual({ online: 0, total: 0, needHelp: 0, runs: 0 });
    expect(res.body.classSession).toBeUndefined();
  });

  it("edit 事件：首次跨边界推快照 + 学生转活跃；同窗口连续 edit 不再推；幂等命中不推", async () => {
    const { app, pushes } = makeApp();
    await request(app).post("/api/events").send(editBody(1)).expect(200);
    expect(pushes).toHaveBeenCalledTimes(1);
    await request(app).post("/api/events").send(editBody(2)).expect(200);
    expect(pushes).toHaveBeenCalledTimes(1);          // 边沿触发：同一天内不刷屏
    await request(app).post("/api/events").send(editBody(1)).expect(200, { ok: true, duplicated: true });
    expect(pushes).toHaveBeenCalledTimes(1);          // 幂等命中跳过
    const summary = await request(app).get("/api/summary").expect(200);
    expect(summary.body.students[0]).toMatchObject({ studentId: "2025001", status: "green" });
    expect(summary.body.stats).toMatchObject({ online: 1, total: 1 });
  });

  it("run 失败事件：当天涌现题 stuck=1 + 通过率（花名册分母）+ 趋势 errors 桶", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "2025001 张三\n2025002 李四\n2025003 王五\n2025004 赵六" }).expect(200);
    for (const n of [1, 2, 3]) await request(app).post("/api/events").send(runErrorBody(n)).expect(200);
    const summary = await request(app).get("/api/summary").expect(200);
    expect(summary.body.exerciseProgress[0]).toMatchObject({
      id: "lesson1/a.py", displayName: "a.py", isProject: false,
      passed: 0, stuck: 1, unreviewed: 0,
      total: 4, passRate: 0,   // 花名册 4 人为分母（决策 #20）
    });
    expect(summary.body.trend[0]).toMatchObject({ runs: 0, errors: 3 });
    expect(summary.body.students[0].status).toBe("red");   // 同 subtype ×3 未解决
    expect(summary.body.stats.needHelp).toBe(1);
  });

  it("学生抽屉详情：仅返回当天（窗口内）事件（spec §4.2）", async () => {
    const { app } = makeApp();
    // 窗口外事件（昨天）：入库但不进抽屉
    await request(app).post("/api/events").send({
      ...runErrorBody(9), id: "run:dashboardv2testOLD1", ts: Date.now() - 25 * 60 * 60_000,
    }).expect(200);
    await request(app).post("/api/events").send(runErrorBody(10)).expect(200);
    const detail = await request(app).get("/api/student/2025001").expect(200);
    expect(detail.body.events).toHaveLength(1);
    expect(detail.body.events[0].rawMessage).toContain("name 'x' is not defined");
  });

  it("花名册导入触发矩阵学生侧刷新（onRosterChanged 联动）", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "2025001 张三\n2025002 李四" }).expect(200);
    const summary = await request(app).get("/api/summary").expect(200);
    // catalog 为空（测试环境无 Gitea）→ 矩阵骨架为空，但 roster 变更不报错即可
    expect(Array.isArray(summary.body.exerciseProgress)).toBe(true);
  });

  it("矩阵显示全班：花名册学生无事件也出现在 students（online=false 变暗标识，spec 决策 #15/#19）", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "2025001 张三\n2025002 李四" }).expect(200);
    const summary = await request(app).get("/api/summary").expect(200);
    expect(summary.body.students).toHaveLength(2);
    expect(summary.body.students.map((s: { studentId: string }) => s.studentId).sort()).toEqual(["2025001", "2025002"]);
    expect(summary.body.students.every((s: { status: string; online: boolean }) => s.status === "green" && s.online === false)).toBe(true);
    expect(summary.body.stats.total).toBe(2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/dashboardV2.test.ts`
Expected: FAIL（快照无新字段；抽屉未过滤）

- [ ] **Step 3: 装配 `packages/server/src/index.ts`**

import 区追加：

```ts
import { dayStart } from "./classDay";
import { createExerciseProgressTracker } from "./exerciseProgress";
import { createTrendTracker } from "./trend";
```

`createApp` 内，`const aggregator = createAggregator();` 之前插入（gitea 依赖环境变量，从原 177 行位置上移到装配区）：

```ts
  // —— Gitea 联动（学生分支直连模型）：三环境变量齐备才启用；缺任一则跳过（info 一条）——
  const gitea = process.env.GITEA_URL && process.env.GITEA_ADMIN_TOKEN && process.env.GITEA_REPO
    ? createGiteaAdmin({ baseUrl: process.env.GITEA_URL, adminToken: process.env.GITEA_ADMIN_TOKEN, repo: process.env.GITEA_REPO })
    : null;
  if (!gitea) {
    logEvent({ event: "gitea.provision_skipped", level: "info", data: { reason: "GITEA_URL/GITEA_ADMIN_TOKEN/GITEA_REPO 未全部配置" } });
  }

  // —— 题目涌现 + 课堂节奏（spec dashboard-v2 §5.1/§5.3/§5.4；决策 #18 无目录服务）——
  const exerciseProgress = createExerciseProgressTracker();
  const trend = createTrendTracker();
```

（原「Gitea 管理联动」处的 `const gitea = ...` 与 `if (!gitea)` 判断整体删除，路由注册处的 `registerRosterRoutes(app, { persistence, gitea })` 不变——gitea 变量已上移。）

装配区之后追加启动回放（放在 `const hub = createTeacherHub(buildSnapshot);` **之后**，因为要 publish）：

```ts
  // 重启回放（spec §5.3/§5.4，决策 #18）：仅回放**当天** review_results 与 run 事件；失败降级不阻塞服务
  try {
    const todayStart = dayStart(Date.now());
    exerciseProgress.warmUpFromReviews(persistence.getReviewResultsSince(todayStart));
    for (const r of persistence.getRunEventsSince(todayStart)) trend.record(r.ts, r.success);
  } catch (err) {
    logEvent({ event: "warmup.failed", level: "warn", data: { error: err instanceof Error ? err.message : String(err) } });
  }
```

（无题目目录 TTL 定时器——涌现口径不需要。）

`buildSnapshot` 整体替换为：

```ts
  const buildSnapshot = (): TeacherSnapshot => {
    const now = Date.now();
    const records = stateManager.listRecords();
    // 矩阵显示全班（spec 决策 #15）：花名册中无事件记录的学生补空记录（lastActivityAt=0 → idle 灰显）
    const seenIds = new Set(records.map((r) => r.studentId));
    const rosterGhosts = persistence.getRoster()
      .filter((e) => !seenIds.has(e.studentId))
      .map((e) => ({
        studentId: e.studentId, studentName: e.studentName,
        classId: records[0]?.classId ?? "default",
        events: [], lastActivityAt: 0, lastErrorAt: null, lastResolvedAt: null, consecutiveErrors: 0,
      }));
    const allRecords = [...records, ...rosterGhosts];
    const windowStart = dayStart(now);   // 大屏全部数据只看当天（spec §4）
    const agg = aggregator.recompute(allRecords, now, windowStart);
    const trendBuckets = trend.list().filter((b) => b.tStart >= windowStart);
    const rosterTotal = persistence.getRoster().length;   // 班级总人数（通过率分母，决策 #20）
    // V1 单班级：records[0]?.classId 作为 classId 来源（未来多班级需改为聚合所有班级）
    return {
      ts: now,
      classId: records[0]?.classId ?? "default",
      ...agg,
      exerciseProgress: exerciseProgress.list(windowStart).map((e) => ({
        ...e,
        total: rosterTotal,
        passRate: rosterTotal === 0 ? 0 : e.passed / rosterTotal,   // 每题通过率（决策 #20）
      })),
      trend: trendBuckets,
      stats: {
        online: agg.students.filter((s) => s.status !== "idle").length,
        total: agg.students.length,
        needHelp: agg.students.filter((s) => s.status === "red").length,
        runs: trendBuckets.reduce((sum, b) => sum + b.runs, 0),
      },
    };
  };
```

`/api/events` 的非 diag/run 分支整体替换为：

```ts
      // 非 diag/run：仅入库（spec §2：原始行必写，不解释、不进内存看板）
      if (!isDiagRunEvent(ev)) {
        const inserted = persistence.insertTraceEvent(toRow(ev));
        // edit 活动信号（spec §5.5）：仅推进 lastActivityAt；跨越「无活动 ↔ 有活动」边界才推快照（边沿触发）
        if (ev.surface === "edit" && inserted) {
          const prevActivity = stateManager.touchActivity(ev.studentId, ev.studentName, ev.classId, ev.ts);
          const windowStart = dayStart(Date.now());
          const flipped = (prevActivity === null || prevActivity < windowStart) && ev.ts >= windowStart;
          if (flipped) hub.publish(buildSnapshot());
        }
        logEvent({ event: "route.event_stored", data: { eventId: ev.id, surface: ev.surface, kind: ev.kind }, durationMs: Date.now() - startTime });
        return res.json({ ok: true, duplicated: !inserted });
      }
```

diag/run 分支的 `stateManager.apply(ev, explanation);` 之后、`hub.publish(buildSnapshot());` 之前插入：

```ts
      // 题目涌现（当天）+ 课堂节奏：run 失败置 fail；run 成败驱动 5 分钟分桶
      if (ev.eventType === "run") {
        if (!ev.success && ev.filePath) exerciseProgress.applyRunFailure(ev.studentId, ev.studentName, ev.filePath, ev.ts);
        trend.record(ev.ts, ev.success);
      }
```

`/api/student/:id` 处理器整体替换（抽屉只显示当天，spec §4.2）：

```ts
  // 单生错误历史（抽屉）：仅返回当天窗口内的事件（spec dashboard-v2 §4.2）
  app.get("/api/student/:id", (req, res) => {
    const detail = stateManager.getStudentDetail(req.params.id);
    if (!detail) {
      logEvent({ event: "api.student_not_found", level: "warn", data: { studentId: req.params.id } });
      return res.status(404).json({ error: "未找到该学生" });
    }
    const windowStart = dayStart(Date.now());
    const events = detail.events.filter((e) => e.ts >= windowStart);
    logEvent({ event: "api.student_detail", level: "debug", data: { studentId: req.params.id, eventCount: events.length } });
    res.json({ ...detail, events });
  });
```

- [ ] **Step 4: 花名册联动 `routes/roster.ts`**

`registerRosterRoutes` 的 deps 类型加可选回调，并在四个写操作成功后调用：

```ts
export function registerRosterRoutes(app: Express, deps: { persistence: Persistence; gitea?: GiteaAdmin | null; onRosterChanged?: () => void }) {
```

调用点（各写操作成功响应前插入一行）：
- `POST /api/roster`：`deps.persistence.replaceRoster(entries);` 与日志之后 → `deps.onRosterChanged?.();`
- `POST /api/roster/entry`：`deps.persistence.upsertRosterEntry(...)` 之后 → `deps.onRosterChanged?.();`
- `DELETE /api/roster/entry/:studentId`：成功分支 → `deps.onRosterChanged?.();`
- `POST /api/roster/entry/:studentId/purge`：`deps.persistence.purgeRosterEntry(studentId);` 之后 → `deps.onRosterChanged?.();`

`index.ts` 的注册改为：

```ts
  registerRosterRoutes(app, {
    persistence, gitea,
    onRosterChanged: () => hub.publish(buildSnapshot()),   // 矩阵全班来源刷新（spec 决策 #15）
  });
```

- [ ] **Step 5: 运行确认通过 + server 全量无回归**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/dashboardV2.test.ts && pnpm --filter @classroom/server exec vitest run`
Expected: dashboardV2 全 PASS；全量无回归（`integration.test.ts` 等若因快照新字段断言失败，按 Task 1 makeSnapshot 同款默认值补齐 `exerciseProgress/trend/stats` 字段后重跑）

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/index.ts packages/server/src/routes/roster.ts packages/server/src/__tests__/dashboardV2.test.ts
git commit -m "feat(server): 按天窗口装配 + 题目目录定时刷新 + 事件驱动与 V2 快照（dashboard-v2 Task 9）"
```

---

### Task 10: reviewController 落库 + 喂养题目进度

**Files:**
- Modify: `packages/server/src/controllers/reviewController.ts`
- Modify: `packages/server/src/index.ts`（一行）
- Test: `packages/server/src/__tests__/reviewRequest.test.ts`

**Interfaces:**
- Consumes: Task 6 `saveReviewResult`、Task 7 `ExerciseProgressTracker`
- Produces: `ReviewRequestDeps` 新增必填字段 `exerciseProgress: ExerciseProgressTracker`

- [ ] **Step 1: 更新 `reviewRequest.test.ts` 的 makeDeps 并追加失败测试**

import 区追加：

```ts
import { createExerciseProgressTracker } from "../exerciseProgress";
```

`makeDeps` 内 `const counters = ...` 之前加：

```ts
  const exerciseProgress = createExerciseProgressTracker();   // 涌现口径（决策 #18）：filePath 直接作题 id
```

deps 对象加 `exerciseProgress,`，返回值改为：

```ts
  return { p, deps, counters, llm, stateManager, exerciseProgress };
```

文件末尾追加：

```ts
describe("评审结果持久化与题目进度（spec dashboard-v2 §5.2/§5.3）", () => {
  it("pass：review_results 落行（classId=null）+ 进度 passed=1", async () => {
    const { deps, p, exerciseProgress } = makeDeps("pass");
    await requestReview(deps, { ...fileInput, code: "print(1)" });
    const rows = p.getReviewResultsSince(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ studentId: "2025001", filePath: "lesson5/a.py", status: "pass" });
    expect(exerciseProgress.list(0)[0]).toMatchObject({ id: "lesson5/a.py", passed: 1, stuck: 0, unreviewed: 0 });
  });

  it("fail：落行 + stuck=1；run 失败同为 fail；随后 pass 翻转 latest", async () => {
    const { deps, exerciseProgress, llm } = makeDeps("fail");
    await requestReview(deps, { ...fileInput, code: "print(1)" });
    exerciseProgress.applyRunFailure("2025001", "张三", "lesson5/a.py", Date.now());   // run 失败同为 fail
    expect(deps.persistence.getReviewResultsSince(0)[0].status).toBe("fail");
    llm.status = "pass";                                                   // 换内容绕开评审缓存
    await requestReview(deps, { ...fileInput, code: "print(2)" });
    expect(exerciseProgress.list(0)[0]).toMatchObject({ id: "lesson5/a.py", passed: 1, stuck: 0 });
  });

  it("unreviewed：落行 + 待评审计数（不注入告警/置绿；缓存表不缓存约束不变）", async () => {
    const { deps, p, exerciseProgress, counters, stateManager } = makeDeps("unreviewed");
    const r = await requestReview(deps, { ...fileInput, code: "print(1)" });
    expect(r.ok).toBe(true);
    expect(p.getReviewResultsSince(0)).toHaveLength(1);
    expect(p.getReviewResultsSince(0)[0].status).toBe("unreviewed");
    expect(exerciseProgress.list(0)[0]).toMatchObject({ id: "lesson5/a.py", unreviewed: 1, passed: 0, stuck: 0 });
    expect(counters.snapshotPushes).toBe(0);      // 不注入合成事件、不推快照（瞬态不变学生状态）
    expect(stateManager.listRecords()).toHaveLength(0);
  });

  it("saveReviewResult 抛错不阻塞评审响应", async () => {
    const { deps } = makeDeps("pass");
    (deps.persistence as unknown as { saveReviewResult: () => void }).saveReviewResult = () => { throw new Error("db locked"); };
    const r = await requestReview(deps, { ...fileInput, code: "print(1)" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.review.status).toBe("pass");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/reviewRequest.test.ts`
Expected: 新 describe FAIL（deps 缺 exerciseProgress / 无落库行为）；既有用例因 makeDeps 类型报错同样需要 Step 3 才能过

- [ ] **Step 3: 实现 `reviewController.ts` 改动**

import 区追加：

```ts
import type { ExerciseProgressTracker } from "../exerciseProgress";
```

`ReviewRequestDeps` 加字段：

```ts
export interface ReviewRequestDeps {
  persistence: Persistence;
  reviewService: ReviewService;
  stateManager: StateManager;
  exerciseProgress: ExerciseProgressTracker;   // 题目进度矩阵（spec dashboard-v2 §5.3）
  publishSnapshot: () => void;   // fail 注入后推全量快照（告警/聚合面板刷新）
}
```

`injectReviewFail` 之前新增：

```ts
/** 评审结果落库 + 喂养题目进度（spec dashboard-v2 §5.2/§5.3）：pass/fail/unreviewed 三态均落行
 * （本表是题目进度事实源，unreviewed 落行支撑重启回放；缓存表「unreviewed 不缓存」约束不变）；
 * 写失败不阻塞评审响应（log warn 后继续） */
function persistReviewResult(
  deps: ReviewRequestDeps,
  args: { studentId: string; studentName: string; filePath: string; status: "pass" | "fail" | "unreviewed"; reason: string | null },
): void {
  try {
    deps.persistence.saveReviewResult({
      studentId: args.studentId, classId: null, filePath: args.filePath,
      status: args.status, reason: args.reason, ts: Date.now(),
    });
    if (args.status === "unreviewed") {
      deps.exerciseProgress.applyUnreviewed(args.studentId, args.studentName, args.filePath, Date.now());
    } else {
      deps.exerciseProgress.applyReview(args.studentId, args.studentName, args.filePath, args.status, Date.now());
    }
  } catch (err) {
    logEvent({ event: "review.result_persist_failed", level: "warn", data: {
      studentId: args.studentId, error: err instanceof Error ? err.message : String(err),
    } });
  }
}
```

`requestReview` 的结果分发段改为：

```ts
  if (review.status === "fail") {
    persistReviewResult(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, filePath: input.filePath, status: "fail", reason: review.reason });
    injectReviewFail(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, review });
  } else if (review.status === "pass") {
    persistReviewResult(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, filePath: input.filePath, status: "pass", reason: review.reason });
    injectReviewPass(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, review });
  } else {
    // unreviewed（LLM 未配置/挂/不确定，spec 决策 #14）：不注入告警/置绿（瞬态不变学生状态），
    // 但落进度事实表 + 待评审计数
    persistReviewResult(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, filePath: input.filePath, status: "unreviewed", reason: review.reason });
  }
```

`index.ts` 的 `reviewRequestDeps` 对象加一行 `exerciseProgress,`：

```ts
  const reviewRequestDeps: ReviewRequestDeps = {
    persistence, reviewService, stateManager, exerciseProgress,
    publishSnapshot: () => hub.publish(buildSnapshot()),
  };
```

- [ ] **Step 4: 运行确认通过 + server 全量无回归**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/reviewRequest.test.ts && pnpm --filter @classroom/server exec vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/controllers/reviewController.ts packages/server/src/index.ts packages/server/src/__tests__/reviewRequest.test.ts
git commit -m "feat(server): 评审结果落 review_results 并喂养题目矩阵（dashboard-v2 Task 10）"
```

---

### Task 11: StatusBar 组件 + App 骨架重构

**Files:**
- Create: `packages/dashboard/src/components/StatusBar.vue`
- Modify: `packages/dashboard/src/App.vue`
- Modify: `packages/dashboard/src/style.css`
- Delete: `packages/dashboard/src/components/ErrorAggPanel.vue`、`packages/dashboard/src/__tests__/ErrorAggPanel.test.ts`（一期下线，spec 决策 #17）
- Test: `packages/dashboard/src/__tests__/StatusBar.test.ts`（新建）、`packages/dashboard/src/__tests__/App.test.ts`

**Interfaces:**
- Consumes: store.snapshot 的 `stats` / `sseConnected`
- Produces: StatusBar 组件（App 骨架引用）

- [ ] **Step 1: 写失败测试 `packages/dashboard/src/__tests__/StatusBar.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import StatusBar from "../components/StatusBar.vue";
import { makeSnapshot, mountWithStore } from "./helpers";

describe("StatusBar（顶栏，spec dashboard-v2 §3①）", () => {
  it("统计大数字渲染（在线/急需帮助/运行次数，决策 #18 无已通过评审）", async () => {
    const { wrapper, store } = mountWithStore(StatusBar);
    store.applySnapshot(makeSnapshot({
      stats: { online: 8, total: 10, needHelp: 2, runs: 42 },
    }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("课堂教学实时助教");
    expect(wrapper.text()).toContain("42");
    expect(wrapper.text()).toContain("2");
    expect(wrapper.text()).not.toContain("已通过评审");
  });

  it("日期 + 时钟显示", async () => {
    const { wrapper } = mountWithStore(StatusBar);
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("月");   // toLocaleDateString("zh-CN") 含「月」
    expect(wrapper.text()).toContain(":");    // 时钟 HH:MM:SS
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/dashboard exec vitest run src/__tests__/StatusBar.test.ts`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 `packages/dashboard/src/components/StatusBar.vue`**

```vue
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useClassroom } from "../stores/classroom";

const store = useClassroom();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onUnmounted(() => { if (timer) clearInterval(timer); });

const stats = computed(() => store.snapshot?.stats ?? { online: 0, total: 0, needHelp: 0, runs: 0 });
const dateText = computed(() => new Date(now.value).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" }));
const clock = computed(() => new Date(now.value).toLocaleTimeString("zh-CN", { hour12: false }));
</script>

<template>
  <header class="status-bar">
    <h1>课堂教学实时助教</h1>
    <div class="stats">
      <div class="stat"><span class="num">{{ stats.online }}</span><span class="label">在线 / {{ stats.total }} 人</span></div>
      <div class="stat warn"><span class="num">{{ stats.needHelp }}</span><span class="label">急需帮助</span></div>
      <div class="stat"><span class="num">{{ stats.runs }}</span><span class="label">运行次数</span></div>
    </div>
    <span class="date">{{ dateText }}</span>
    <span class="clock">{{ clock }}</span>
    <span class="conn" :class="store.sseConnected ? 'on' : 'off'">
      {{ store.sseConnected ? "已连接" : "连接中断，重试中…" }}
    </span>
  </header>
</template>

<style scoped>
.status-bar { display: flex; align-items: center; gap: 24px; background: #1e293b; color: #fff; padding: 10px 20px; }
.status-bar h1 { font-size: 20px; margin: 0; white-space: nowrap; }
.stats { display: flex; gap: 32px; flex: 1; justify-content: center; }
.stat { display: flex; align-items: baseline; gap: 6px; }
.stat .num { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; }
.stat .label { font-size: 13px; opacity: 0.75; white-space: nowrap; }
.stat.warn .num { color: #f87171; }
.date { font-size: 16px; white-space: nowrap; opacity: 0.9; }
.clock { font-size: 16px; font-variant-numeric: tabular-nums; }
.conn { font-size: 12px; white-space: nowrap; }
.conn.on { color: #4ade80; }
.conn.off { color: #f87171; }
</style>
```

- [ ] **Step 4: 重构 `App.vue`**

```vue
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useClassroom } from "./stores/classroom";
import { connectClassroom } from "./api/sse";
import StatusBar from "./components/StatusBar.vue";
import StudentMatrix from "./components/StudentMatrix.vue";
import AIPanel from "./components/AIPanel.vue";
import StudentDrawer from "./components/StudentDrawer.vue";
import AdminView from "./views/AdminView.vue";
import Toast from "./components/Toast.vue";

const store = useClassroom();

const isAdmin = ref(window.location.hash === "#/admin");
function onHashChange() { isAdmin.value = window.location.hash === "#/admin"; }
window.addEventListener("hashchange", onHashChange);

let stopSse: (() => void) | null = null;
onMounted(() => {
  stopSse = connectClassroom(store);
});
onUnmounted(() => {
  stopSse?.();
  window.removeEventListener("hashchange", onHashChange);
});
</script>

<template>
  <AdminView v-if="isAdmin" />
  <div class="app" v-else>
    <StatusBar />
    <main class="main-grid">
      <StudentMatrix />
      <div class="right-col">
        <AIPanel />
      </div>
    </main>
    <StudentDrawer />
  </div>
  <Toast />
</template>
```

注意：一期无图表行（spec 决策 #17，ChartsRow 二期实现=Task 16）。`AIPanel` 在 Task 13 才创建，本步骤先写**临时占位组件**：

```vue
<template><section /></template>
```

（写入 `AIPanel.vue`，Step 7 一并提交占位；Task 13 覆盖为完整实现。）

- [ ] **Step 5: 更新 `style.css` 布局与字号体系**

将 `main { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; }` 规则替换为：

```css
/* —— 大屏 V2 布局（spec §3 方案 D：左右两栏 60/40；图表行二期实现）—— */
.main-grid { display: grid; grid-template-columns: 3fr 2fr; gap: 12px; align-items: start; }
.right-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
```

- [ ] **Step 6: 更新 `App.test.ts`**

`emptySnapshot` 对象补齐 V2 字段（与 makeSnapshot 同款默认值：`exerciseProgress: [], trend: [], stats: { online: 0, total: 0, needHelp: 0, runs: 0 }`），断言改为：

```ts
    expect(wrapper.text()).toContain("课堂教学实时助教");
    expect(wrapper.text()).toContain("全班状态");
    expect(wrapper.text()).toContain("教学建议");
    expect(wrapper.text()).toContain("等待学生上报");
    expect(wrapper.text()).not.toContain("优先帮助");   // AlertPanel 已移除
    expect(wrapper.text()).not.toContain("错误聚合");   // ErrorAggPanel 一期下线（决策 #17）
```

- [ ] **Step 7: 删除 ErrorAggPanel（一期下线）**

用 DeleteFile 删除：
- `packages/dashboard/src/components/ErrorAggPanel.vue`
- `packages/dashboard/src/__tests__/ErrorAggPanel.test.ts`

（App.vue 一期不再渲染图表区，spec 决策 #17；aggregates 数据仍在快照，二期 ChartsRow 补 UI。）

- [ ] **Step 8: 运行 dashboard 测试**

Run: `pnpm --filter @classroom/dashboard exec vitest run`
Expected: PASS（AlertPanel 尚未删除、SuggestionBar 仍在但已不被 App 引用——其测试仍通过，Task 13 删除）

- [ ] **Step 9: Commit**

```bash
git add packages/dashboard/src/components packages/dashboard/src/App.vue packages/dashboard/src/style.css packages/dashboard/src/__tests__/StatusBar.test.ts packages/dashboard/src/__tests__/App.test.ts
git commit -m "feat(dashboard): StatusBar 顶栏与 App 方案 D 骨架（一期无图表行，dashboard-v2 Task 11）"
```

---

### Task 12: StudentMatrix 全班瓦片 + 未在线变暗标识 + 图例 + 字号放大

**Files:**
- Modify: `packages/dashboard/src/components/StudentMatrix.vue`
- Test: `packages/dashboard/src/__tests__/StudentMatrix.test.ts`

- [ ] **Step 1: 追加失败测试**

既有 `students` 数组每条加 `online: true`；追加一条未在线学生（status 仍 green，不占状态，决策 #19）：

```ts
{ studentId: "stu004", studentName: "赵六", status: "green" as StatusColor, online: false, priorityScore: 0, lastActivityAt: null, lastErrorAt: null, errorCountTotal: 0, recentErrors: [] },
```

追加用例：

```ts
  it("未在线学生变暗标识（.offline，不占状态；图例含未在线计数，spec 决策 #19）", async () => {
    const { wrapper, store } = mountWithStore(StudentMatrix);
    store.applySnapshot(makeSnapshot({ students }));
    await wrapper.vm.$nextTick();
    const tiles = wrapper.findAll(".tile");
    expect(tiles[3].classes()).toContain("offline");
    expect(tiles[3].classes()).toContain("green");   // 状态不占，仍 green
    expect(wrapper.text()).toContain("未在线 1 人");
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/dashboard exec vitest run src/__tests__/StudentMatrix.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现**

script 的 `statusCounts` 三项状态口径 + 未在线计数：

```ts
const statusCounts = computed(() => {
  const counts = { red: 0, yellow: 0, green: 0, offline: 0 };
  for (const s of store.snapshot?.students ?? []) {
    if (!s.online) counts.offline++;
    else counts[s.status]++;
  }
  return counts;
});
```

template：瓦片 class 加 offline（变暗标识，不影响状态色 class），图例三项 + 未在线计数：

```html
      <div class="counts">
        <span class="red">🔴 卡住 {{ statusCounts.red }} 人</span>
        <span class="yellow">🟡 有错误 {{ statusCounts.yellow }} 人</span>
        <span class="green">🟢 正常 {{ statusCounts.green }} 人</span>
        <span class="off-legend">⚪ 未在线 {{ statusCounts.offline }} 人</span>
      </div>
      <div class="grid" v-if="store.snapshot.students.length">
        <div
          v-for="s in store.snapshot.students"
          :key="s.studentId"
          class="tile"
          :class="[s.status, { offline: !s.online }]"
          :title="tooltip(s.recentErrors)"
          @click="store.openDrawer(s.studentId)"
        >
          <span class="dot" />{{ s.studentName }}
        </div>
      </div>
```

style 调整（字号 ≥16px、offline 变暗+灰点、网格自适应保留）：

```css
.matrix h2 { margin: 0; font-size: 18px; }
.counts { display: flex; gap: 8px; font-size: 14px; }
.counts .off-legend { color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
.tile { display: flex; align-items: center; gap: 6px; padding: 12px 10px; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-size: 16px; }
.tile.offline { opacity: 0.45; }
.tile.offline .dot { background: #9ca3af; }
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @classroom/dashboard exec vitest run src/__tests__/StudentMatrix.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/components/StudentMatrix.vue packages/dashboard/src/__tests__/StudentMatrix.test.ts
git commit -m "feat(dashboard): 矩阵全班瓦片与未在线变暗标识、图例、字号放大（dashboard-v2 Task 12）"
```

---

### Task 13: AIPanel 建议卡（替代 SuggestionBar）+ 删除 AlertPanel

**Files:**
- Modify: `packages/dashboard/src/components/AIPanel.vue`（覆盖 Task 11 占位）
- Delete: `packages/dashboard/src/components/AlertPanel.vue`
- Delete: `packages/dashboard/src/__tests__/AlertPanel.test.ts`
- Delete: `packages/dashboard/src/components/SuggestionBar.vue`
- Delete: `packages/dashboard/src/__tests__/SuggestionBar.test.ts`
- Test: `packages/dashboard/src/__tests__/AIPanel.test.ts`（新建）

**Interfaces:**
- Consumes: store.snapshot.suggestions（kind/text/acked 与 V1 一致）；ack 走 `POST /api/suggestions/ack`

- [ ] **Step 1: 写失败测试 `packages/dashboard/src/__tests__/AIPanel.test.ts`**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import AIPanel from "../components/AIPanel.vue";
import { makeSnapshot, mountWithStore } from "./helpers";
import type { SuggestionItem } from "@classroom/shared";

const suggestions: SuggestionItem[] = [
  { id: "class-review:缺少冒号", kind: "class-review", text: "⚠️ 8 人卡在「缺少冒号」，建议全班讲评", acked: false },
  { id: "individual:stu001", kind: "individual", text: "🙋 张三 连续报错，建议单独辅导", acked: false },
  { id: "group-discuss:意外缩进", kind: "group-discuss", text: "💡 2 人遇到「意外缩进」，可小组讨论", acked: true },
];

describe("AIPanel（教学建议卡，spec dashboard-v2 §3③）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("AI 标识 + 竖排建议卡；acked 不显示", async () => {
    const { wrapper, store } = mountWithStore(AIPanel);
    store.applySnapshot(makeSnapshot({ suggestions }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("AI");
    expect(wrapper.text()).toContain("全班讲评");
    expect(wrapper.text()).toContain("🙋 张三 连续报错，建议单独辅导");
    expect(wrapper.text()).not.toContain("小组讨论");   // acked=true 不渲染
  });

  it("点击标记已处理 → POST ack + 本地立即隐藏", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper, store } = mountWithStore(AIPanel);
    store.applySnapshot(makeSnapshot({ suggestions }));
    await wrapper.vm.$nextTick();
    await wrapper.findAll("button")[0].trigger("click");
    await wrapper.vm.$nextTick();
    expect(fetchMock).toHaveBeenCalledWith("/api/suggestions/ack", expect.objectContaining({ method: "POST" }));
    expect(wrapper.text()).not.toContain("全班讲评");
  });

  it("空建议占位", async () => {
    const { wrapper, store } = mountWithStore(AIPanel);
    store.applySnapshot(makeSnapshot());
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("暂无建议");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/dashboard exec vitest run src/__tests__/AIPanel.test.ts`
Expected: FAIL（占位组件无内容）

- [ ] **Step 3: 覆盖实现 `AIPanel.vue`**

```vue
<script setup lang="ts">
import { computed } from "vue";
import { useClassroom } from "../stores/classroom";

const store = useClassroom();
const visible = computed(() => store.snapshot?.suggestions.filter((s) => !s.acked) ?? []);
const KIND_LABEL: Record<string, string> = { "class-review": "全班讲评", "group-discuss": "小组讨论", individual: "单独辅导" };

async function ack(id: string) {
  try {
    await fetch("/api/suggestions/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } finally {
    // 服务端下次 update 会带 acked；本地立即隐藏（双保险，沿用 V1 语义）
    if (store.snapshot) {
      store.snapshot = {
        ...store.snapshot,
        suggestions: store.snapshot.suggestions.filter((s) => s.id !== id),
      };
    }
  }
}
</script>

<template>
  <section class="ai-panel" v-if="store.snapshot">
    <div class="panel-head">
      <span class="ai-badge">AI</span>
      <h2>教学建议</h2>
    </div>
    <p v-if="!visible.length" class="empty">暂无建议，课堂运转良好</p>
    <div class="card" v-for="s in visible" :key="s.id" :class="s.kind">
      <span class="kind-tag">{{ KIND_LABEL[s.kind] ?? s.kind }}</span>
      <p class="text">{{ s.text }}</p>
      <button @click="ack(s.id)">标记已处理</button>
    </div>
  </section>
</template>

<style scoped>
.ai-panel { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
.panel-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.ai-badge { background: #7c3aed; color: #fff; font-size: 12px; font-weight: 700; border-radius: 4px; padding: 2px 8px; letter-spacing: 1px; }
.ai-panel h2 { margin: 0; font-size: 18px; }
.card { display: flex; flex-direction: column; align-items: stretch; gap: 6px; background: var(--bg); border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 6px; padding: 12px; margin-bottom: 10px; }
.card.class-review { border-left-color: var(--red); }
.card.group-discuss { border-left-color: var(--yellow); }
.card.individual { border-left-color: var(--green); }
.kind-tag { font-size: 12px; color: var(--muted); }
.text { margin: 0; font-size: 15px; line-height: 1.5; }
.card button { align-self: flex-end; padding: 4px 12px; font-size: 13px; border: 1px solid var(--border); background: var(--card); border-radius: 6px; cursor: pointer; }
.card button:hover { border-color: var(--accent); color: var(--accent); }
.empty { color: var(--muted); font-size: 14px; }
</style>
```

- [ ] **Step 4: 删除 AlertPanel 与 SuggestionBar**

用 DeleteFile 删除：
- `packages/dashboard/src/components/AlertPanel.vue`
- `packages/dashboard/src/__tests__/AlertPanel.test.ts`
- `packages/dashboard/src/components/SuggestionBar.vue`
- `packages/dashboard/src/__tests__/SuggestionBar.test.ts`

（App.vue 在 Task 11 已不再引用它们；AlertPanel.test.ts 一并消除既有基线失败。）

- [ ] **Step 5: 运行 dashboard 测试**

Run: `pnpm --filter @classroom/dashboard exec vitest run`
Expected: PASS（无 AlertPanel/SuggestionBar 残留引用）

- [ ] **Step 6: Commit**

```bash
git add -A packages/dashboard/src
git commit -m "feat(dashboard): AIPanel 建议卡竖排大卡样式，移除 AlertPanel/SuggestionBar（dashboard-v2 Task 13）"
```

---

### 【第二期】Task 16: ChartsRow 四图表（完成度关注集卡 + 错误分布 + 状态饼 + 节奏折线）

> 一期不执行本任务（spec 决策 #17：四图表用户尚未确认最终形态）。二期开工前先复审本任务与 spec §3/§6。
> **决策 #18 警示**：完成度卡原"关注集/通过率"设计基于题目全集与累计口径**已失效**——exerciseProgress 已收缩为当天涌现三态（无 total/passRate/avgAttempts），完成度卡需按新口径重新设计；错误分布/状态饼/节奏三卡不受影响（数据源 aggregates/students/trend 未变，但本任务的测试 fixture 需按新 ExerciseProgressItem 类型重写）。

**Files:**
- Create: `packages/dashboard/src/components/ChartsRow.vue`
- Modify: `packages/dashboard/src/App.vue`（接入 ChartsRow + 模板加 `<ChartsRow />`）
- Modify: `packages/dashboard/src/style.css`（追加 `.charts-row { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 12px; }`）
- Test: `packages/dashboard/src/__tests__/ChartsRow.test.ts`（新建）

**Interfaces:**
- Consumes: store.snapshot 的 `aggregates` / `students`（statusCounts 三项口径） / `trend` / `exerciseProgress`（完成度卡数据源）
- Produces: 完成度卡 = 关注集视图（spec 决策 #16）：头部关注集通过率大数字 + 未全员通过题的四色堆叠柱 + 已全员通过题折叠摘要

- [ ] **Step 0: 接入 App 与全局样式**

App.vue 加 import `ChartsRow` 并在 `<main>` 之后、`<StudentDrawer />` 之前插入 `<ChartsRow />`；style.css 追加：

```css
.charts-row { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 12px; }
```

- [ ] **Step 1: 写失败测试 `packages/dashboard/src/__tests__/ChartsRow.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import ChartsRow from "../components/ChartsRow.vue";
import { makeSnapshot, mountWithStore } from "./helpers";
import type { AggItem, ExerciseProgressItem, StudentState, StatusColor } from "@classroom/shared";

/** jsdom 无原生 canvas，chart.js 初始化会抛 unhandled rejection；测试只断言 DOM，mock 掉 chart.js */
vi.mock("chart.js", () => {
  class MockChart {
    static register = vi.fn();
    data = { labels: [] as string[], datasets: [{ data: [] as number[] }] };
    update = vi.fn();
    destroy = vi.fn();
  }
  const stub = class {};
  return {
    Chart: MockChart,
    BarController: stub, BarElement: stub, PieController: stub, ArcElement: stub,
    LineController: stub, PointElement: stub, CategoryScale: stub, LinearScale: stub,
    Tooltip: stub, Legend: stub,
  };
});

const aggregates: AggItem[] = [
  { subtype: "缺少冒号", category: "语法错误", knowledge: "k", count: 8, students: [] },
];
const students: StudentState[] = [
  { studentId: "s1", studentName: "张三", status: "red" as StatusColor, priorityScore: 70, lastActivityAt: 1, lastErrorAt: 1, errorCountTotal: 1, recentErrors: [] },
  { studentId: "s2", studentName: "李四", status: "idle" as StatusColor, priorityScore: 0, lastActivityAt: null, lastErrorAt: null, errorCountTotal: 0, recentErrors: [] },
];
const exerciseProgress: ExerciseProgressItem[] = [
  { id: "week1/hello.py", displayName: "hello.py", isProject: false, total: 4, passed: 2, stuck: 1, unreviewed: 0, notStarted: 1, passRate: 0.5, avgAttempts: 1 },
  { id: "week2/done.py", displayName: "done.py", isProject: false, total: 4, passed: 4, stuck: 0, unreviewed: 0, notStarted: 0, passRate: 1, avgAttempts: 1 },
];

describe("ChartsRow（底部图表行，spec dashboard-v2 §3⑤）", () => {
  it("四卡标题渲染（作业完成度堆叠柱在第一张）", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({ aggregates, students, exerciseProgress, trend: [{ tStart: 1, runs: 2, errors: 1 }] }));
    await wrapper.vm.$nextTick();
    const titles = wrapper.findAll("h2").map((h) => h.text());
    expect(titles).toEqual(["作业完成度", "错误类型分布", "全班状态占比", "课堂节奏"]);
  });

  it("完成度卡关注集（spec 决策 #16）：未全员通过的题入柱 + 通过率头部；全部通过的折叠摘要", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({ aggregates, students, exerciseProgress, trend: [{ tStart: 1, runs: 2, errors: 1 }] }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("全班通过率");
    expect(wrapper.text()).toContain("50%");                    // 仅 hello.py（done.py 折叠不计）
    expect(wrapper.text()).toContain("另有 1 题已全部通过");
  });

  it("全部作业已全员通过：完成度卡显示完成文案", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({
      aggregates, students,
      exerciseProgress: [{ id: "a.py", displayName: "a.py", isProject: false, total: 4, passed: 4, stuck: 0, unreviewed: 0, notStarted: 0, passRate: 1, avgAttempts: 1 }],
      trend: [{ tStart: 1, runs: 2, errors: 1 }],
    }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("全部作业已完成");
  });

  it("有数据时渲染四块 canvas（chart.js 已 mock）；无数据卡片显示空态文案", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({ aggregates, students, exerciseProgress, trend: [{ tStart: 1, runs: 2, errors: 1 }] }));
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("canvas")).toHaveLength(4);
    const empty = mountWithStore(ChartsRow);
    empty.store.applySnapshot(makeSnapshot());
    await empty.wrapper.vm.$nextTick();
    expect(empty.wrapper.text()).toContain("暂无题目数据");
    expect(empty.wrapper.text()).toContain("暂无错误数据");
    expect(empty.wrapper.text()).toContain("暂无学生数据");
    expect(empty.wrapper.text()).toContain("暂无运行数据");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/dashboard exec vitest run src/__tests__/ChartsRow.test.ts`
Expected: FAIL（ChartsRow.vue 尚不存在）

- [ ] **Step 3: 实现 `ChartsRow.vue`**

```vue
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, watch, nextTick, ref } from "vue";
import { Chart, BarController, BarElement, PieController, ArcElement, LineController, PointElement, CategoryScale, LinearScale, Tooltip, Legend } from "chart.js";
import { useClassroom } from "../stores/classroom";

Chart.register(BarController, BarElement, PieController, ArcElement, LineController, PointElement, CategoryScale, LinearScale, Tooltip, Legend);

const store = useClassroom();
const completionRef = ref<HTMLCanvasElement | null>(null);
const barRef = ref<HTMLCanvasElement | null>(null);
const pieRef = ref<HTMLCanvasElement | null>(null);
const lineRef = ref<HTMLCanvasElement | null>(null);
let completionChart: Chart | null = null;
let barChart: Chart | null = null;
let pieChart: Chart | null = null;
let lineChart: Chart | null = null;

const statusCounts = computed(() => {
  const counts = { red: 0, yellow: 0, normal: 0 };
  for (const s of store.snapshot?.students ?? []) {
    if (s.status === "red") counts.red++;
    else if (s.status === "yellow") counts.yellow++;
    else counts.normal++;   // green + idle 都算正常（spec 决策 #15）
  }
  return counts;
});

// —— 完成度卡关注集（spec 决策 #16）：只显示未全员通过的题 ——
const allItems = computed(() => store.snapshot?.exerciseProgress ?? []);
const activeItems = computed(() => allItems.value.filter((e) => e.passed < e.total));
const doneCount = computed(() => allItems.value.length - activeItems.value.length);
const overall = computed(() => {
  const passedSum = activeItems.value.reduce((s, i) => s + i.passed, 0);
  const totalSum = activeItems.value.reduce((s, i) => s + i.total, 0);
  return totalSum === 0 ? 0 : Math.round((passedSum / totalSum) * 100);
});
const completionEmpty = computed(() =>
  allItems.value.length === 0 ? "暂无题目数据" : "全部作业已完成");

// 四卡各自独立 init/update：某卡无数据时不阻塞其余卡片
function initCompletion() {
  if (completionChart || !completionRef.value) return;
  completionChart = new Chart(completionRef.value, {
    type: "bar",
    data: {
      labels: [],
      datasets: [
        { label: "已通过", data: [], backgroundColor: "#22c55e", stack: "s" },
        { label: "未通过", data: [], backgroundColor: "#ef4444", stack: "s" },
        { label: "待评审", data: [], backgroundColor: "#3b82f6", stack: "s" },
        { label: "未开始", data: [], backgroundColor: "#9ca3af", stack: "s" },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom" } },
      scales: {
        x: { stacked: true, ticks: { maxRotation: 45, minRotation: 45 } },
        y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } },
      },
    },
  });
}
function initBar() {
  if (barChart || !barRef.value) return;
  barChart = new Chart(barRef.value, {
    type: "bar",
    data: { labels: [], datasets: [{ label: "涉及人数", data: [], backgroundColor: "#2563eb", borderRadius: 6, barPercentage: 0.6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } }, x: { ticks: { maxRotation: 45, minRotation: 45 } } },
    },
  });
}
function initPie() {
  if (pieChart || !pieRef.value) return;
  pieChart = new Chart(pieRef.value, {
    type: "pie",
    data: {
      labels: ["卡住", "有错误", "正常"],
      datasets: [{ data: [0, 0, 0], backgroundColor: ["#ef4444", "#f59e0b", "#22c55e"] }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right" } } },
  });
}
function initLine() {
  if (lineChart || !lineRef.value) return;
  lineChart = new Chart(lineRef.value, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "运行", data: [], borderColor: "#2563eb", backgroundColor: "#2563eb22", tension: 0.3, fill: true },
        { label: "错误", data: [], borderColor: "#ef4444", backgroundColor: "#ef444422", tension: 0.3, fill: true },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom" } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
    },
  });
}

function updateCharts() {
  const snap = store.snapshot;
  if (!snap) return;
  if (completionChart) {
    completionChart.data.labels = activeItems.value.map((e) => e.displayName);
    completionChart.data.datasets[0].data = activeItems.value.map((e) => e.passed);
    completionChart.data.datasets[1].data = activeItems.value.map((e) => e.stuck);
    completionChart.data.datasets[2].data = activeItems.value.map((e) => e.unreviewed);
    completionChart.data.datasets[3].data = activeItems.value.map((e) => e.notStarted);
    completionChart.update();
  }
  if (barChart) {
    barChart.data.labels = snap.aggregates.map((g) => `${g.category} · ${g.subtype}`);
    barChart.data.datasets[0].data = snap.aggregates.map((g) => g.count);
    barChart.update();
  }
  if (pieChart) {
    pieChart.data.datasets[0].data = [statusCounts.value.red, statusCounts.value.yellow, statusCounts.value.normal];
    pieChart.update();
  }
  if (lineChart) {
    lineChart.data.labels = snap.trend.map((b) => new Date(b.tStart).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }));
    lineChart.data.datasets[0].data = snap.trend.map((b) => b.runs);
    lineChart.data.datasets[1].data = snap.trend.map((b) => b.errors);
    lineChart.update();
  }
}

onMounted(async () => {
  await nextTick();
  initCompletion(); initBar(); initPie(); initLine();
  updateCharts();
});
onBeforeUnmount(() => { completionChart?.destroy(); barChart?.destroy(); pieChart?.destroy(); lineChart?.destroy(); });
watch(
  () => store.snapshot,
  async () => {
    await nextTick();   // 等待 v-else 渲染出 canvas
    initCompletion(); initBar(); initPie(); initLine();
    updateCharts();
  },
  { deep: true },
);
</script>

<template>
  <section class="charts-row" v-if="store.snapshot">
    <div class="chart-card completion">
      <div class="comp-head">
        <h2>作业完成度</h2>
        <span class="overall">全班通过率 <strong>{{ overall }}%</strong></span>
      </div>
      <p v-if="!activeItems.length" class="empty">{{ completionEmpty }}</p>
      <div v-else class="chart-wrap"><canvas ref="completionRef" /></div>
      <p v-if="doneCount > 0" class="done-note">另有 {{ doneCount }} 题已全部通过</p>
    </div>
    <div class="chart-card">
      <h2>错误类型分布</h2>
      <p v-if="!store.snapshot.aggregates.length" class="empty">暂无错误数据</p>
      <div v-else class="chart-wrap"><canvas ref="barRef" /></div>
    </div>
    <div class="chart-card">
      <h2>全班状态占比</h2>
      <p v-if="!store.snapshot.students.length" class="empty">暂无学生数据</p>
      <div v-else class="chart-wrap"><canvas ref="pieRef" /></div>
    </div>
    <div class="chart-card">
      <h2>课堂节奏（每 5 分钟）</h2>
      <p v-if="!store.snapshot.trend.length" class="empty">暂无运行数据</p>
      <div v-else class="chart-wrap"><canvas ref="lineRef" /></div>
    </div>
  </section>
</template>

<style scoped>
.chart-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
.chart-card h2 { margin: 0 0 8px; font-size: 18px; }
.completion .comp-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
.completion .overall { font-size: 12px; color: var(--muted); }
.completion .overall strong { font-size: 22px; color: var(--brand); margin-left: 4px; font-variant-numeric: tabular-nums; }
.done-note { margin: 6px 0 0; font-size: 12px; color: var(--muted); }
.chart-wrap { height: 240px; }
.empty { color: var(--muted); font-size: 14px; }
</style>
```

注意：`class="charts-row"` 的网格样式已在 Step 0 写入全局 `style.css`（完成度卡 2 倍宽 `2fr 1fr 1fr 1fr`）。

- [ ] **Step 5: 运行 dashboard 测试**

Run: `pnpm --filter @classroom/dashboard exec vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A packages/dashboard/src
git commit -m "feat(dashboard): ChartsRow 完成度关注集卡与四图表（dashboard-v2 二期 Task 16）"
```

---

### Task 14: StudentDrawer 当天事件流【第一期】

**Files:**
- Modify: `packages/dashboard/src/components/StudentDrawer.vue`
- Test: `packages/dashboard/src/__tests__/StudentDrawer.test.ts`

**Interfaces:**
- Consumes: `/api/student/:id` 已由 Task 9 做当天过滤（前端只负责去掉按天分组）

- [ ] **Step 1: 追加失败测试**

在 `StudentDrawer.test.ts` 的第一个用例后追加：

```ts
  it("本节课事件流：不按天分组，标题含「本节课」", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => detail }));
    const { wrapper, store } = mountWithStore(StudentDrawer);
    store.applySnapshot(makeSnapshot({ students }));
    store.openDrawer("stu001");
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".day-group").exists()).toBe(false);
    expect(wrapper.text()).toContain("本节课");
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/dashboard exec vitest run src/__tests__/StudentDrawer.test.ts`
Expected: FAIL（仍按天分组）

- [ ] **Step 3: 实现 StudentDrawer 改动**

script 删除 `groupedEvents` computed 与 `computed` import（`ref/watch` 保留）。template 改两处：

meta 行（标题加「本节课」措辞）：

```html
      <p v-if="store.activeStudent" class="meta">
        本节课动态 · 停留：{{ fmtAgo(store.activeStudent.lastActivityAt) }}
      </p>
```

事件列表改平铺（删除 day-group 循环层）：

```html
      <div v-if="detail" class="history-wrapper">
        <ul class="history">
          <li v-for="(e, i) in detail.events" :key="i" :class="{ success: e.success }">
            <span class="t">{{ fmtTime(e.ts) }}</span>
            <strong>{{ e.success ? "运行成功" : (e.subtype ?? "") }}</strong>
            <span class="k">{{ e.knowledge ?? "" }}</span>
            <code>{{ e.rawMessage }}</code>
            <pre v-if="e.codeSnippet" class="snippet">{{ e.codeSnippet }}</pre>
          </li>
        </ul>
      </div>
```

style 删除 `.day-group` / `.day-header` 规则，status 样式追加：

```css
.status.idle { background: #f3f4f6; color: #6b7280; }
```

- [ ] **Step 4: 运行 dashboard 测试**

Run: `pnpm --filter @classroom/dashboard exec vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/components/StudentDrawer.vue packages/dashboard/src/__tests__/StudentDrawer.test.ts
git commit -m "feat(dashboard): 抽屉本节课单日事件流（dashboard-v2 Task 14）"
```

---

### Task 15: 全量构建与测试收尾【第一期】

**Files:** 无新改动（只验证 + 修复回归）

- [ ] **Step 1: 全量构建**

Run: `pnpm -r build`
Expected: shared/server/dashboard 三包全部编译通过（server 为 tsc --noEmit；dashboard 为 vue-tsc -b && vite build）

- [ ] **Step 2: 全量测试**

Run: `pnpm -r test`
Expected: 全部 PASS（含既有 stateManager/aggregator/routes/integration 套件）

- [ ] **Step 3: 手动冒烟（可选但推荐）**

Run: `pnpm dev:server` 后浏览器打开 `http://localhost:3000/`（需本地 GITEA_* 环境变量才会拉题目目录；无则题目面板为事件涌现降级模式）：
1. 主视图顶栏显示日期/时钟/统计大数字；矩阵显示花名册全班（无事件学生灰显）；一期无图表行（决策 #17）
2. `#/admin`：维持纯花名册管理
3. 用 `tools/simulator.js`（或手工 POST /api/events）注入 edit/run 事件 → 矩阵/AI 建议联动；`/api/summary` 可见 exerciseProgress/trend/stats 数据已就位（图表 UI 二期接入）
4. 空数据各模块显示空态文案

- [ ] **Step 4: Commit（如有回归修复）**

```bash
git add -A
git commit -m "chore: dashboard-v2 全量构建与测试收尾"
```

---

## 验收对照（spec §10 测试要点 → 任务）

| spec 测试要点 | 任务 |
|---|---|
| aggregator idle 四态判定；窗口边界（恰好等于当天起点计入） | Task 2/4 |
| dayStart 当天 00:00 计算；跨午夜归属 | Task 2 |
| review_results pass/fail/unreviewed 三态落行、写入失败不阻塞、缓存表约束不变 | Task 6/10 |
| ExerciseCatalog 分类规则/排除/match/失败保留旧目录/空目录降级 | 已取消（决策 #18，Task 3 废弃） |
| ExerciseProgress（当天涌现）：事件生格、latest 翻转、unreviewed 不覆盖强信号、run 失败置 fail、list(dayStart) 当天题目/格子过滤、三态计数、每题 total/passRate（花名册分母，装配层注入，决策 #20）、回放仅当天行、无学生名单 | Task 7/9/10 |
| trend 跨桶落桶、当天预热重建 | Task 8/9 |
| edit touchActivity 幂等命中不触发、lastActivityAt 单调 | Task 5/9 |
| 抽屉事件列表按当天窗口过滤（spec §4.2） | Task 9/14 |
| 完成度卡等四图表 | 【二期】Task 16（完成度卡待按 #18 重设计） |
| 矩阵全班显示（花名册空记录合并）、未在线 online=false 变暗标识（StatusColor 保持三值，决策 #19）、图例三项+未在线计数 | Task 9/12 |
| StatusBar 三统计无「已通过评审」（决策 #18）；抽屉单日；删除 AlertPanel.test.ts；AI 建议独占右栏；ErrorAggPanel 一期下线；管理页零改动 | Task 11-14 |
| 既有套件快照断言随 V2 字段更新 | Task 4/9/15 |
