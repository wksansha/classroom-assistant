# 大屏科技荧光风改版 + 四图表（二期 Task 16）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主视图换科技荧光深色皮肤（星空渐变底 + 发光描边卡 + 四角折角标），并落地二期四图表 ChartsRow（完成度关注集堆叠柱 / 错误分布 / 状态占比环 / 课堂节奏双线）。

**Architecture:** 纯 dashboard 前端包改造。共享主题 tokens 与 `.tech-card` 卡片规范写入 `style.css`（作用域限定 `.app` 主视图，`#/admin` 亮色现状不动）；StatusBar/StudentMatrix/AIPanel/StudentDrawer 四组件改 scoped 样式与少量模板重排（文案零变化）；新建 ChartsRow 组件消费一期快照字段 `exerciseProgress`/`aggregates`/`students`/`trend`，chart.js 按需注册、四卡独立刷新互不阻塞。

**Tech Stack:** Vue 3 + Pinia + chart.js 4（已在 dependencies）+ vitest + @vue/test-utils（jsdom 无 canvas，测试 mock chart.js）。

**Spec:** docs/superpowers/specs/2026-11-04-tech-theme-charts-design.md（含决策记录 #1-#8；执行者须同时读 spec 与本计划）

## Global Constraints

- 服务端 / packages/shared / 学生端扩展零改动；快照协议一期已就位（`exerciseProgress`/`trend`/`stats`）
- 文案零变化：「课堂教学实时助教 / 全班状态 / 在线 / 急需帮助 / 未在线 / 教学建议 / 本节课动态」等全部沿用
- 深色主题作用域限定 `.app` 主视图容器；`#/admin`（AdminView、登录卡、花名册面板、提交矩阵）亮色现状不动
- 状态饼仅统计 `online === true` 学生三值（spec 决策 #4）；未在线不入饼
- 完成度卡按当天涌现口径：关注集 = `passed < total`，无 notStarted/avgAttempts（spec 决策 #5，决策 #18/#20）
- 无星空粒子、无扫描线动画等动效（spec 决策 #2），纯静态发光
- chart.js tooltip 用内置（不自定义 HTML tooltip）；按需 register
- 测试命令：`pnpm --filter @classroom/dashboard exec vitest run <file>`；全量 `pnpm -r test`
- 共享 DTO 已有类型锚点：`StudentState`（含 `online`/`machineCount`）、`ExerciseProgressItem`（passed/stuck/unreviewed/total/passRate，**无 notStarted**）、`TrendBucket`、`ClassStats`、`AggItem`（含 knowledge 字段）
- 现有组件测试均为文案级断言（已核实 StatusBar/StudentMatrix/AIPanel.test.ts），模板重排不破坏；改动后重跑对应套件确认

---

### Task 1: 主题 tokens + App 深色底 + StatusBar 科技化

**Files:**
- Modify: `packages/dashboard/src/style.css`（文件末尾追加）
- Modify: `packages/dashboard/src/components/StatusBar.vue`
- Test: `packages/dashboard/src/__tests__/StatusBar.test.ts`（只跑不改）

**Interfaces:**
- Produces（后续所有任务消费的主题类）:
  - `.app` 上定义 tokens：`--tech-card-grad`、`--tech-card-border`、`--tech-card-glow`、`--tech-cyan`、`--tech-blue`、`--tech-red`、`--tech-yellow`、`--tech-green`、`--tech-offline`、`--text-primary`、`--text-secondary`、`--text-dim`
  - `.app .tech-card`：发光描边卡 + 四角折角标（子组件根元素直接挂 `tech-card` class）
  - `.app .tech-title`：居中发光标题 + 两侧 `››› ‹‹‹` 装饰（伪元素实现，子组件 h2 直接挂）

- [ ] **Step 1: `style.css` 末尾追加主题块**

```css
/* —— 科技荧光风主题（spec 2026-11-04 §3；作用域限定主视图 .app，admin 域不受影响）—— */
.app {
  --tech-card-grad: linear-gradient(180deg, rgba(16, 42, 80, 0.55), rgba(8, 20, 42, 0.75));
  --tech-card-border: rgba(63, 140, 255, 0.45);
  --tech-card-glow: 0 0 14px rgba(30, 100, 220, 0.25), inset 0 0 24px rgba(30, 90, 200, 0.12);
  --tech-corner: #7ce7ff;
  --tech-cyan: #7ce7ff;
  --tech-blue: #3fa9ff;
  --tech-red: #ff5f6d;
  --tech-yellow: #ffc53d;
  --tech-green: #22c55e;
  --tech-offline: rgba(90, 120, 160, 0.25);
  --text-primary: #d8ecff;
  --text-secondary: #9fd4ff;
  --text-dim: #5d7fa6;
  min-height: 100vh;
  color: var(--text-primary);
  /* 星空渐变底 + 两层 36px 网格纹理（spec §4.6；多背景分层避免伪元素遮挡内容） */
  background:
    linear-gradient(rgba(56, 132, 255, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(56, 132, 255, 0.05) 1px, transparent 1px),
    radial-gradient(1200px 500px at 50% -100px, #0b1e3a 0%, #060d1a 55%, #04070d 100%);
  background-size: 36px 36px, 36px 36px, auto;
}
.app .tech-card {
  position: relative;
  background: var(--tech-card-grad);
  border: 1px solid var(--tech-card-border);
  border-radius: 2px;
  box-shadow: var(--tech-card-glow);
}
.app .tech-card::before,
.app .tech-card::after {
  content: ""; position: absolute; width: 10px; height: 10px;
  border: 2px solid var(--tech-corner);
}
.app .tech-card::before { top: -2px; left: -2px; border-right: none; border-bottom: none; }
.app .tech-card::after { bottom: -2px; right: -2px; border-left: none; border-top: none; }
.app .tech-title {
  margin: 0; display: flex; align-items: center; justify-content: center; gap: 8px;
  text-align: center; color: var(--text-secondary); font-size: 14px; font-weight: 700;
  letter-spacing: 3px; text-shadow: 0 0 8px rgba(80, 160, 255, 0.7);
}
.app .tech-title::before { content: "›››"; color: #2f6fce; font-size: 9px; letter-spacing: 0; }
.app .tech-title::after { content: "‹‹‹"; color: #2f6fce; font-size: 9px; letter-spacing: 0; }
```

- [ ] **Step 2: 重写 `StatusBar.vue`（模板重排：统计左 / 标题中 / 元信息右，文案不变）**

template 整体替换为：

```vue
<template>
  <header class="status-bar">
    <div class="stats">
      <div class="stat"><span class="num">{{ stats.online }}</span><span class="label">在线 / {{ stats.total }} 人</span></div>
      <div class="stat warn"><span class="num">{{ stats.needHelp }}</span><span class="label">急需帮助</span></div>
      <div class="stat"><span class="num">{{ stats.runs }}</span><span class="label">运行次数</span></div>
    </div>
    <h1>课堂教学实时助教</h1>
    <div class="meta">
      <span class="date">{{ dateText }}</span>
      <span class="clock">{{ clock }}</span>
      <span class="conn" :class="store.sseConnected ? 'on' : 'off'">
        {{ store.sseConnected ? "已连接" : "连接中断，重试中…" }}
      </span>
    </div>
  </header>
</template>
```

`<style scoped>` 整体替换为：

```css
.status-bar {
  position: relative; display: flex; align-items: center; justify-content: space-between;
  gap: 16px; padding: 10px 20px 14px;
  background: var(--tech-card-grad); border: 1px solid var(--tech-card-border);
  border-radius: 2px; box-shadow: var(--tech-card-glow); overflow: hidden;
}
.status-bar::after {
  content: ""; position: absolute; bottom: 0; left: 6%; right: 6%; height: 2px;
  background: linear-gradient(90deg, transparent, var(--tech-blue) 20%, var(--tech-cyan) 50%, var(--tech-blue) 80%, transparent);
  box-shadow: 0 0 10px rgba(80, 180, 255, 0.9);
}
.status-bar h1 {
  margin: 0; font-size: 20px; font-weight: 800; letter-spacing: 6px; white-space: nowrap;
  color: var(--text-primary); text-shadow: 0 0 14px rgba(64, 156, 255, 0.9), 0 0 30px rgba(64, 156, 255, 0.5);
}
.stats { display: flex; gap: 12px; }
.stat {
  display: flex; align-items: baseline; gap: 5px; padding: 3px 10px;
  background: rgba(20, 50, 100, 0.4); border: 1px solid rgba(63, 140, 255, 0.3); border-radius: 2px;
}
.stat .num { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--tech-cyan); text-shadow: 0 0 8px rgba(80, 220, 255, 0.8); }
.stat .label { font-size: 12px; color: var(--text-dim); white-space: nowrap; }
.stat.warn .num { color: var(--tech-red); text-shadow: 0 0 8px rgba(255, 95, 109, 0.8); }
.meta { display: flex; align-items: center; gap: 10px; }
.date { font-size: 12px; color: var(--text-dim); white-space: nowrap; }
.clock { font-size: 12px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.conn { font-size: 12px; white-space: nowrap; }
.conn.on { color: var(--tech-green); }
.conn.off { color: var(--tech-red); }
```

`<script setup>` 不动。

- [ ] **Step 3: 跑 StatusBar 测试确认零破坏**

Run: `pnpm --filter @classroom/dashboard exec vitest run src/__tests__/StatusBar.test.ts`
Expected: PASS（现有断言纯文案级：标题、42、2、月、冒号）

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/style.css packages/dashboard/src/components/StatusBar.vue
git commit -m "feat(dashboard): 科技荧光主题 tokens + App 星空网格底 + StatusBar 科技化（tech-theme Task 1）"
```

---

### Task 2: StudentMatrix 深色化（tech-card + 深色瓦片 + 图例下移居中）

**Files:**
- Modify: `packages/dashboard/src/components/StudentMatrix.vue`
- Test: `packages/dashboard/src/__tests__/StudentMatrix.test.ts`（只跑不改）

**Interfaces:**
- Consumes: Task 1 的 `.tech-card`、`.tech-title`、tokens
- Produces: 矩阵图例结构调整为「标题行 → 图例行」两行（`.counts` 从 `.header` 内移出），文案与 class 名不变

- [ ] **Step 1: 修改 template（仅结构调整，文案零变化）**

```vue
<template>
  <section class="matrix tech-card" v-if="store.snapshot">
    <h2 class="tech-title">全班状态</h2>
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
        <span v-if="s.machineCount >= 2" class="machine-badge" :title="`${s.machineCount} 台电脑在线`">×{{ s.machineCount }}</span>
      </div>
    </div>
    <p v-else class="empty">等待学生上报…</p>
  </section>
</template>
```

- [ ] **Step 2: `<style scoped>` 整体替换**

```css
.matrix { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.counts { display: flex; gap: 14px; font-size: 13px; justify-content: center; }
.counts .red { color: var(--tech-red); text-shadow: 0 0 6px rgba(255, 95, 109, 0.6); }
.counts .yellow { color: var(--tech-yellow); text-shadow: 0 0 6px rgba(255, 197, 61, 0.5); }
.counts .green { color: var(--tech-green); text-shadow: 0 0 6px rgba(34, 197, 94, 0.5); }
.counts .off-legend { color: var(--text-dim); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
.tile {
  display: flex; align-items: center; gap: 6px; padding: 12px 10px;
  border: 1px solid var(--tech-card-border); border-radius: 2px; cursor: pointer;
  font-size: 16px; position: relative;
  background: rgba(20, 50, 100, 0.4); color: var(--text-primary);
}
.tile:hover { border-color: var(--tech-cyan); }
.tile.red { border-color: rgba(255, 95, 109, 0.6); }
.tile.yellow { border-color: rgba(255, 197, 61, 0.5); }
.tile.green { border-color: rgba(34, 197, 94, 0.5); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.tile.red .dot { background: var(--tech-red); box-shadow: 0 0 8px rgba(255, 95, 109, 0.9); }
.tile.yellow .dot { background: var(--tech-yellow); box-shadow: 0 0 8px rgba(255, 197, 61, 0.7); }
.tile.green .dot { background: var(--tech-green); box-shadow: 0 0 8px rgba(34, 197, 94, 0.7); }
.tile.offline { opacity: 0.45; background: var(--tech-offline); }
.tile.offline .dot { background: #5d7fa6; box-shadow: none; }
.machine-badge {
  position: absolute; top: -6px; right: -6px;
  background: var(--tech-blue); color: #04070d; font-size: 11px; line-height: 1;
  padding: 3px 5px; border-radius: 8px; font-weight: 700;
}
.empty { color: var(--text-dim); font-size: 13px; text-align: center; }
```

（原 `.header` 容器与旧亮色规则整体删除。）

- [ ] **Step 3: 跑 StudentMatrix 测试确认零破坏**

Run: `pnpm --filter @classroom/dashboard exec vitest run src/__tests__/StudentMatrix.test.ts`
Expected: PASS（tile class 名、offline、machine-badge、图例文案全部未变）

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/components/StudentMatrix.vue
git commit -m "feat(dashboard): StudentMatrix 科技化——深色瓦片发光圆点+图例居中（tech-theme Task 2）"
```

---

### Task 3: AIPanel 深色化（青色 AI 徽标 + 深色建议卡）

**Files:**
- Modify: `packages/dashboard/src/components/AIPanel.vue`
- Test: `packages/dashboard/src/__tests__/AIPanel.test.ts`（只跑不改）

**Interfaces:**
- Consumes: Task 1 的 `.tech-card`、tokens
- Produces: 无（仅样式）

- [ ] **Step 1: template 根节点挂 tech-card**

`<section class="ai-panel" v-if="store.snapshot">` 改为 `<section class="ai-panel tech-card" v-if="store.snapshot">`，其余 template 不动。

- [ ] **Step 2: `<style scoped>` 整体替换**

```css
.ai-panel { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.panel-head { display: flex; align-items: center; justify-content: center; gap: 8px; }
.ai-badge {
  background: rgba(63, 169, 255, 0.2); color: var(--tech-cyan);
  border: 1px solid var(--tech-blue);
  font-size: 12px; font-weight: 700; border-radius: 2px; padding: 2px 8px;
  letter-spacing: 2px; text-shadow: 0 0 8px rgba(80, 220, 255, 0.8);
}
.ai-panel h2 { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: 3px; color: var(--text-secondary); text-shadow: 0 0 8px rgba(80, 160, 255, 0.7); }
.card {
  display: flex; flex-direction: column; align-items: stretch; gap: 6px;
  background: rgba(20, 50, 100, 0.4); border: 1px solid rgba(63, 140, 255, 0.25);
  border-left: 4px solid var(--tech-blue);
  border-radius: 2px; padding: 12px; margin-bottom: 2px;
}
.card.class-review { border-left-color: var(--tech-red); }
.card.group-discuss { border-left-color: var(--tech-yellow); }
.card.individual { border-left-color: var(--tech-green); }
.kind-tag { font-size: 12px; color: var(--text-dim); }
.text { margin: 0; font-size: 15px; line-height: 1.5; color: var(--text-primary); }
.card button {
  align-self: flex-end; padding: 4px 12px; font-size: 13px; cursor: pointer;
  border: 1px solid rgba(63, 140, 255, 0.4); background: transparent; color: var(--text-secondary);
  border-radius: 2px;
}
.card button:hover { border-color: var(--tech-cyan); color: var(--tech-cyan); }
.empty { color: var(--text-dim); font-size: 14px; text-align: center; }
```

- [ ] **Step 3: 跑 AIPanel 测试确认零破坏**

Run: `pnpm --filter @classroom/dashboard exec vitest run src/__tests__/AIPanel.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/components/AIPanel.vue
git commit -m "feat(dashboard): AIPanel 科技化——青色 AI 徽标+深色建议卡（tech-theme Task 3）"
```

---

### Task 4: StudentDrawer 深色化

**Files:**
- Modify: `packages/dashboard/src/components/StudentDrawer.vue`
- Test: `packages/dashboard/src/__tests__/StudentDrawer.test.ts`（只跑不改）

**Interfaces:**
- Consumes: Task 1 tokens（Drawer 是 `position: fixed` 全屏遮罩层，不在 `.tech-card` 体系内，但可使用 `.app` 上定义的 tokens）
- Produces: 无（仅样式）

- [ ] **Step 1: `<style scoped>` 整体替换（template/script 不动）**

```css
.drawer-mask { position: fixed; inset: 0; background: rgba(2, 6, 12, 0.6); display: flex; justify-content: flex-end; z-index: 10; }
.drawer {
  width: 380px; height: 100%; padding: 16px; overflow-y: auto;
  background: linear-gradient(180deg, #0c1d38, #060d1a);
  border-left: 1px solid var(--tech-card-border);
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.5);
  color: var(--text-primary);
}
header { display: flex; align-items: center; gap: 8px; }
header h3 { margin: 0; flex: 1; font-size: 16px; }
.status { font-size: 12px; padding: 2px 8px; border-radius: 2px; }
.status.red { background: rgba(255, 95, 109, 0.12); color: var(--tech-red); }
.status.yellow { background: rgba(255, 197, 61, 0.12); color: var(--tech-yellow); }
.status.green { background: rgba(34, 197, 94, 0.12); color: var(--tech-green); }
.status.idle { background: var(--tech-offline); color: var(--text-dim); }
.close { border: none; background: none; font-size: 20px; cursor: pointer; color: var(--text-dim); }
.close:hover { color: var(--text-primary); }
.meta { color: var(--text-dim); font-size: 13px; }
.history-wrapper { margin: 12px 0; }
.history { list-style: none; padding: 0; margin: 0; }
.history li { padding: 8px 0; border-bottom: 1px solid rgba(63, 140, 255, 0.2); display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.history li.success { color: var(--tech-green); }
.history .t { color: var(--text-dim); font-size: 12px; }
.history .k { color: var(--text-dim); }
.history code { font-size: 12px; color: var(--tech-cyan); word-break: break-all; }
.history .snippet { margin: 6px 0; padding: 8px; background: rgba(20, 50, 100, 0.4); border-radius: 2px; font-size: 11px; color: var(--text-primary); white-space: pre-wrap; word-break: break-all; }
```

- [ ] **Step 2: 跑 StudentDrawer 测试确认零破坏**

Run: `pnpm --filter @classroom/dashboard exec vitest run src/__tests__/StudentDrawer.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/components/StudentDrawer.vue
git commit -m "feat(dashboard): StudentDrawer 深色化——发光边线抽屉（tech-theme Task 4）"
```

---

### Task 5: ChartsRow 四图表（新建 + App 接入）

**Files:**
- Create: `packages/dashboard/src/components/ChartsRow.vue`
- Modify: `packages/dashboard/src/App.vue`（接入）
- Modify: `packages/dashboard/src/style.css`（追加 `.charts-row` 网格）
- Test: `packages/dashboard/src/__tests__/ChartsRow.test.ts`（新建）

**Interfaces:**
- Consumes: store.snapshot 的 `exerciseProgress`（含 total/passRate）/ `aggregates` / `students`（online+status）/ `trend`
- Produces: ChartsRow 组件（App 骨架引用，无 props/emit）

- [ ] **Step 1: 写失败测试 `packages/dashboard/src/__tests__/ChartsRow.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import ChartsRow from "../components/ChartsRow.vue";
import { makeSnapshot, mountWithStore } from "./helpers";
import type { AggItem, ExerciseProgressItem, StudentState, StatusColor } from "@classroom/shared";

/** jsdom 无原生 canvas，chart.js 初始化会抛错；测试只断言 DOM，mock 掉 chart.js */
vi.mock("chart.js", () => {
  class MockChart {
    static register = vi.fn();
    static defaults: Record<string, unknown> = {};
    data = { labels: [] as string[], datasets: [{ data: [] as number[] }] };
    options: Record<string, unknown> = {};
    update = vi.fn();
    destroy = vi.fn();
  }
  const stub = class {};
  return {
    Chart: MockChart,
    DoughnutController: stub, ArcElement: stub,
    BarController: stub, BarElement: stub,
    LineController: stub, PointElement: stub, Filler: stub,
    CategoryScale: stub, LinearScale: stub,
    Tooltip: stub, Legend: stub,
  };
});

const students: StudentState[] = [
  { studentId: "s1", studentName: "张三", status: "red" as StatusColor, online: true, machineCount: 1, priorityScore: 70, lastActivityAt: 1, lastErrorAt: 1, errorCountTotal: 1, recentErrors: [] },
  { studentId: "s2", studentName: "李四", status: "yellow" as StatusColor, online: true, machineCount: 1, priorityScore: 15, lastActivityAt: 1, lastErrorAt: 1, errorCountTotal: 1, recentErrors: [] },
  { studentId: "s3", studentName: "王五", status: "green" as StatusColor, online: true, machineCount: 1, priorityScore: 0, lastActivityAt: 1, lastErrorAt: null, errorCountTotal: 0, recentErrors: [] },
  { studentId: "s4", studentName: "赵六", status: "green" as StatusColor, online: false, machineCount: 0, priorityScore: 0, lastActivityAt: null, lastErrorAt: null, errorCountTotal: 0, recentErrors: [] },
];
const aggregates: AggItem[] = [
  { subtype: "缺少冒号", category: "语法错误", knowledge: "k", count: 8, students: [] },
];
const exerciseProgress: ExerciseProgressItem[] = [
  { id: "week1/hello.py", displayName: "hello.py", isProject: false, passed: 2, stuck: 1, unreviewed: 1, total: 4, passRate: 0.5 },
  { id: "week2/done.py", displayName: "done.py", isProject: false, passed: 4, stuck: 0, unreviewed: 0, total: 4, passRate: 1 },
];

describe("ChartsRow（底部图表行，spec 2026-11-04 §5）", () => {
  it("四卡标题渲染（完成度在第一张）", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({ students, aggregates, exerciseProgress, trend: [{ tStart: 1, runs: 2, errors: 1 }] }));
    await wrapper.vm.$nextTick();
    const titles = wrapper.findAll("h2").map((h) => h.text());
    expect(titles).toEqual(["作业完成度", "错误类型分布", "全班状态占比", "课堂节奏"]);
  });

  it("完成度卡关注集（spec 决策 #5/#16）：未全员通过的题入柱 + 通过率头部大数字；已全员通过折叠摘要", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({ students, aggregates, exerciseProgress, trend: [{ tStart: 1, runs: 2, errors: 1 }] }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("全班通过率");
    expect(wrapper.text()).toContain("50%");                    // 关注集仅 hello.py：2/4
    expect(wrapper.text()).toContain("另有 1 题已全部通过");      // done.py 折叠
    expect(wrapper.text()).toContain("hello.py");               // 柱标签
  });

  it("全部作业已全员通过：显示完成文案", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({
      students, aggregates,
      exerciseProgress: [{ id: "a.py", displayName: "a.py", isProject: false, passed: 4, stuck: 0, unreviewed: 0, total: 4, passRate: 1 }],
      trend: [{ tStart: 1, runs: 2, errors: 1 }],
    }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("全部作业已完成");
  });

  it("有数据时渲染四块 canvas（chart.js 已 mock）；无数据卡片显示空态文案", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({ students, aggregates, exerciseProgress, trend: [{ tStart: 1, runs: 2, errors: 1 }] }));
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
Expected: FAIL（ChartsRow.vue 不存在）

- [ ] **Step 3: 实现 `packages/dashboard/src/components/ChartsRow.vue`**

```vue
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, watch, nextTick, ref } from "vue";
import {
  Chart, DoughnutController, ArcElement, BarController, BarElement,
  LineController, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler,
} from "chart.js";
import { useClassroom } from "../stores/classroom";

Chart.register(DoughnutController, ArcElement, BarController, BarElement, LineController, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler);
Chart.defaults.color = "#9fd4ff";
Chart.defaults.borderColor = "rgba(63, 140, 255, 0.2)";

const store = useClassroom();
const completionRef = ref<HTMLCanvasElement | null>(null);
const barRef = ref<HTMLCanvasElement | null>(null);
const pieRef = ref<HTMLCanvasElement | null>(null);
const lineRef = ref<HTMLCanvasElement | null>(null);
let completionChart: Chart | null = null;
let barChart: Chart | null = null;
let pieChart: Chart | null = null;
let lineChart: Chart | null = null;

// —— 完成度卡关注集（spec 决策 #5，沿用 V2 决策 #16/#18/#20）——
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

// —— 状态占比（spec 决策 #4：仅统计在线学生三值）——
const statusCounts = computed(() => {
  const counts = { red: 0, yellow: 0, green: 0 };
  for (const s of store.snapshot?.students ?? []) {
    if (!s.online) continue;
    if (s.status === "red") counts.red++;
    else if (s.status === "yellow") counts.yellow++;
    else counts.green++;
  }
  return counts;
});

// 四卡各自独立 init/update：某卡无数据时不阻塞其余卡片（spec §5.5）
function initCompletion() {
  if (completionChart || !completionRef.value) return;
  completionChart = new Chart(completionRef.value, {
    type: "bar",
    data: {
      labels: [],
      datasets: [
        { label: "已通过", data: [], backgroundColor: "#22c55e", stack: "s", borderRadius: 2 },
        { label: "卡住", data: [], backgroundColor: "#ff5f6d", stack: "s", borderRadius: 2 },
        { label: "待评审", data: [], backgroundColor: "#38bdf8", stack: "s", borderRadius: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } },
      scales: {
        x: { stacked: true, ticks: { maxRotation: 45, minRotation: 45 } },
        y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1, precision: 0 } },
      },
    },
  });
}
function initBar() {
  if (barChart || !barRef.value) return;
  barChart = new Chart(barRef.value, {
    type: "bar",
    data: { labels: [], datasets: [{ label: "涉及人数", data: [], backgroundColor: "#38bdf8", borderRadius: 2, barPercentage: 0.6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } }, x: { ticks: { maxRotation: 45, minRotation: 45 } } },
    },
  });
}
function initPie() {
  if (pieChart || !pieRef.value) return;
  pieChart = new Chart(pieRef.value, {
    type: "doughnut",
    data: {
      labels: ["卡住", "有错误", "正常"],
      datasets: [{ data: [0, 0, 0], backgroundColor: ["#ff5f6d", "#ffc53d", "#22c55e"], borderColor: "rgba(63,140,255,0.3)", borderWidth: 1 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "62%",
      plugins: { legend: { position: "right", labels: { boxWidth: 10 } } },
    },
  });
}
function initLine() {
  if (lineChart || !lineRef.value) return;
  lineChart = new Chart(lineRef.value, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "运行", data: [], borderColor: "#7ce7ff", backgroundColor: "rgba(124,231,255,0.15)", tension: 0.3, fill: true, pointRadius: 2 },
        { label: "错误", data: [], borderColor: "#ff5f6d", backgroundColor: "rgba(255,95,109,0.15)", tension: 0.3, fill: true, pointRadius: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } } },
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
    completionChart.update();
  }
  if (barChart) {
    barChart.data.labels = snap.aggregates.map((g) => `${g.category} · ${g.subtype}`);
    barChart.data.datasets[0].data = snap.aggregates.map((g) => g.count);
    barChart.update();
  }
  if (pieChart) {
    pieChart.data.datasets[0].data = [statusCounts.value.red, statusCounts.value.yellow, statusCounts.value.green];
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
    await nextTick();   // 等待空态→有数据切换后渲染出 canvas
    initCompletion(); initBar(); initPie(); initLine();
    updateCharts();
  },
  { deep: true },
);
</script>

<template>
  <section class="charts-row" v-if="store.snapshot">
    <div class="chart-card tech-card completion">
      <div class="comp-head">
        <h2 class="tech-title">作业完成度</h2>
        <span class="overall">全班通过率 <strong>{{ overall }}%</strong></span>
      </div>
      <p v-if="!activeItems.length" class="empty">{{ completionEmpty }}</p>
      <div v-else class="chart-wrap"><canvas ref="completionRef" /></div>
      <p v-if="doneCount > 0" class="done-note">另有 {{ doneCount }} 题已全部通过</p>
    </div>
    <div class="chart-card tech-card">
      <h2 class="tech-title">错误类型分布</h2>
      <p v-if="!store.snapshot.aggregates.length" class="empty">暂无错误数据</p>
      <div v-else class="chart-wrap"><canvas ref="barRef" /></div>
    </div>
    <div class="chart-card tech-card">
      <h2 class="tech-title">全班状态占比</h2>
      <p v-if="!store.snapshot.students.some((s) => s.online)" class="empty">暂无学生数据</p>
      <div v-else class="chart-wrap"><canvas ref="pieRef" /></div>
    </div>
    <div class="chart-card tech-card">
      <h2 class="tech-title">课堂节奏</h2>
      <p v-if="!store.snapshot.trend.length" class="empty">暂无运行数据</p>
      <div v-else class="chart-wrap"><canvas ref="lineRef" /></div>
    </div>
  </section>
</template>

<style scoped>
/* .charts-row 网格定义在全局 style.css（Task 5 Step 5），此处只写卡内样式 */
.chart-card { padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
.chart-card h2 { font-size: 13px; }
.comp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.comp-head .overall { font-size: 12px; color: var(--text-dim); white-space: nowrap; }
.comp-head .overall strong { font-size: 22px; color: var(--tech-cyan); margin-left: 4px; font-variant-numeric: tabular-nums; text-shadow: 0 0 8px rgba(80, 220, 255, 0.8); }
.chart-wrap { height: 240px; position: relative; }
.done-note { margin: 0; font-size: 12px; color: var(--text-dim); text-align: center; }
.empty { margin: auto 0; color: var(--text-dim); font-size: 13px; text-align: center; }
</style>
```

- [ ] **Step 4: App.vue 接入**

`packages/dashboard/src/App.vue`：import 区追加 `import ChartsRow from "./components/ChartsRow.vue";`，template 中 `<main class="main-grid">…</main>` 之后、`<StudentDrawer />` 之前插入 `<ChartsRow />`：

```vue
    <main class="main-grid">
      <StudentMatrix />
      <div class="right-col">
        <AIPanel />
      </div>
    </main>
    <ChartsRow />
    <StudentDrawer />
```

- [ ] **Step 5: style.css 追加网格（紧跟 Task 1 主题块之后）**

```css
/* —— 四图表行（spec 2026-11-04 §4.5）—— */
.app .charts-row { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 12px; align-items: stretch; }
```

（网格样式单一来源：全局 style.css 定义，ChartsRow scoped 内不重复定义。）

- [ ] **Step 6: 运行确认通过 + dashboard 全量回归**

Run: `pnpm --filter @classroom/dashboard exec vitest run src/__tests__/ChartsRow.test.ts && pnpm --filter @classroom/dashboard exec vitest run`
Expected: ChartsRow 全 PASS；全量无回归

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/src/components/ChartsRow.vue packages/dashboard/src/App.vue packages/dashboard/src/style.css packages/dashboard/src/__tests__/ChartsRow.test.ts
git commit -m "feat(dashboard): ChartsRow 四图表（完成度关注集/错误分布/状态环/节奏线）+ App 接入（tech-theme Task 5）"
```

---

### Task 6: 全量构建与测试收尾

**Files:** 无新改动（只验证 + 修复回归）

- [ ] **Step 1: 全量构建**

Run: `pnpm -r build`
Expected: shared/server/dashboard 三包全部编译通过（dashboard 为 vue-tsc -b && vite build）

- [ ] **Step 2: 全量测试**

Run: `pnpm -r test`
Expected: 全部 PASS（含既有 AlertPanel 已删、SuggestionBar 已删后的一期套件）

- [ ] **Step 3: 手动冒烟**

Run: `pnpm dev:server` + `pnpm --filter @classroom/dashboard dev`，浏览器打开本地大屏页：
1. 主视图深色科技风：星空渐变底 + 36px 网格纹理 + 发光描边卡片 + 四角折角标；顶栏标题发光、底部渐变光线
2. 四图表就位：有数据出图、无数据显示空态文案、单卡数据缺失不影响其余卡
3. 状态环不含未在线学生（构造一名 offline 学生验证）
4. 点击矩阵瓦片打开深色抽屉；`#/admin` 亮色现状无变化
5. F11 全屏 1080p 观感确认（无横向滚动、字号可远读）

- [ ] **Step 4: Commit（如有回归修复）**

```bash
git add -A packages/dashboard
git commit -m "chore: 科技荧光风改版与四图表全量收尾"
```

---

## 验收对照（spec §7.2 → 任务）

| spec 验收项 | 任务 |
|---|---|
| 深色科技风：星空底+网格+发光卡+折角标 | Task 1/2/3/5 |
| `#/admin` 亮色现状无变化 | Task 1（tokens 作用域 `.app`）+ Task 6 冒烟 4 |
| 四图表就位与空态 | Task 5 |
| 完成度卡口径（关注集通过率/三色堆叠/折叠摘要） | Task 5 |
| 状态环不含未在线学生 | Task 5（statusCounts 过滤 online） |
| 措辞与一期完全一致 | Task 1-4 文案零变化 + 既有测试守护 |
| `pnpm -r test` 全量通过 | Task 6 |
