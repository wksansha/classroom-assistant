# 课堂教学实时助教系统 V1（上行闭环）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把可运行 demo（`D:\ruan\real-time-assistant-demo`）重构为 pnpm monorepo，实现 V1 上行闭环：学生报错上报 → LLM 解释（三层缓存）→ 课堂状态/聚合/建议计算 → SSE 推送 → 教师仪表盘五模块。

**Architecture:** 三包 monorepo：`@classroom/shared`（类型+纯函数，零运行时依赖）、`@classroom/server`（Express 5 + TS，内存为课堂状态唯一事实源，SQLite 持久化事件与解释缓存，事件触发全量重算后经 teacherHub SSE 广播）、`@classroom/dashboard`（Vue3 + Pinia，纯服务端快照的镜像，不算业务逻辑）。LLM 输出三字段 `{category, subtype, knowledge}`，缓存 key 不含代码，同一错误全班共享一条解释。

**Tech Stack:** Node.js ≥ 20、TypeScript 5（strict）、pnpm workspace、Express 5、better-sqlite3、vitest、tsx（server 开发与运行均走 tsx，不做 tsc 产物构建）、Vue 3 + Vite + Pinia、SSE

**Spec:** [docs/superpowers/specs/2026-09-17-classroom-dashboard-design.md](../specs/2026-09-17-classroom-dashboard-design.md)（计划从 spec 立论，执行者须同时读 spec）

## Global Constraints

（每个 Task 的隐含要求，来自 spec，逐字引用）

- 后端 Node.js/Express + TypeScript；三端通过 `packages/shared` 共享类型，契约只有一份（spec §3）
- 教师端前后端分离 Vue3 + Vite，构建产物由 server 静态托管（spec §3）
- 实时推送用 SSE，不用 WebSocket（spec §3、§10）
- 内存为课堂状态主存储，SQLite 持久化事件/缓存；服务重启课堂状态清零可接受（spec §3、§8）
- 缓存 key 均不含代码：run = `error_type + error_message`；diag = 样本文本（spec §5）
- LLM 输出 JSON：`{"category":"<分类>","subtype":"<细分类型，6字以内>","knowledge":"<知识点句>"}`，category 限 8 类（spec §5）
- run 事件 category 以静态映射为准；diag 事件三字段全采纳 LLM（spec §5）
- LLM 调用失败或输出无法解析 → mock 兜底，按关键词输出同结构三字段（spec §8）
- 前端不做业务逻辑，全部服务端算（spec §10）
- 时间显示一律 `new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })`（spec §7）
- V1 不做：认证/多班级管理、发提示/任务/匿名投屏、离线判定（从未上报或超时无事件一律视为绿色「顺利」）（spec §10、§5）
- 环境变量沿用 demo：`LLM_API_KEY` / `LLM_BASE_URL`（默认 `https://api.openai.com/v1`）/ `LLM_MODEL`（默认 `gpt-4o-mini`）（demo llm.js）

## 代码基线：demo 迁移映射

执行者可从 demo（`D:\ruan\real-time-assistant-demo`）抄逻辑，改造点如下：

| demo 文件 | 去向（本计划 Task） | 改造要点 |
|---|---|---|
| `llm.js` 的分类规则注释 | Task 1 `errorCategories.ts` | 变成静态映射函数 |
| `llm.js` 的 buildPrompt | Task 2 `prompts.ts` | 换成 spec §5 新模板，输出三字段 |
| `db.js` | Task 4 `persistence.ts` | 表字段 explanation/suggestion → subtype/knowledge；加 exit_code 列；改为工厂函数支持 `:memory:` 测试 |
| `server.js` normalizeEvent() | Task 5 `eventIngress.ts` | TS 化 + 新增 runSuccess 识别 + cacheKey 内聚 |
| `llm.js` 的 mockClassify | Task 6 `llm.ts` | 三字段同结构 + 关键词表 |
| `cache.js` | Task 7 `cache.ts` | 三层结构原样；值类型改 Explanation |
| （无） | Task 8 `explainService/index.ts` | 新建：分类取用规则 |
| （无） | Task 9 `stateManager.ts` | 新建：内存状态 |
| （无） | Task 10/11 `aggregator.ts` | 新建：状态色/分数/聚合/建议 |
| `server.js` SSE 部分 | Task 12 `teacherHub.ts`（后半） | 逐事件广播 → 快照+更新 |
| `public/dashboard.html` | Task 14–19 dashboard（后半） | 只参考交互，代码不迁移 |
| `simulator.js` | Task 20 `tools/simulator.js`（后半） | 补 runSuccess 模拟与 `--students=N` |

## 工程结构（最终形态）

```
classroom-assistant/
├── pnpm-workspace.yaml
├── package.json                      # 根 scripts 汇总
├── tsconfig.base.json
├── packages/
│   ├── shared/                       # @classroom/shared
│   │   └── src/
│   │       ├── errorCategories.ts    # Task 1
│   │       ├── prompts.ts            # Task 2
│   │       ├── events.ts             # Task 3（类型）
│   │       ├── dto.ts                # Task 3（类型）
│   │       ├── index.ts
│   │       └── __tests__/
│   ├── server/                       # @classroom/server
│   │   └── src/
│   │       ├── persistence.ts        # Task 4
│   │       ├── eventIngress.ts       # Task 5
│   │       ├── explainService/
│   │       │   ├── llm.ts            # Task 6
│   │       │   ├── cache.ts          # Task 7
│   │       │   └── index.ts          # Task 8
│   │       ├── stateManager.ts       # Task 9
│   │       ├── aggregator.ts         # Task 10/11
│   │       ├── teacherHub.ts         # Task 12（后半）
│   │       ├── index.ts              # Task 13（后半）
│   │       └── __tests__/
│   └── dashboard/                    # @classroom/dashboard（Task 14–19，后半）
├── tools/simulator.js                # Task 20（后半）
└── docs/
```

## 任务总览

**前半（Task 1–11）**：monorepo + shared 包 + server 端全部核心逻辑（到 aggregator 完成）。
**后半（Task 12–22）**：teacherHub、路由接线与集成测试、dashboard 五组件、模拟器、learner runSuccess 小改、部署文档。

---

### Task 1: monorepo 脚手架 + shared 静态分类映射

**Files:**
- Create: `pnpm-workspace.yaml`、`package.json`（根）、`tsconfig.base.json`、`.gitignore`
- Create: `packages/shared/package.json`、`packages/shared/tsconfig.json`、`packages/shared/src/index.ts`
- Create: `packages/shared/src/errorCategories.ts`
- Test: `packages/shared/src/__tests__/errorCategories.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `categoryFor(errorType?: string | null): ErrorCategory`；`type ErrorCategory = '语法错误' | '名称错误' | '类型错误' | '运算错误' | '容器访问错误' | '属性导入错误' | '文件权限错误' | '其他'`（Task 8 使用）

- [ ] **Step 1: 写 workspace 脚手架（本任务的前置设置，随本任务交付）**

若仓库没有 `.git` 目录，先 `git init`。然后创建以下文件：

`pnpm-workspace.yaml`：

```yaml
packages:
  - "packages/*"
```

`package.json`（根）：

```json
{
  "name": "classroom-assistant",
  "private": true,
  "scripts": {
    "dev:server": "pnpm --filter @classroom/server dev",
    "dev:dashboard": "pnpm --filter @classroom/dashboard dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test"
  }
}
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true
  }
}
```

`.gitignore`：

```
node_modules/
dist/
*.db
*.db-wal
*.db-shm
.env
```

`packages/shared/package.json`：

```json
{
  "name": "@classroom/shared",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

`packages/shared/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"]
}
```

`packages/shared/src/index.ts`（先留一行，后续任务追加导出）：

```ts
export * from "./errorCategories";
```

Run: `pnpm install`
Expected: 安装成功，无 workspace 报错。

- [ ] **Step 2: 写失败测试**

`packages/shared/src/__tests__/errorCategories.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { categoryFor } from "../errorCategories";

describe("categoryFor：error_type → 8 分类静态映射", () => {
  it("语法错误", () => {
    expect(categoryFor("SyntaxError")).toBe("语法错误");
    expect(categoryFor("IndentationError")).toBe("语法错误");
    expect(categoryFor("TabError")).toBe("语法错误");
  });
  it("名称错误", () => {
    expect(categoryFor("NameError")).toBe("名称错误");
  });
  it("类型错误", () => {
    expect(categoryFor("TypeError")).toBe("类型错误");
    expect(categoryFor("ValueError")).toBe("类型错误");
  });
  it("运算错误", () => {
    expect(categoryFor("ZeroDivisionError")).toBe("运算错误");
    expect(categoryFor("OverflowError")).toBe("运算错误");
  });
  it("容器访问错误", () => {
    expect(categoryFor("IndexError")).toBe("容器访问错误");
    expect(categoryFor("KeyError")).toBe("容器访问错误");
  });
  it("属性导入错误", () => {
    expect(categoryFor("AttributeError")).toBe("属性导入错误");
    expect(categoryFor("ImportError")).toBe("属性导入错误");
    expect(categoryFor("ModuleNotFoundError")).toBe("属性导入错误");
  });
  it("文件权限错误", () => {
    expect(categoryFor("FileNotFoundError")).toBe("文件权限错误");
    expect(categoryFor("PermissionError")).toBe("文件权限错误");
  });
  it("未知或缺失 → 其他", () => {
    expect(categoryFor("WhateverError")).toBe("其他");
    expect(categoryFor(undefined)).toBe("其他");
    expect(categoryFor("")).toBe("其他");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @classroom/shared test`
Expected: FAIL，报错 `Cannot find module '../errorCategories'`（或等价的模块不存在错误）。

- [ ] **Step 4: 最小实现**

`packages/shared/src/errorCategories.ts`：

```ts
export type ErrorCategory =
  | "语法错误"
  | "名称错误"
  | "类型错误"
  | "运算错误"
  | "容器访问错误"
  | "属性导入错误"
  | "文件权限错误"
  | "其他";

const MAP: Record<string, ErrorCategory> = {
  SyntaxError: "语法错误",
  IndentationError: "语法错误",
  TabError: "语法错误",
  NameError: "名称错误",
  TypeError: "类型错误",
  ValueError: "类型错误",
  ZeroDivisionError: "运算错误",
  OverflowError: "运算错误",
  IndexError: "容器访问错误",
  KeyError: "容器访问错误",
  AttributeError: "属性导入错误",
  ImportError: "属性导入错误",
  ModuleNotFoundError: "属性导入错误",
  FileNotFoundError: "文件权限错误",
  PermissionError: "文件权限错误",
};

export function categoryFor(errorType?: string | null): ErrorCategory {
  return (errorType && MAP[errorType]) || "其他";
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @classroom/shared test`
Expected: PASS（8 个用例全绿）。

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json .gitignore packages/shared
git commit -m "feat(shared): monorepo 脚手架与 error_type 静态分类映射"
```

---

### Task 2: shared 提示词模板（字段缺失自动降级）

**Files:**
- Create: `packages/shared/src/prompts.ts`
- Modify: `packages/shared/src/index.ts`（追加导出）
- Test: `packages/shared/src/__tests__/prompts.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `buildExplainPrompt(input: ExplainInput): string`；`interface ExplainInput { errorType: string; errorMessage: string; codeLine?: string; fullCode?: string }`（Task 6 的 callLLM 使用）

- [ ] **Step 1: 写失败测试**

`packages/shared/src/__tests__/prompts.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { buildExplainPrompt } from "../prompts";

const base = { errorType: "ZeroDivisionError", errorMessage: "division by zero" };

describe("buildExplainPrompt（spec §5 模板，learner 不上报代码时自动降级）", () => {
  it("基础字段：8 分类约束 + 输出 JSON 格式 + 错误信息", () => {
    const p = buildExplainPrompt(base);
    expect(p).toContain('{"category":"<分类>","subtype":"<细分类型，6字以内>","knowledge":"<知识点句>"}');
    expect(p).toContain("语法错误 / 名称错误 / 类型错误 / 运算错误 / 容器访问错误 / 属性导入错误 / 文件权限错误 / 其他");
    expect(p).toContain("错误类型：ZeroDivisionError");
    expect(p).toContain("错误信息：division by zero");
  });
  it("无代码上下文时降级：不含代码段", () => {
    const p = buildExplainPrompt(base);
    expect(p).not.toContain("出错代码行");
    expect(p).not.toContain("完整代码");
  });
  it("仅有 codeLine：含出错代码行，不含完整代码", () => {
    const p = buildExplainPrompt({ ...base, codeLine: "print(a / b)" });
    expect(p).toContain("出错代码行：print(a / b)");
    expect(p).not.toContain("完整代码");
  });
  it("有 fullCode：含完整代码段", () => {
    const p = buildExplainPrompt({ ...base, codeLine: "print(a / b)", fullCode: "a = 0\nprint(a / b)" });
    expect(p).toContain("完整代码：");
    expect(p).toContain("a = 0");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/shared test`
Expected: FAIL，`Cannot find module '../prompts'`。

- [ ] **Step 3: 最小实现**

`packages/shared/src/prompts.ts`：

```ts
export interface ExplainInput {
  errorType: string;
  errorMessage: string;
  codeLine?: string;
  fullCode?: string;
}

export function buildExplainPrompt(input: ExplainInput): string {
  const lines: string[] = [
    "你是一位 Python 教学助手。请分析学生的错误，输出 JSON：",
    '{"category":"<分类>","subtype":"<细分类型，6字以内>","knowledge":"<知识点句>"}',
    "",
    "分类 category 必须从以下 8 类中选择：",
    "语法错误 / 名称错误 / 类型错误 / 运算错误 / 容器访问错误 / 属性导入错误 / 文件权限错误 / 其他",
    "",
    "要求：",
    "- knowledge 面向初学者，说清 (1) 是什么知识点的问题 (2) 学生最可能哪里没懂，20 字左右，不要堆术语",
    '- subtype 是这个错误的具体类型标签，例如"缺少冒号""意外缩进""除数为0""未定义变量"',
    "- 只输出 JSON，不要解释",
    "",
    `错误类型：${input.errorType}`,
    `错误信息：${input.errorMessage}`,
  ];
  if (input.codeLine) lines.push(`出错代码行：${input.codeLine}`);
  if (input.fullCode) lines.push(`完整代码：\n${input.fullCode}`);
  return lines.join("\n");
}
```

`packages/shared/src/index.ts` 追加：

```ts
export * from "./prompts";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/shared test`
Expected: PASS（Task 1 + Task 2 全部用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/prompts.ts packages/shared/src/index.ts packages/shared/src/__tests__/prompts.test.ts
git commit -m "feat(shared): LLM 解释提示词模板，代码上下文缺失自动降级"
```

---

### Task 3: shared 事件与 DTO 类型（events.ts + dto.ts）

类型定义无运行时逻辑，验证方式为编译通过（`tsc --noEmit`）。这些类型是后续所有任务的契约，必须最先锁定。

**Files:**
- Create: `packages/shared/src/events.ts`、`packages/shared/src/dto.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: 无
- Produces（后续任务全部依赖，逐字使用）：
  - `FlatReport`（learner 上报的 flat 格式）、`NormalizedEvent`（服务端全链路统一事件）、`Explanation`（LLM 解释三字段）
  - `TeacherSnapshot / StudentState / AlertItem / AggItem / SuggestionItem / RecentError / StatusColor / SSEMessage`

- [ ] **Step 1: 写 events.ts**

`packages/shared/src/events.ts`：

```ts
/** learner 上报的 flat 格式（vscode-pylearner reporter.ts buildPayload 的产物） */
export interface FlatReport {
  student_id: string;
  student_name: string;
  class_id: string;
  timestamp: string;
  event_type: "diag" | "run";
  raw_message?: string;
  samples?: string[];
  error_type?: string;
  error_message?: string;
  command?: string;
  exit_code?: number;
  file_path?: string;
  line_no?: number;
  source?: string;
}

/** LLM 解释结果（spec §5 三字段，缓存值同构） */
export interface Explanation {
  category: string;
  subtype: string;
  knowledge: string;
}

/** eventIngress.normalize 的输出，服务端全链路统一用这个 */
export interface NormalizedEvent {
  studentId: string;
  studentName: string;
  classId: string;
  eventType: "diag" | "run";
  /** run 且 exit_code === 0 */
  success: boolean;
  /** run 报错时的 Python 异常名；diag 为 null（error_type 是写死的占位） */
  errorType: string | null;
  errorMessage: string | null;
  /** diag 原始样本 */
  samples: string[];
  /** 展示用：diag 取首样本；run 取 error_message */
  rawMessage: string;
  /** run: `${error_type}: ${error_message}`；diag: 最短样本；成功事件为 null */
  cacheKey: string | null;
  command?: string;
  exitCode?: number;
  filePath?: string;
  lineNo?: number;
  /** epoch ms */
  ts: number;
}
```

- [ ] **Step 2: 写 dto.ts**

`packages/shared/src/dto.ts`：

```ts
export type StatusColor = "green" | "yellow" | "red";

export interface RecentError {
  ts: number;
  subtype: string;
  knowledge: string;
  rawMessage: string;
}

export interface StudentState {
  studentId: string;
  studentName: string;
  status: StatusColor;
  priorityScore: number;
  lastActivityAt: number | null;
  lastErrorAt: number | null;
  errorCountTotal: number;
  /** 最近 3 条错误，新的在前（矩阵悬停用） */
  recentErrors: RecentError[];
}

export interface AlertItem {
  studentId: string;
  studentName: string;
  score: number;
  reason: string;
  subtype: string;
  knowledge: string;
  lastErrorAt: number;
}

export interface AggItem {
  subtype: string;
  category: string;
  knowledge: string;
  /** 涉及人数（不是事件数） */
  count: number;
  students: { studentId: string; studentName: string }[];
}

export type SuggestionKind = "class-review" | "group-discuss" | "individual";

export interface SuggestionItem {
  /** 稳定 id（ack 用）：class-review:{subtype} / group-discuss:{subtype} / individual:{排序后 studentId 逗号拼接} */
  id: string;
  kind: SuggestionKind;
  text: string;
  acked: boolean;
}

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
}

export type SSEMessage =
  | { type: "snapshot"; data: TeacherSnapshot }
  | { type: "update"; data: TeacherSnapshot };
```

- [ ] **Step 3: 追加导出并编译验证**

`packages/shared/src/index.ts`：

```ts
export * from "./errorCategories";
export * from "./prompts";
export * from "./events";
export * from "./dto";
```

Run: `pnpm --filter @classroom/shared build`
Expected: `tsc --noEmit` 无错误。再跑 `pnpm --filter @classroom/shared test` 确认旧用例仍绿。

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/events.ts packages/shared/src/dto.ts packages/shared/src/index.ts
git commit -m "feat(shared): L1/flat 事件类型、解释三字段与教师端 DTO 契约"
```

---

### Task 4: server 包骨架 + persistence（SQLite）

**Files:**
- Create: `packages/server/package.json`、`packages/server/tsconfig.json`
- Create: `packages/server/src/persistence.ts`
- Test: `packages/server/src/__tests__/persistence.test.ts`

**Interfaces:**
- Consumes: `Explanation`（@classroom/shared，Task 3）
- Produces:
  - `createPersistence(dbPath?: string): Persistence`（缺省 `data/assistant.db`，测试传 `:memory:`）
  - `interface Persistence { upsertStudent(id, name, classId): void; insertEvent(row: EventRow): void; getRecentEvents(limit: number): any[]; getEventStats(): { total: number; todayCount: number; byCategory: { category: string; count: number }[] }; getCachedExplanation(rawHash: string): Explanation | null; saveCache(rawHash: string, rawMessage: string, exp: Explanation, source: string): void; getCacheStats(): { total: number; totalHits: number } }`
  - `interface EventRow { studentId: string; classId: string; eventType: "diag" | "run"; rawMessage: string; category: string; subtype: string | null; knowledge: string | null; filePath: string | null; lineNo: number | null; exitCode: number | null; timestamp: string }`（Task 13 组装）

- [ ] **Step 1: server 包骨架（随本任务交付）**

`packages/server/package.json`：

```json
{
  "name": "@classroom/server",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "build": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@classroom/shared": "workspace:*",
    "better-sqlite3": "^13.0.3",
    "cors": "^2.8.6",
    "dotenv": "^17.4.2",
    "express": "^5.2.1",
    "tsx": "^4.19.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/cors": "^2.8.17",
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

`packages/server/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

Run: `pnpm install`
Expected: 安装成功（better-sqlite3 原生模块编译通过；失败则 `pnpm rebuild better-sqlite3`）。

- [ ] **Step 2: 写失败测试**

`packages/server/src/__tests__/persistence.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createPersistence, type EventRow } from "../persistence";

const exp = { category: "运算错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" };

const errorRow: EventRow = {
  studentId: "stu001", classId: "3A", eventType: "run",
  rawMessage: "division by zero", category: "运算错误",
  subtype: "除数为0", knowledge: "除法运算：除数不能为 0",
  filePath: "a.py", lineNo: 30, exitCode: 1,
  timestamp: "2026-09-17T02:00:00.000Z",
};

describe("persistence（SQLite，:memory:）", () => {
  let p: ReturnType<typeof createPersistence>;
  beforeEach(() => { p = createPersistence(":memory:"); });

  it("upsertStudent 幂等，重复调用不报错", () => {
    p.upsertStudent("stu001", "张三", "3A");
    p.upsertStudent("stu001", "张三", "3A");
  });

  it("insertEvent → getRecentEvents 读回，字段完整", () => {
    p.insertEvent(errorRow);
    const rows = p.getRecentEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].student_id).toBe("stu001");
    expect(rows[0].category).toBe("运算错误");
    expect(rows[0].subtype).toBe("除数为0");
    expect(rows[0].exit_code).toBe(1);
  });

  it("runSuccess 事件：category 存「运行成功」，subtype/knowledge 为空", () => {
    p.insertEvent({ ...errorRow, rawMessage: "run success", category: "运行成功", subtype: null, knowledge: null, exitCode: 0 });
    const row = p.getRecentEvents(1)[0];
    expect(row.category).toBe("运行成功");
    expect(row.subtype).toBeNull();
  });

  it("error_cache：save → 命中读回 → 命中计数累计", () => {
    p.saveCache("hash1", "ZeroDivisionError: division by zero", exp, "llm");
    expect(p.getCachedExplanation("hash1")).toEqual(exp);
    p.getCachedExplanation("hash1");
    expect(p.getCacheStats().totalHits).toBe(2);
    expect(p.getCachedExplanation("nope")).toBeNull();
  });

  it("getEventStats 按 category 分组降序", () => {
    p.insertEvent(errorRow);
    p.insertEvent({ ...errorRow, rawMessage: "x", category: "语法错误", subtype: "缺少冒号", knowledge: "k" });
    p.insertEvent({ ...errorRow, rawMessage: "y", category: "运算错误", subtype: "除数为0", knowledge: "k" });
    const stats = p.getEventStats();
    expect(stats.total).toBe(3);
    expect(stats.byCategory[0]).toEqual({ category: "运算错误", count: 2 });
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL，`Cannot find module '../persistence'`。

- [ ] **Step 4: 最小实现**

`packages/server/src/persistence.ts`：

```ts
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Explanation } from "@classroom/shared";

export interface EventRow {
  studentId: string;
  classId: string;
  eventType: "diag" | "run";
  rawMessage: string;
  category: string;
  subtype: string | null;
  knowledge: string | null;
  filePath: string | null;
  lineNo: number | null;
  exitCode: number | null;
  timestamp: string;
}

export interface Persistence {
  upsertStudent(id: string, name: string, classId: string): void;
  insertEvent(row: EventRow): void;
  getRecentEvents(limit: number): any[];
  getEventStats(): { total: number; todayCount: number; byCategory: { category: string; count: number }[] };
  getCachedExplanation(rawHash: string): Explanation | null;
  saveCache(rawHash: string, rawMessage: string, exp: Explanation, source: string): void;
  getCacheStats(): { total: number; totalHits: number };
}

export function createPersistence(dbPath?: string): Persistence {
  const file = dbPath ?? path.join(process.cwd(), "data", "assistant.db");
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      class_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      class_id TEXT,
      event_type TEXT NOT NULL CHECK(event_type IN ('diag','run')),
      raw_message TEXT NOT NULL,
      category TEXT NOT NULL,
      subtype TEXT,
      knowledge TEXT,
      file_path TEXT,
      line_no INTEGER,
      exit_code INTEGER,
      timestamp DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_events_student ON events(student_id);
    CREATE INDEX IF NOT EXISTS idx_events_class_time ON events(class_id, timestamp);
    CREATE TABLE IF NOT EXISTS error_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_hash TEXT UNIQUE NOT NULL,
      raw_message TEXT NOT NULL,
      category TEXT NOT NULL,
      subtype TEXT NOT NULL,
      knowledge TEXT NOT NULL,
      source TEXT DEFAULT 'llm',
      hit_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cache_hash ON error_cache(raw_hash);
  `);

  return {
    upsertStudent(id, name, classId) {
      db.prepare("INSERT INTO students (id, name, class_id) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = ?, class_id = ?")
        .run(id, name, classId, name, classId);
    },
    insertEvent(r) {
      db.prepare(`INSERT INTO events (student_id, class_id, event_type, raw_message, category, subtype, knowledge, file_path, line_no, exit_code, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(r.studentId, r.classId, r.eventType, r.rawMessage, r.category, r.subtype, r.knowledge, r.filePath, r.lineNo, r.exitCode, r.timestamp);
    },
    getRecentEvents(limit) {
      return db.prepare("SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ?").all(limit);
    },
    getEventStats() {
      const total = (db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
      const byCategory = db.prepare("SELECT category, COUNT(*) AS count FROM events GROUP BY category ORDER BY count DESC").all();
      const today = new Date().toISOString().slice(0, 10);
      const todayCount = (db.prepare("SELECT COUNT(*) AS c FROM events WHERE DATE(timestamp) = ?").get(today) as { c: number }).c;
      return { total, todayCount, byCategory };
    },
    getCachedExplanation(rawHash) {
      const row = db.prepare("SELECT category, subtype, knowledge FROM error_cache WHERE raw_hash = ?").get(rawHash) as Explanation | undefined;
      if (!row) return null;
      db.prepare("UPDATE error_cache SET hit_count = hit_count + 1 WHERE raw_hash = ?").run(rawHash);
      return { category: row.category, subtype: row.subtype, knowledge: row.knowledge };
    },
    saveCache(rawHash, rawMessage, exp, source) {
      db.prepare(`INSERT INTO error_cache (raw_hash, raw_message, category, subtype, knowledge, source)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(raw_hash) DO UPDATE SET raw_message = excluded.raw_message, category = excluded.category,
          subtype = excluded.subtype, knowledge = excluded.knowledge, source = excluded.source, updated_at = CURRENT_TIMESTAMP`)
        .run(rawHash, rawMessage, exp.category, exp.subtype, exp.knowledge, source);
    },
    getCacheStats() {
      const total = (db.prepare("SELECT COUNT(*) AS c FROM error_cache").get() as { c: number }).c;
      const totalHits = (db.prepare("SELECT COALESCE(SUM(hit_count), 0) AS c FROM error_cache").get() as { c: number }).c;
      return { total, totalHits };
    },
  };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS（5 个用例全绿）。

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(server): SQLite 持久化（students/events/error_cache，新三字段缓存结构）"
```

---

### Task 5: eventIngress（L1/flat 双格式标准化 + runSuccess 识别）

**Files:**
- Create: `packages/server/src/eventIngress.ts`
- Test: `packages/server/src/__tests__/eventIngress.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent`（@classroom/shared，Task 3）
- Produces: `normalize(body: unknown): NormalizedEvent | null`（null = 缺 student_id 或 event_type，路由层回 400；Task 13 使用）

- [ ] **Step 1: 写失败测试**

`packages/server/src/__tests__/eventIngress.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { normalize } from "../eventIngress";

const TS = "2026-09-17T02:00:00.000Z";

describe("normalize：L1 / flat 双格式 → NormalizedEvent", () => {
  it("L1 run 报错：cacheKey = error_type + error_message", () => {
    const ev = normalize({
      surface: "run", kind: "execution_error", ts: TS,
      payload: {
        student_id: "stu001", student_name: "张三", class_id: "3A",
        source: "terminal", command: "python a.py", exit_code: 1,
        error_type: "ZeroDivisionError", error_message: "division by zero",
        file: "a.py", line: 30,
      },
    });
    expect(ev).toMatchObject({
      studentId: "stu001", studentName: "张三", classId: "3A",
      eventType: "run", success: false, errorType: "ZeroDivisionError",
      cacheKey: "ZeroDivisionError: division by zero",
      filePath: "a.py", lineNo: 30, ts: Date.parse(TS),
    });
  });

  it("L1 diag：errorType 为 null，cacheKey 取最短样本", () => {
    const ev = normalize({
      surface: "diag", kind: "diagnostic", ts: TS,
      payload: {
        student_id: "stu001", student_name: "张三", class_id: "3A",
        file: "a.py", errors: 1, warnings: 0,
        samples: ["name 'x' is not defined", "x"],
      },
    });
    expect(ev).toMatchObject({
      eventType: "diag", success: false, errorType: null,
      cacheKey: "x", rawMessage: "name 'x' is not defined",
    });
  });

  it("flat run 报错（reporter.ts 格式）", () => {
    const ev = normalize({
      student_id: "stu002", student_name: "李四", class_id: "3A",
      timestamp: TS, event_type: "run",
      raw_message: "division by zero", error_type: "ZeroDivisionError",
      error_message: "division by zero", command: "python a.py",
      exit_code: 1, file_path: "a.py", line_no: 30, source: "terminal",
    });
    expect(ev).toMatchObject({
      studentId: "stu002", eventType: "run", success: false,
      cacheKey: "ZeroDivisionError: division by zero",
    });
  });

  it("flat runSuccess（error_type=RunSuccess, exit_code=0）：success=true，cacheKey=null", () => {
    const ev = normalize({
      student_id: "stu002", student_name: "李四", class_id: "3A",
      timestamp: TS, event_type: "run", raw_message: "run success",
      error_type: "RunSuccess", error_message: "", exit_code: 0,
    });
    expect(ev).toMatchObject({ eventType: "run", success: true, cacheKey: null });
  });

  it("缺学生字段：兜底 unknown/default", () => {
    const ev = normalize({ surface: "run", kind: "execution_error", ts: TS, payload: { error_type: "NameError", error_message: "x" } });
    expect(ev).toMatchObject({ studentId: "unknown", classId: "default" });
  });

  it("无效上报（无 surface/payload 也无 event_type）：返回 null", () => {
    expect(normalize({ foo: 1 })).toBeNull();
    expect(normalize({ event_type: "run" })).toBeNull(); // 有 event_type 但无 student_id
  });
});
```

注意最后一个用例：`event_type: "run"` 但没有 `student_id` —— normalize 对 flat 格式兜底 `unknown`，因此它不是 null。修正断言为：`expect(normalize({ event_type: "run" })).toMatchObject({ studentId: "unknown" })`，只保留 `{ foo: 1 }` → null 的断言（无效 = 既不是 L1 也不是 flat 结构）。**以修正后的断言为准**：

```ts
  it("无效上报：既非 L1 也非 flat 结构 → null", () => {
    expect(normalize({ foo: 1 })).toBeNull();
    expect(normalize(null)).toBeNull();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL，`Cannot find module '../eventIngress'`。

- [ ] **Step 3: 最小实现**

`packages/server/src/eventIngress.ts`：

```ts
import type { NormalizedEvent } from "@classroom/shared";

type AnyBody = Record<string, any>;

export function normalize(body: unknown): NormalizedEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as AnyBody;
  const ts = toMs(b.ts ?? b.timestamp);

  // L1 格式（simulator）：{ surface, kind, ts, payload }
  if (b.surface && b.payload) {
    const p = b.payload as AnyBody;
    if (b.surface !== "diag" && b.surface !== "run") return null;
    const eventType = b.surface;
    const exitCode = typeof p.exit_code === "number" ? p.exit_code : undefined;
    const success = eventType === "run" && exitCode === 0;
    const samples: string[] = Array.isArray(p.samples) ? p.samples : [];
    const errorType = eventType === "diag" ? null : (p.error_type ?? null);
    return {
      studentId: p.student_id ?? b.student_id ?? "unknown",
      studentName: p.student_name ?? b.student_name ?? p.student_id ?? b.student_id ?? "unknown",
      classId: p.class_id ?? b.class_id ?? "default",
      eventType,
      success,
      errorType,
      errorMessage: eventType === "diag" ? samples.join("; ") : (p.error_message ?? null),
      samples,
      rawMessage: eventType === "diag" ? (samples[0] ?? "") : (p.error_message ?? ""),
      cacheKey: extractCacheKey(eventType, success, errorType, p.error_message, samples),
      command: p.command,
      exitCode,
      filePath: p.file ?? p.file_path,
      lineNo: p.line,
      ts,
    };
  }

  // flat 格式（reporter.ts）
  if (b.event_type === "diag" || b.event_type === "run") {
    const eventType = b.event_type;
    const exitCode = typeof b.exit_code === "number" ? b.exit_code : undefined;
    const success = eventType === "run" && (exitCode === 0 || b.error_type === "RunSuccess");
    const samples: string[] = Array.isArray(b.samples) ? b.samples : [];
    const errorType = eventType === "diag" ? null : (b.error_type ?? null);
    return {
      studentId: b.student_id ?? "unknown",
      studentName: b.student_name ?? b.student_id ?? "unknown",
      classId: b.class_id ?? "default",
      eventType,
      success,
      errorType,
      errorMessage: eventType === "diag" ? samples.join("; ") : (b.error_message ?? null),
      samples,
      rawMessage: b.raw_message ?? b.error_message ?? "",
      cacheKey: extractCacheKey(eventType, success, errorType, b.error_message, samples),
      command: b.command,
      exitCode,
      filePath: b.file_path,
      lineNo: b.line_no,
      ts,
    };
  }

  return null;
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
    return samples.length ? [...samples].sort((a, b) => a.length - b.length)[0] : null;
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

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS（Task 4 + Task 5 全部用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/eventIngress.ts packages/server/src/__tests__/eventIngress.test.ts
git commit -m "feat(server): 事件标准化（L1/flat 双格式、runSuccess 识别、cacheKey 规则）"
```

---

### Task 6: LLM 调用（真实 API + JSON 解析 + mock 兜底）

网络调用部分不写单测（依赖外部 API），可测的是纯函数：`parseLLMResponse` 与 `mockExplain`。

**Files:**
- Create: `packages/server/src/explainService/llm.ts`
- Test: `packages/server/src/__tests__/llm.test.ts`

**Interfaces:**
- Consumes: `buildExplainPrompt(input: ExplainInput): string`（@classroom/shared，Task 2）
- Produces: `callLLM(input: ExplainInput): Promise<Explanation>`（无 API_KEY / 失败 / 解析失败一律 mock 兜底）；`parseLLMResponse(text: string): Explanation | null`；`mockExplain(input: ExplainInput): Explanation`（Task 7/8 使用）

- [ ] **Step 1: 写失败测试**

`packages/server/src/__tests__/llm.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { parseLLMResponse, mockExplain } from "../explainService/llm";

describe("parseLLMResponse：从 LLM 文本中提取三字段 JSON", () => {
  it("纯 JSON 直接解析", () => {
    const r = parseLLMResponse('{"category":"运算错误","subtype":"除数为0","knowledge":"除法运算：除数不能为 0"}');
    expect(r).toEqual({ category: "运算错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" });
  });
  it("带前后废话的 JSON 也能提取", () => {
    const r = parseLLMResponse('好的，分析如下：\n{"category":"名称错误","subtype":"未定义变量","knowledge":"变量要先赋值再使用，检查拼写"}\n希望有帮助');
    expect(r?.subtype).toBe("未定义变量");
  });
  it("缺字段 / 非 JSON → null", () => {
    expect(parseLLMResponse("没有任何 JSON")).toBeNull();
    expect(parseLLMResponse('{"category":"运算错误"}')).toBeNull();
    expect(parseLLMResponse('{"category":"运算错误","subtype":"x","knowledge":123}')).toBeNull();
  });
});

describe("mockExplain：关键词兜底（spec §8）", () => {
  const cases: [string, string, string, string, string][] = [
    ["ZeroDivisionError", "division by zero", "运算错误", "除数为0", "除法运算：除数不能为 0"],
    ["IndentationError", "expected an indented block", "语法错误", "缩进或标点错误", "缩进规则：Python 靠缩进划分代码块"],
    ["NameError", "name 'totl' is not defined", "名称错误", "未定义变量", "变量要先赋值再使用，检查拼写"],
    ["DiagnosticError", "应为 \":\"", "语法错误", "缩进或标点错误", "缩进规则：Python 靠缩进划分代码块"],
    ["IndexError", "list index out of range", "容器访问错误", "索引或键越界", "访问前确认容器长度和键名"],
  ];
  it.each(cases)("%s → %s", (errorType, errorMessage, category, subtype, knowledge) => {
    expect(mockExplain({ errorType, errorMessage })).toEqual({ category, subtype, knowledge });
  });
  it("无法匹配 → 其他/未知错误", () => {
    expect(mockExplain({ errorType: "WeirdError", errorMessage: "???" })).toEqual({
      category: "其他", subtype: "未知错误", knowledge: "请检查代码与输入是否正确",
    });
  });
});
```

注意：diag 样本 `应为 ":"` 里含有 `冒号` 关键词吗？不含（样本里没有「冒号」二字）——mock 关键词表必须包含 `应为` 才能命中语法错误。实现时关键词表以 Step 3 为准，本用例 `["DiagnosticError", "应为 \":\"", ...]` 依赖关键词 `应为`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL，`Cannot find module '../explainService/llm'`。

- [ ] **Step 3: 最小实现**

`packages/server/src/explainService/llm.ts`：

```ts
import { buildExplainPrompt, type ExplainInput, type Explanation } from "@classroom/shared";

// ── 配置（沿用 demo 环境变量）─────────────────────────
const API_KEY = process.env.LLM_API_KEY || "";
const BASE_URL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

// ── mock 关键词表（spec §8：LLM 失败时同结构兜底）─────
const MOCK_RULES: { keywords: string[]; exp: Explanation }[] = [
  { keywords: ["indentation", "tab", "syntax", "expected", "应为", "冒号", "缩进"], exp: { category: "语法错误", subtype: "缩进或标点错误", knowledge: "缩进规则：Python 靠缩进划分代码块" } },
  { keywords: ["name", "未定义"], exp: { category: "名称错误", subtype: "未定义变量", knowledge: "变量要先赋值再使用，检查拼写" } },
  { keywords: ["type", "value", "operand"], exp: { category: "类型错误", subtype: "类型不匹配", knowledge: "运算前确认两边类型一致" } },
  { keywords: ["division", "zero", "overflow"], exp: { category: "运算错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" } },
  { keywords: ["index", "key", "range"], exp: { category: "容器访问错误", subtype: "索引或键越界", knowledge: "访问前确认容器长度和键名" } },
  { keywords: ["attribute", "import", "module"], exp: { category: "属性导入错误", subtype: "属性或模块不存在", knowledge: "检查拼写，确认模块已安装" } },
  { keywords: ["file", "permission"], exp: { category: "文件权限错误", subtype: "文件不可用", knowledge: "检查文件路径与权限" } },
];
const MOCK_FALLBACK: Explanation = { category: "其他", subtype: "未知错误", knowledge: "请检查代码与输入是否正确" };

export function mockExplain(input: ExplainInput): Explanation {
  const s = `${input.errorType} ${input.errorMessage}`.toLowerCase();
  return MOCK_RULES.find((r) => r.keywords.some((k) => s.includes(k.toLowerCase())))?.exp ?? MOCK_FALLBACK;
}

export function parseLLMResponse(text: string): Explanation | null {
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o.category !== "string" || typeof o.subtype !== "string" || typeof o.knowledge !== "string") return null;
    return { category: o.category, subtype: o.subtype, knowledge: o.knowledge };
  } catch {
    return null;
  }
}

async function callRealLLM(input: ExplainInput): Promise<Explanation> {
  const resp = await fetch(`${BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: buildExplainPrompt(input) }],
      stream: false,
      temperature: 0.3,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`LLM API error (${resp.status}): ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || "";
  const parsed = parseLLMResponse(content);
  if (!parsed) throw new Error("LLM 输出无法解析为三字段 JSON");
  return parsed;
}

export async function callLLM(input: ExplainInput): Promise<Explanation> {
  if (!API_KEY) return mockExplain(input);
  try {
    return await callRealLLM(input);
  } catch (err) {
    console.error("[LLM] 调用失败，使用 mock 兜底:", err instanceof Error ? err.message : err);
    return mockExplain(input);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS。

- [ ] **Step 5: 手工验证真实调用路径（可选，有 key 才做）**

Run: `$env:LLM_API_KEY="<key>"; pnpm --filter @classroom/server exec tsx -e "import('./src/explainService/llm.js').then(async m => console.log(await m.callLLM({ errorType: 'ZeroDivisionError', errorMessage: 'division by zero' })))"`
Expected: 输出三字段 JSON，category 为「运算错误」。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/explainService/llm.ts packages/server/src/__tests__/llm.test.ts
git commit -m "feat(server): LLM 解释调用（新三字段 prompt、JSON 解析、mock 关键词兜底）"
```

---

### Task 7: 三层缓存（内存 → SQLite → 并发去重）

**Files:**
- Create: `packages/server/src/explainService/cache.ts`
- Test: `packages/server/src/__tests__/cache.test.ts`

**Interfaces:**
- Consumes: `createPersistence(dbPath?: string): Persistence`（Task 4）；`Explanation`（Task 3）
- Produces: `createCache(p: Persistence): Cache`；`interface Cache { getExplanation(cacheKey: string, llmCallFn: () => Promise<Explanation>): Promise<Explanation>; getStats(): { memoryCacheSize: number; pendingRequestsSize: number } }`（Task 8 使用）

- [ ] **Step 1: 写失败测试**

`packages/server/src/__tests__/cache.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { createCache } from "../explainService/cache";

const exp = { category: "运算错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" };

describe("三层缓存", () => {
  it("未命中：调 1 次 LLM 并写入缓存；再取：内存命中不再调", async () => {
    const cache = createCache(createPersistence(":memory:"));
    let calls = 0;
    const fn = async () => { calls++; return exp; };
    expect(await cache.getExplanation("k1", fn)).toEqual(exp);
    expect(await cache.getExplanation("k1", fn)).toEqual(exp);
    expect(calls).toBe(1);
    expect(cache.getStats().memoryCacheSize).toBe(1);
  });

  it("并发去重：同 key 并发只调 1 次 LLM（demo pendingRequests 语义）", async () => {
    const cache = createCache(createPersistence(":memory:"));
    let calls = 0;
    const fn = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return exp; };
    const [a, b] = await Promise.all([
      cache.getExplanation("k2", fn),
      cache.getExplanation("k2", fn),
    ]);
    expect(a).toEqual(exp);
    expect(b).toEqual(exp);
    expect(calls).toBe(1);
  });

  it("重启模拟：新 cache 实例（内存空）+ 同一 SQLite → 命中持久层，0 次 LLM", async () => {
    const p = createPersistence(":memory:");
    const c1 = createCache(p);
    await c1.getExplanation("k3", async () => exp);
    const c2 = createCache(p); // 模拟重启：内存清零，SQLite 还在
    let calls = 0;
    expect(await c2.getExplanation("k3", async () => { calls++; return exp; })).toEqual(exp);
    expect(calls).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL，`Cannot find module '../explainService/cache'`。

- [ ] **Step 3: 最小实现**

`packages/server/src/explainService/cache.ts`：

```ts
import crypto from "node:crypto";
import type { Explanation } from "@classroom/shared";
import type { Persistence } from "../persistence";

export interface Cache {
  getExplanation(cacheKey: string, llmCallFn: () => Promise<Explanation>): Promise<Explanation>;
  getStats(): { memoryCacheSize: number; pendingRequestsSize: number };
}

export function createCache(p: Persistence): Cache {
  const memoryCache = new Map<string, Explanation>();
  const pending = new Map<string, Promise<Explanation>>();

  return {
    async getExplanation(cacheKey, llmCallFn) {
      // 1. 内存命中
      const mem = memoryCache.get(cacheKey);
      if (mem) return mem;

      // 2. SQLite 命中（同步回内存）
      const rawHash = crypto.createHash("sha256").update(cacheKey).digest("hex");
      const cached = p.getCachedExplanation(rawHash);
      if (cached) {
        memoryCache.set(cacheKey, cached);
        return cached;
      }

      // 3. 并发去重：同 key 共享同一个 Promise
      const inflight = pending.get(cacheKey);
      if (inflight) return inflight;

      const promise = (async () => {
        try {
          const result = await llmCallFn();
          memoryCache.set(cacheKey, result);
          p.saveCache(rawHash, cacheKey, result, "llm");
          return result;
        } finally {
          pending.delete(cacheKey);
        }
      })();
      pending.set(cacheKey, promise);
      return promise;
    },

    getStats: () => ({ memoryCacheSize: memoryCache.size, pendingRequestsSize: pending.size }),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/explainService/cache.ts packages/server/src/__tests__/cache.test.ts
git commit -m "feat(server): 错误解释三层缓存（内存/SQLite/并发去重）"
```

---

### Task 8: explainService 分类取用规则（run 静态覆盖 / diag 全采纳）

**Files:**
- Create: `packages/server/src/explainService/index.ts`
- Test: `packages/server/src/__tests__/explain.test.ts`

**Interfaces:**
- Consumes: `createCache(p): Cache`（Task 7）；`callLLM(input): Promise<Explanation>`、`mockExplain(input)`（Task 6）；`categoryFor(errorType)`（Task 1）；`NormalizedEvent`（Task 3）
- Produces: `createExplainService(cache: Cache): ExplainService`；`interface ExplainService { explain(ev: NormalizedEvent): Promise<Explanation> }`（Task 13 主流程使用；success 事件调用方不调 explain）

- [ ] **Step 1: 写失败测试**

`packages/server/src/__tests__/explain.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { createExplainService } from "../explainService/index";
import type { Cache } from "../explainService/cache";
import type { NormalizedEvent, Explanation } from "@classroom/shared";

function stubCache(answers: Record<string, Explanation>): Cache {
  return {
    async getExplanation(key, fn) {
      if (key in answers) return answers[key];
      return fn();
    },
    getStats: () => ({ memoryCacheSize: 0, pendingRequestsSize: 0 }),
  };
}

function runErrorEvent(cacheKey: string): NormalizedEvent {
  return {
    studentId: "s", studentName: "s", classId: "3A", eventType: "run", success: false,
    errorType: "ZeroDivisionError", errorMessage: "division by zero", samples: [],
    rawMessage: "division by zero", cacheKey, command: undefined, exitCode: 1,
    filePath: undefined, lineNo: undefined, ts: Date.now(),
  };
}

describe("explain 分类取用规则（spec §5）", () => {
  it("run 事件：category 以静态映射为准（即使 LLM 给错），subtype/knowledge 采纳 LLM", async () => {
    // LLM 故意返回错误 category，静态映射应覆盖为「运算错误」
    const svc = createExplainService(stubCache({
      "ZeroDivisionError: division by zero":
        { category: "类型错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" },
    }));
    const r = await svc.explain(runErrorEvent("ZeroDivisionError: division by zero"));
    expect(r).toEqual({ category: "运算错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" });
  });

  it("diag 事件：三字段全部采纳 LLM（error_type 是写死的占位）", async () => {
    const llmResult = { category: "语法错误", subtype: "缺少冒号", knowledge: "函数定义末尾要加冒号" };
    const svc = createExplainService(stubCache({ "应为 \":\"": llmResult }));
    const ev: NormalizedEvent = {
      studentId: "s", studentName: "s", classId: "3A", eventType: "diag", success: false,
      errorType: null, errorMessage: "应为 \":\"", samples: ["应为 \":\""], rawMessage: "应为 \":\"",
      cacheKey: "应为 \":\"", ts: Date.now(),
    };
    expect(await svc.explain(ev)).toEqual(llmResult);
  });

  it("cacheKey 为 null 的边界（如无样本 diag）：直接兜底，不调 LLM", async () => {
    let called = false;
    const svc = createExplainService({
      async getExplanation(_k, fn) { called = true; return fn(); },
      getStats: () => ({ memoryCacheSize: 0, pendingRequestsSize: 0 }),
    });
    const ev = { ...runErrorEvent("ignored"), cacheKey: null } as NormalizedEvent;
    const r = await svc.explain(ev);
    expect(called).toBe(false);
    expect(r.category).toBe("其他");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL，`Cannot find module '../explainService/index'`。

- [ ] **Step 3: 最小实现**

`packages/server/src/explainService/index.ts`：

```ts
import { categoryFor, type Explanation, type NormalizedEvent } from "@classroom/shared";
import { callLLM } from "./llm";
import type { Cache } from "./cache";

export interface ExplainService {
  explain(ev: NormalizedEvent): Promise<Explanation>;
}

export function createExplainService(cache: Cache): ExplainService {
  return {
    async explain(ev) {
      // 成功事件不解释（调用方也不会调）；无 cacheKey 的畸形错误事件直接兜底
      if (ev.success || !ev.cacheKey) {
        return { category: "其他", subtype: "未知错误", knowledge: "请检查代码与输入是否正确" };
      }
      const llm = await cache.getExplanation(ev.cacheKey, () =>
        callLLM({ errorType: ev.errorType ?? "DiagnosticError", errorMessage: ev.rawMessage || ev.errorMessage || "" }),
      );
      if (ev.eventType === "run") {
        // run：category 静态映射覆盖（确定性高），subtype/knowledge 采纳 LLM
        return { ...llm, category: categoryFor(ev.errorType) };
      }
      // diag：三字段全采纳 LLM
      return llm;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/explainService/index.ts packages/server/src/__tests__/explain.test.ts
git commit -m "feat(server): 解释取用规则——run 静态映射覆盖 category，diag 全采纳 LLM"
```

---

### Task 9: stateManager（课堂状态唯一事实源，内存）

**Files:**
- Create: `packages/server/src/stateManager.ts`
- Test: `packages/server/src/__tests__/stateManager.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent`、`Explanation`（Task 3）
- Produces（Task 10/11/13 依赖，逐字使用）：
  - `interface StoredEvent { ts: number; eventType: "diag" | "run"; success: boolean; subtype: string | null; knowledge: string | null; rawMessage: string }`
  - `interface StudentRecord { studentId: string; studentName: string; classId: string; events: StoredEvent[]; lastActivityAt: number; lastErrorAt: number | null; consecutiveErrors: number }`
  - `createStateManager(): StateManager`；`interface StateManager { apply(ev: NormalizedEvent, explanation: Explanation | null): void; listRecords(): StudentRecord[]; getStudentDetail(id: string): { studentId: string; studentName: string; events: StoredEvent[]; lastActivityAt: number; lastErrorAt: number | null } | null }`

- [ ] **Step 1: 写失败测试**

`packages/server/src/__tests__/stateManager.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { createStateManager } from "../stateManager";
import type { NormalizedEvent, Explanation } from "@classroom/shared";

const exp: Explanation = { category: "运算错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" };

function errorEvent(studentId: string, ts: number, subtype = "除数为0"): NormalizedEvent {
  return {
    studentId, studentName: `学生${studentId}`, classId: "3A", eventType: "run", success: false,
    errorType: "ZeroDivisionError", errorMessage: "division by zero", samples: [],
    rawMessage: "division by zero", cacheKey: "ZeroDivisionError: division by zero",
    exitCode: 1, ts,
  };
}

function successEvent(studentId: string, ts: number): NormalizedEvent {
  return {
    studentId, studentName: `学生${studentId}`, classId: "3A", eventType: "run", success: true,
    errorType: "RunSuccess", errorMessage: "", samples: [], rawMessage: "run success",
    cacheKey: null, exitCode: 0, ts,
  };
}

describe("stateManager（内存课堂状态）", () => {
  it("首个事件自动建档", () => {
    const sm = createStateManager();
    sm.apply(errorEvent("stu001", 1000), exp);
    const r = sm.listRecords();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ studentId: "stu001", studentName: "学生stu001", consecutiveErrors: 1, lastErrorAt: 1000, lastActivityAt: 1000 });
    expect(r[0].events[0].subtype).toBe("除数为0");
  });

  it("成功运行清零 consecutiveErrors（spec §5：绿色=最近有成功运行）", () => {
    const sm = createStateManager();
    sm.apply(errorEvent("stu001", 1000), exp);
    sm.apply(errorEvent("stu001", 2000), exp);
    expect(sm.listRecords()[0].consecutiveErrors).toBe(2);
    sm.apply(successEvent("stu001", 3000), null);
    const r = sm.listRecords()[0];
    expect(r.consecutiveErrors).toBe(0);
    expect(r.lastErrorAt).toBe(2000);       // 成功不清除 lastErrorAt
    expect(r.lastActivityAt).toBe(3000);
  });

  it("事件序列上限 200，超出保留最新", () => {
    const sm = createStateManager();
    for (let i = 0; i < 205; i++) sm.apply(errorEvent("stu001", i), exp);
    const r = sm.listRecords()[0];
    expect(r.events).toHaveLength(200);
    expect(r.events[0].ts).toBe(5);         // 最早的 5 条被丢弃
    expect(r.events[199].ts).toBe(204);
  });

  it("getStudentDetail：未知学生返回 null；返回记录含最近事件", () => {
    const sm = createStateManager();
    sm.apply(errorEvent("stu001", 1000), exp);
    expect(sm.getStudentDetail("nope")).toBeNull();
    const d = sm.getStudentDetail("stu001");
    expect(d?.events).toHaveLength(1);
    expect(d?.lastActivityAt).toBe(1000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL，`Cannot find module '../stateManager'`。

- [ ] **Step 3: 最小实现**

`packages/server/src/stateManager.ts`：

```ts
import type { Explanation, NormalizedEvent } from "@classroom/shared";

export interface StoredEvent {
  ts: number;
  eventType: "diag" | "run";
  success: boolean;
  subtype: string | null;
  knowledge: string | null;
  rawMessage: string;
}

export interface StudentRecord {
  studentId: string;
  studentName: string;
  classId: string;
  events: StoredEvent[];
  lastActivityAt: number;
  lastErrorAt: number | null;
  consecutiveErrors: number;
}

const MAX_EVENTS = 200;

export interface StateManager {
  apply(ev: NormalizedEvent, explanation: Explanation | null): void;
  listRecords(): StudentRecord[];
  getStudentDetail(id: string): {
    studentId: string; studentName: string; events: StoredEvent[];
    lastActivityAt: number; lastErrorAt: number | null;
  } | null;
}

export function createStateManager(): StateManager {
  const records = new Map<string, StudentRecord>();

  return {
    apply(ev, explanation) {
      let r = records.get(ev.studentId);
      if (!r) {
        r = {
          studentId: ev.studentId, studentName: ev.studentName, classId: ev.classId,
          events: [], lastActivityAt: ev.ts, lastErrorAt: null, consecutiveErrors: 0,
        };
        records.set(ev.studentId, r);
      }
      r.studentName = ev.studentName; // 名字可能后来才配上
      r.classId = ev.classId;
      r.events.push({
        ts: ev.ts, eventType: ev.eventType, success: ev.success,
        subtype: ev.success ? null : (explanation?.subtype ?? null),
        knowledge: ev.success ? null : (explanation?.knowledge ?? null),
        rawMessage: ev.rawMessage,
      });
      if (r.events.length > MAX_EVENTS) r.events.splice(0, r.events.length - MAX_EVENTS);
      r.lastActivityAt = Math.max(r.lastActivityAt, ev.ts);
      if (ev.success) {
        r.consecutiveErrors = 0;
      } else {
        r.lastErrorAt = Math.max(r.lastErrorAt ?? 0, ev.ts);
        r.consecutiveErrors += 1;
      }
    },

    listRecords: () => [...records.values()],

    getStudentDetail(id) {
      const r = records.get(id);
      if (!r) return null;
      return {
        studentId: r.studentId, studentName: r.studentName,
        events: [...r.events].reverse(), // 新的在前（抽屉展示用）
        lastActivityAt: r.lastActivityAt, lastErrorAt: r.lastErrorAt,
      };
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/stateManager.ts packages/server/src/__tests__/stateManager.test.ts
git commit -m "feat(server): 课堂状态内存管理（学生记录、连续错误、200 条上限）"
```

---

### Task 10: aggregator（一）状态色与优先级分

**Files:**
- Create: `packages/server/src/aggregator.ts`
- Test: `packages/server/src/__tests__/aggregator-status.test.ts`

**Interfaces:**
- Consumes: `StudentRecord`（Task 9）
- Produces: `computeStatus(r: StudentRecord, now: number): StatusColor`；`computeScore(r: StudentRecord, now: number): number`（Task 11 的 recompose 内部使用；纯函数，now 显式传入便于测试）

规则（spec §5，判定基准 = 计算时刻，滚动窗口）：
- 红：同一 subtype 错误 5 分钟内 ≥3 次，或 `consecutiveErrors ≥ 5`（spec 的「同一错误」取 subtype 粒度，与聚合面板分组一致）
- 黄：最近 2 分钟内有错误事件，且未达红
- 绿：其余（含从未上报——V1 无离线判定）
- 分数（仅有错误的学生）：`score = 最高频 subtype 的 5 分钟内次数×10 + floor(距上次报错分钟数)×5 + 20（距上次事件>3 分钟且最后一次事件是错误）+ 30（连续错误≥5）`

- [ ] **Step 1: 写失败测试**

`packages/server/src/__tests__/aggregator-status.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { computeStatus, computeScore } from "../aggregator";
import type { StudentRecord, StoredEvent } from "../stateManager";

const NOW = Date.parse("2026-09-17T04:00:00.000Z");
const MIN = 60_000;

function record(overrides: Partial<StudentRecord> & { events: StoredEvent[] }): StudentRecord {
  return {
    studentId: "stu001", studentName: "张三", classId: "3A",
    lastActivityAt: NOW, lastErrorAt: null, consecutiveErrors: 0,
    ...overrides,
  };
}

function err(ts: number, subtype: string): StoredEvent {
  return { ts, eventType: "run", success: false, subtype, knowledge: "k", rawMessage: "m" };
}

describe("computeStatus（spec §5 状态色）", () => {
  it("无错误 → 绿（V1 无离线判定，从未上报也是绿）", () => {
    const r = record({ events: [] });
    expect(computeStatus(r, NOW)).toBe("green");
  });
  it("2 分钟内 1 次错误 → 黄", () => {
    const r = record({ events: [err(NOW - 1 * MIN, "缺少冒号")], lastErrorAt: NOW - 1 * MIN, consecutiveErrors: 1 });
    expect(computeStatus(r, NOW)).toBe("yellow");
  });
  it("错误超过 2 分钟前 → 绿（未达红）", () => {
    const r = record({ events: [err(NOW - 3 * MIN, "缺少冒号")], lastErrorAt: NOW - 3 * MIN, consecutiveErrors: 1 });
    expect(computeStatus(r, NOW)).toBe("green");
  });
  it("同一 subtype 5 分钟内 3 次 → 红", () => {
    const ts = [NOW - 4 * MIN, NOW - 3 * MIN, NOW - 2 * MIN];
    const r = record({
      events: ts.map(t => err(t, "缺少冒号")),
      lastErrorAt: NOW - 2 * MIN, consecutiveErrors: 3,
    });
    expect(computeStatus(r, NOW)).toBe("red");
  });
  it("5 分钟窗口外的重复不计入：3 次中有 1 次在 6 分钟前 → 黄", () => {
    const ts = [NOW - 6 * MIN, NOW - 3 * MIN, NOW - 2 * MIN];
    const r = record({
      events: ts.map(t => err(t, "缺少冒号")),
      lastErrorAt: NOW - 2 * MIN, consecutiveErrors: 3,
    });
    expect(computeStatus(r, NOW)).toBe("yellow");
  });
  it("不同 subtype 各 1 次（窗口内重复不足 3）但连续 ≥5 → 红（走连续错误路径）", () => {
    const ts = [1, 2, 3, 4, 5].map(i => NOW - i * MIN);
    const r = record({
      events: ts.map((t, i) => err(t, `子类${i}`)),
      lastErrorAt: NOW - 1 * MIN, consecutiveErrors: 5,
    });
    expect(computeStatus(r, NOW)).toBe("red");
  });
});

describe("computeScore（spec §5 优先级分）", () => {
  it("无错误 → 0", () => {
    expect(computeScore(record({ events: [] }), NOW)).toBe(0);
  });
  it("3 次重复 + 距上次报错 4 分钟 + 距上次事件>3 分钟且未解决 = 30+20+20 = 70", () => {
    // 3 次同类错误都落在 5 分钟窗口内（4.9/4.5/4 分钟前）
    const ts = [NOW - 4.9 * MIN, NOW - 4.5 * MIN, NOW - 4 * MIN];
    const r = record({
      events: ts.map(t => err(t, "缺少冒号")),
      lastActivityAt: NOW - 4 * MIN, // 最后一次事件就是那次错误
      lastErrorAt: NOW - 4 * MIN,
      consecutiveErrors: 3,
    });
    expect(computeScore(r, NOW)).toBe(70);
  });
  it("连续错误 ≥5 额外 +30", () => {
    const ts = [1, 2, 3, 4, 5].map(i => NOW - i * MIN);
    const r = record({
      events: ts.map((t, i) => err(t, `子类${i}`)), // 每种 subtype 仅 1 次 → 重复分 1×10
      lastActivityAt: NOW - 1 * MIN, lastErrorAt: NOW - 1 * MIN,
      consecutiveErrors: 5,
    });
    // 重复 1×10 + 距上次报错 1 分钟×5=5 + 未解决加分（距上次事件仅 1 分钟 <3，不加）+ 连续 30 = 45
    expect(computeScore(r, NOW)).toBe(45);
  });
  it("成功运行后（最后事件是成功）：不加「未解决」20 分", () => {
    const ts = [NOW - 9 * MIN, NOW - 8 * MIN, NOW - 7 * MIN];
    const events = ts.map(t => err(t, "缺少冒号"));
    events.push({ ts: NOW - 5 * MIN, eventType: "run", success: true, subtype: null, knowledge: null, rawMessage: "ok" });
    const r = record({
      events,
      lastActivityAt: NOW - 5 * MIN, lastErrorAt: NOW - 7 * MIN,
      consecutiveErrors: 0,
    });
    // 3 次重复(5 分钟窗口内? 9/8/7 分钟前都超窗 → 0) 0×10 + floor(7 分钟)×5=35，无未解决加分 = 35
    expect(computeScore(r, NOW)).toBe(35);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL，`Cannot find module '../aggregator'`。

- [ ] **Step 3: 最小实现**

`packages/server/src/aggregator.ts`（本任务先写两个纯函数，Task 11 继续补 recompute/ack）：

```ts
import type { StatusColor } from "@classroom/shared";
import type { StudentRecord, StoredEvent } from "./stateManager";

const FIVE_MIN = 5 * 60_000;
const TWO_MIN = 2 * 60_000;
const THREE_MIN = 3 * 60_000;

/** 窗口内错误事件按 subtype 计数，返回最高重复次数 */
function maxSubtypeRepeat(events: StoredEvent[], now: number): number {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.success || !e.subtype || now - e.ts > FIVE_MIN) continue;
    counts.set(e.subtype, (counts.get(e.subtype) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

export function computeStatus(r: StudentRecord, now: number): StatusColor {
  if (r.consecutiveErrors >= 5 || maxSubtypeRepeat(r.events, now) >= 3) return "red";
  const recentError = r.events.some((e) => !e.success && now - e.ts <= TWO_MIN);
  if (recentError) return "yellow";
  return "green";
}

export function computeScore(r: StudentRecord, now: number): number {
  if (r.lastErrorAt === null) return 0;
  const repeat = maxSubtypeRepeat(r.events, now);
  const minutesSinceError = Math.floor((now - r.lastErrorAt) / 60_000);
  const unresolved = r.lastErrorAt === r.lastActivityAt; // 最后一次事件是错误
  const stale = now - r.lastActivityAt > THREE_MIN;
  let score = repeat * 10 + minutesSinceError * 5;
  if (stale && unresolved) score += 20;
  if (r.consecutiveErrors >= 5) score += 30;
  return score;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/aggregator.ts packages/server/src/__tests__/aggregator-status.test.ts
git commit -m "feat(server): 状态色判定与优先级分（红黄绿规则、spec 分数公式）"
```

---

### Task 11: aggregator（二）聚合、告警、教学建议与 ack

**Files:**
- Modify: `packages/server/src/aggregator.ts`（追加 recompute/ack）
- Test: `packages/server/src/__tests__/aggregator-snapshot.test.ts`

**Interfaces:**
- Consumes: `computeStatus / computeScore`（Task 10）；`StudentRecord`（Task 9）；`TeacherSnapshot / StudentState / AlertItem / AggItem / SuggestionItem / RecentError`（Task 3 dto）
- Produces: `createAggregator(): Aggregator`；`interface Aggregator { recompute(records: StudentRecord[], now: number): Omit<TeacherSnapshot, "ts" | "classId">; ack(id: string): void }`（Task 12/13 使用：index.ts 组装 `{ ts, classId, ...core }` 成完整 TeacherSnapshot）

规则（spec §5）：
- 告警：score>0 的学生按分降序取前 5；`alertSummary = "其余 N 人正常"`（N = 总人数 − 告警数）
- 聚合：错误事件按 subtype 分组（跳过 success/null），count = **人数**（非事件数），category/knowledge 取该 subtype 最新事件；count 降序
- 建议（分母 = 上报过错误的学生数）：占比 ≥40% → `⚠️ N 人卡在「{subtype}」，建议全班讲评`（class-review）；≥20% → `💡 N 人遇到「{subtype}」，可小组讨论`（group-discuss）；连续报错 ≥3 → `🙋 张三、李四 连续报错，建议单独辅导`（individual）
- 建议稳定 id：`class-review:{subtype}` / `group-discuss:{subtype}` / `individual:{排序后 studentId 逗号拼接}`；ack 仅存内存
- reason 规则（按序取首个命中）：连续 ≥5 → `连续报错 N 次`；同 subtype 5 分钟内 ≥3 → `同一错误 5 分钟内 N 次`；否则 → `报错后 M 分钟无进展`

- [ ] **Step 1: 写失败测试**

`packages/server/src/__tests__/aggregator-snapshot.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { createAggregator } from "../aggregator";
import type { StudentRecord, StoredEvent } from "../stateManager";

const NOW = Date.parse("2026-09-17T04:00:00.000Z");
const MIN = 60_000;

function err(ts: number, subtype: string): StoredEvent {
  return { ts, eventType: "run", success: false, subtype, knowledge: "知识点", rawMessage: "m" };
}

function student(id: string, name: string, events: StoredEvent[], consecutiveErrors = events.filter(e => !e.success).length): StudentRecord {
  const errors = events.filter(e => !e.success);
  return {
    studentId: id, studentName: name, classId: "3A", events,
    lastActivityAt: errors.at(-1)?.ts ?? NOW,
    lastErrorAt: errors.at(-1)?.ts ?? null,
    consecutiveErrors,
  };
}

describe("recompute：完整快照", () => {
  it("students 字段：状态色、分数、最近 3 条错误（新的在前）", () => {
    const events = [1, 2, 3, 4].map(i => err(NOW - i * MIN, `子类${i}`));
    const rec = student("stu001", "张三", events);
    const snap = createAggregator().recompute([rec], NOW);
    expect(snap.students[0]).toMatchObject({ studentId: "stu001", studentName: "张三", errorCountTotal: 4 });
    expect(snap.students[0].recentErrors).toHaveLength(3);
    expect(snap.students[0].recentErrors[0].subtype).toBe("子类4");
  });

  it("告警取前 5 名 + alertSummary", () => {
    const recs = Array.from({ length: 7 }, (_, i) =>
      student(`stu00${i + 1}`, `学生${i}`, [err(NOW - MIN, "缺少冒号")]));
    const snap = createAggregator().recompute(recs, NOW);
    expect(snap.alerts).toHaveLength(5);
    expect(snap.alertSummary).toBe("其余 2 人正常");
    expect(snap.alerts[0].subtype).toBe("缺少冒号");
  });

  it("聚合按 subtype 分组，count 为人数且降序，携带名单", () => {
    const recs = [
      student("stu001", "张三", [err(NOW - MIN, "缺少冒号")]),
      student("stu002", "李四", [err(NOW - MIN, "缺少冒号"), err(NOW - 2 * MIN, "缺少冒号")]), // 同人同 subtype 仍算 1 人
      student("stu003", "王五", [err(NOW - MIN, "意外缩进")]),
    ];
    const agg = createAggregator().recompute(recs, NOW).aggregates;
    expect(agg[0]).toMatchObject({ subtype: "缺少冒号", count: 2 });
    expect(agg[0].students.map(s => s.studentName)).toEqual(["张三", "李四"]);
    expect(agg[1]).toMatchObject({ subtype: "意外缩进", count: 1 });
  });

  it("建议规则：≥40% 全班讲评；≥20% 小组讨论；连续≥3 单独辅导", () => {
    // 10 人班：stu1-4 报「缺少冒号」(4/7=57%→class-review)
    //          stu5-6 报「意外缩进」(2/7=29%→group-discuss)
    //          stu7 连续 3 次不同 subtype（→individual）
    //          分母=7（上报过错误的学生），stu8-10 无错误
    const recs = [
      ...[1, 2, 3, 4].map(i => student(`stu00${i}`, `学生${i}`, [err(NOW - MIN, "缺少冒号")])),
      ...[5, 6].map(i => student(`stu00${i}`, `学生${i}`, [err(NOW - MIN, "意外缩进")])),
      student("stu007", "学生7", [1, 2, 3].map(i => err(NOW - i * MIN, `甲${i}`))),
      student("stu008", "学生8", []), student("stu009", "学生9", []), student("stu010", "学生10", []),
    ];
    const snap = createAggregator().recompute(recs, NOW);
    const ids = snap.suggestions.map(s => s.id);
    expect(ids).toContain("class-review:缺少冒号");
    expect(ids).toContain("group-discuss:意外缩进");
    expect(ids).toContain("individual:stu007");
    const cr = snap.suggestions.find(s => s.id === "class-review:缺少冒号")!;
    expect(cr.text).toBe("⚠️ 4 人卡在「缺少冒号」，建议全班讲评");
    const ind = snap.suggestions.find(s => s.id === "individual:stu007")!;
    expect(ind.text).toBe("🙋 学生7 连续报错，建议单独辅导");
  });

  it("ack 后建议标记已处理（内存态）", () => {
    const agg = createAggregator();
    const recs = [student("stu001", "张三", [err(NOW - MIN, "缺少冒号")])];
    agg.ack("class-review:缺少冒号");
    const snap = agg.recompute(recs, NOW);
    const s = snap.suggestions.find(x => x.id === "class-review:缺少冒号");
    expect(s?.acked).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL，`recompute is not a function`（或 `createAggregator` 未导出）。

- [ ] **Step 3: 最小实现**

在 `packages/server/src/aggregator.ts` 追加：

```ts
import type {
  AggItem, AlertItem, RecentError, StudentState, SuggestionItem, TeacherSnapshot,
} from "@classroom/shared";

export interface Aggregator {
  recompute(records: StudentRecord[], now: number): Omit<TeacherSnapshot, "ts" | "classId">;
  ack(id: string): void;
}

interface SubtypeGroup {
  subtype: string;
  category: string;
  knowledge: string;
  latestTs: number;
  students: { studentId: string; studentName: string }[];
}

export function createAggregator(): Aggregator {
  const acked = new Set<string>();

  return {
    recompute(records, now) {
      // ── 学生状态 ────────────────────────────────
      const students: StudentState[] = records.map((r) => {
        const errors = r.events.filter((e) => !e.success);
        const recentErrors: RecentError[] = [...errors]
          .slice(-3).reverse()
          .map((e) => ({ ts: e.ts, subtype: e.subtype ?? "未知错误", knowledge: e.knowledge ?? "", rawMessage: e.rawMessage }));
        return {
          studentId: r.studentId, studentName: r.studentName,
          status: computeStatus(r, now),
          priorityScore: computeScore(r, now),
          lastActivityAt: r.lastActivityAt, lastErrorAt: r.lastErrorAt,
          errorCountTotal: errors.length, recentErrors,
        };
      });

      // ── 告警（score>0 前 5）────────────────────
      const scored = records
        .map((r, i) => ({ r, score: students[i].priorityScore }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      const alerts: AlertItem[] = scored.slice(0, 5).map(({ r, score }) => {
        const lastErr = [...r.events].reverse().find((e) => !e.success);
        const repeat = maxSubtypeRepeat(r.events, now);
        const reason =
          r.consecutiveErrors >= 5 ? `连续报错 ${r.consecutiveErrors} 次`
          : repeat >= 3 ? `同一错误 5 分钟内 ${repeat} 次`
          : `报错后 ${Math.floor((now - (r.lastErrorAt ?? now)) / 60_000)} 分钟无进展`;
        return {
          studentId: r.studentId, studentName: r.studentName, score,
          reason,
          subtype: lastErr?.subtype ?? "未知错误",
          knowledge: lastErr?.knowledge ?? "",
          lastErrorAt: r.lastErrorAt ?? now,
        };
      });
      const alertSummary = `其余 ${records.length - alerts.length} 人正常`;

      // ── 聚合（按 subtype，count=人数）─────────────
      const groups = new Map<string, SubtypeGroup>();
      for (const r of records) {
        for (const e of r.events) {
          if (e.success || !e.subtype) continue;
          let g = groups.get(e.subtype);
          if (!g) {
            g = { subtype: e.subtype, category: "", knowledge: "", latestTs: -1, students: [] };
            groups.set(e.subtype, g);
          }
          if (!g.students.some((s) => s.studentId === r.studentId)) {
            g.students.push({ studentId: r.studentId, studentName: r.studentName });
          }
          if (e.ts >= g.latestTs) {
            g.latestTs = e.ts;
            g.knowledge = e.knowledge ?? g.knowledge;
          }
        }
      }
      // category：run 从静态映射拿最准，但这里只有 subtype；取该组任一学生最新事件的 knowledge 即可，
      // category 由 explainService 已写入事件流 —— 聚合层用 subtype 反查不到 category 时留 subtype 本身。
      // 简化实现：group.category 置空字符串，前端展示以 subtype/knowledge 为主（spec 聚合面板只要求 subtype+人数+知识点）。
      const aggregates: AggItem[] = [...groups.values()]
        .map((g) => ({ subtype: g.subtype, category: g.category, knowledge: g.knowledge, count: g.students.length, students: g.students }))
        .sort((a, b) => b.count - a.count);

      // ── 建议（分母 = 上报过错误的学生数）──────────
      const errorStudents = records.filter((r) => r.events.some((e) => !e.success)).length;
      const suggestions: SuggestionItem[] = [];
      if (errorStudents > 0) {
        for (const g of groups.values()) {
          const ratio = g.students.length / errorStudents;
          if (ratio >= 0.4) {
            suggestions.push({
              id: `class-review:${g.subtype}`, kind: "class-review",
              text: `⚠️ ${g.students.length} 人卡在「${g.subtype}」，建议全班讲评`,
              acked: acked.has(`class-review:${g.subtype}`),
            });
          } else if (ratio >= 0.2) {
            suggestions.push({
              id: `group-discuss:${g.subtype}`, kind: "group-discuss",
              text: `💡 ${g.students.length} 人遇到「${g.subtype}」，可小组讨论`,
              acked: acked.has(`group-discuss:${g.subtype}`),
            });
          }
        }
        const stuck = records.filter((r) => r.consecutiveErrors >= 3);
        if (stuck.length > 0) {
          const id = `individual:${stuck.map((s) => s.studentId).sort().join(",")}`;
          suggestions.push({
            id, kind: "individual",
            text: `🙋 ${stuck.map((s) => s.studentName).join("、")} 连续报错，建议单独辅导`,
            acked: acked.has(id),
          });
        }
      }

      return { students, alerts, alertSummary, aggregates, suggestions };
    },

    ack(id) { acked.add(id); },
  };
}
```

注：`maxSubtypeRepeat` 是 Task 10 已在文件内定义的私有函数，直接复用；`AggItem.category` 本版置空（spec §5 聚合面板展示要素为 subtype+人数+知识点翻译，category 非必需），如后续需要，可在 StoredEvent 中冗余存储 category。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS（server 包全部用例：Task 4/5/6/7/8/9/10/11）。

- [ ] **Step 5: 类型一致性检查**

Run: `pnpm --filter @classroom/server build`
Expected: `tsc --noEmit` 无错误。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/aggregator.ts packages/server/src/__tests__/aggregator-snapshot.test.ts
git commit -m "feat(server): 聚合/告警/教学建议计算与 ack（前 5 告警、subtype 分组、40%/20% 阈值）"
```

---

### Task 12: teacherHub（SSE：快照 + 更新 + 心跳）

**Files:**
- Create: `packages/server/src/teacherHub.ts`
- Test: `packages/server/src/__tests__/teacherHub.test.ts`

**Interfaces:**
- Consumes: `TeacherSnapshot`、`SSEMessage`（@classroom/shared，Task 3）
- Produces: `createTeacherHub(getSnapshot: () => TeacherSnapshot): TeacherHub`；`interface TeacherHub { handleStream(req: Request, res: Response): void; publish(snapshot: TeacherSnapshot): void; startHeartbeat(): void; clientCount(): number }`（Task 13 使用）

设计要点：teacherHub 是哑管道，不计算任何东西；V1 的「增量」实现为**每次 publish 推全量重算快照**（20 人 payload < 10KB），前端合并逻辑为直接替换；SSE 线格式 `data: {...}\n\n`（空行结束消息，漏写第二个 `\n` 是最常见 bug）；心跳 `: ping\n\n` 是注释行，EventSource 忽略但保持 TCP 活跃（防中间层空闲掐断，25s < 常见 30s 超时）。

- [ ] **Step 1: 写失败测试**

`packages/server/src/__tests__/teacherHub.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { createTeacherHub } from "../teacherHub";
import type { TeacherSnapshot } from "@classroom/shared";

const snap: TeacherSnapshot = {
  ts: 1, classId: "3A", students: [], alerts: [],
  alertSummary: "其余 0 人正常", aggregates: [], suggestions: [],
};

function fakeRes() {
  return {
    writes: [] as string[],
    headers: null as Record<string, string> | null,
    writeHead(_s: number, h: Record<string, string>) { this.headers = h; },
    write(c: string) { this.writes.push(c); return true; },
  };
}
function fakeReq() {
  return {
    closeCb: null as null | (() => void),
    on(ev: string, cb: () => void) { if (ev === "close") this.closeCb = cb; },
  };
}
function parseSse(chunk: string) {
  return JSON.parse(chunk.replace(/^data: /, "").trim());
}

describe("teacherHub（SSE）", () => {
  it("连接即推 snapshot，SSE 响应头正确", () => {
    const hub = createTeacherHub(() => snap);
    const res = fakeRes();
    hub.handleStream(fakeReq() as any, res as any);
    expect(res.headers?.["Content-Type"]).toBe("text/event-stream");
    expect(res.headers?.["Cache-Control"]).toBe("no-cache");
    expect(res.writes).toHaveLength(1);
    const msg = parseSse(res.writes[0]);
    expect(msg.type).toBe("snapshot");
    expect(msg.data).toEqual(snap);
    expect(res.writes[0].endsWith("\n\n")).toBe(true); // SSE 消息必须空行结尾
  });

  it("publish 广播 update 给全部客户端", () => {
    const hub = createTeacherHub(() => snap);
    const r1 = fakeRes(); const r2 = fakeRes();
    hub.handleStream(fakeReq() as any, r1 as any);
    hub.handleStream(fakeReq() as any, r2 as any);
    hub.publish(snap);
    for (const r of [r1, r2]) {
      expect(parseSse(r.writes.at(-1)!).type).toBe("update");
    }
    expect(hub.clientCount()).toBe(2);
  });

  it("客户端断开（close 回调触发）后不再接收广播", () => {
    const hub = createTeacherHub(() => snap);
    const req = fakeReq();
    const res = fakeRes();
    hub.handleStream(req as any, res as any);
    req.closeCb!();
    hub.publish(snap);
    expect(res.writes).toHaveLength(1); // 只有连接时的 snapshot
  });

  it("write 抛错（死连接）时移除该客户端，不影响其他客户端", () => {
    const hub = createTeacherHub(() => snap);
    const dead = { ...fakeRes(), write() { throw new Error("broken pipe"); } };
    const alive = fakeRes();
    hub.handleStream(fakeReq() as any, dead as any);
    hub.handleStream(fakeReq() as any, alive as any);
    expect(() => hub.publish(snap)).not.toThrow();
    expect(parseSse(alive.writes.at(-1)!).type).toBe("update");
  });

  it("心跳：25s 后向客户端发送注释行", () => {
    vi.useFakeTimers();
    const hub = createTeacherHub(() => snap);
    const res = fakeRes();
    hub.handleStream(fakeReq() as any, res as any);
    hub.startHeartbeat();
    vi.advanceTimersByTime(25_000);
    expect(res.writes.at(-1)).toBe(": ping\n\n");
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL，`Cannot find module '../teacherHub'`。

- [ ] **Step 3: 最小实现**

`packages/server/src/teacherHub.ts`：

```ts
import type { Request, Response } from "express";
import type { SSEMessage, TeacherSnapshot } from "@classroom/shared";

export interface TeacherHub {
  handleStream(req: Request, res: Response): void;
  publish(snapshot: TeacherSnapshot): void;
  startHeartbeat(): void;
  clientCount(): number;
}

export function createTeacherHub(getSnapshot: () => TeacherSnapshot): TeacherHub {
  const clients = new Set<Response>();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  function send(res: Response, msg: SSEMessage) {
    res.write(`data: ${JSON.stringify(msg)}\n\n`);
  }

  return {
    handleStream(req, res) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // 连接即推全量快照：中途打开页面/断线重连不缺历史
      send(res, { type: "snapshot", data: getSnapshot() });
      clients.add(res);
      req.on("close", () => clients.delete(res));
    },

    publish(snapshot) {
      // V1：全量重算快照作为 update 推送（20 人规模 <10KB，字段级增量留待性能需要）
      const payload = `data: ${JSON.stringify({ type: "update", data: snapshot })}\n\n`;
      for (const client of clients) {
        try {
          client.write(payload);
        } catch {
          clients.delete(client);
        }
      }
    },

    startHeartbeat() {
      if (heartbeat) return;
      heartbeat = setInterval(() => {
        for (const client of clients) {
          try { client.write(": ping\n\n"); } catch { clients.delete(client); }
        }
      }, 25_000);
    },

    clientCount: () => clients.size,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/teacherHub.ts packages/server/src/__tests__/teacherHub.test.ts
git commit -m "feat(server): teacherHub SSE——连接即推快照、publish 广播更新、25s 心跳"
```

---

### Task 13: index.ts 路由接线 + 集成测试

**Files:**
- Create: `packages/server/src/index.ts`（app 工厂，可注入 dbPath 供测试）、`packages/server/src/main.ts`（入口）
- Modify: `packages/server/package.json`（dev/start 指向 main.ts；devDeps 加 supertest）
- Test: `packages/server/src/__tests__/integration.test.ts`

**Interfaces:**
- Consumes: Task 4–12 全部产物（createPersistence / normalize / createExplainService / createStateManager / createAggregator / createTeacherHub）
- Produces: `createApp(deps?: { dbPath?: string; staticDir?: string }): { app: Express; hub: TeacherHub }`；HTTP 接口（spec §6 V1 全部五个）

- [ ] **Step 1: 加 supertest 依赖并调整脚本**

`packages/server/package.json` 的 scripts 改为（dev/start 从 index.ts 改为 main.ts）：

```json
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "tsx src/main.ts",
    "build": "tsc --noEmit",
    "test": "vitest run"
  },
```

devDependencies 追加：

```json
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.0"
```

Run: `pnpm install`

- [ ] **Step 2: 写失败测试**

`packages/server/src/__tests__/integration.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../index";

function app() {
  return createApp({ dbPath: ":memory:", staticDir: null }).app;
}

const flatError = {
  student_id: "stu001", student_name: "张三", class_id: "3A",
  timestamp: new Date().toISOString(), event_type: "run",
  raw_message: "division by zero", error_type: "ZeroDivisionError",
  error_message: "division by zero", exit_code: 1,
};
const flatSuccess = {
  student_id: "stu001", student_name: "张三", class_id: "3A",
  timestamp: new Date().toISOString(), event_type: "run",
  raw_message: "run success", error_type: "RunSuccess", error_message: "", exit_code: 0,
};

describe("POST /api/events 主流程（测试环境无 LLM_API_KEY → mock 兜底）", () => {
  it("报错上报 → 200；summary 黄色；events 落库带三字段（run 静态映射）", async () => {
    const a = app();
    await request(a).post("/api/events").send(flatError).expect(200, { ok: true });
    const summary = (await request(a).get("/api/summary").expect(200)).body;
    expect(summary.students).toHaveLength(1);
    expect(summary.students[0].status).toBe("yellow");
    const events = (await request(a).get("/api/events").expect(200)).body;
    expect(events[0].category).toBe("运算错误");
    expect(events[0].subtype).toBe("除数为0");
  });

  it("runSuccess → 200，不产生解释（category=运行成功），学生绿色", async () => {
    const a = app();
    await request(a).post("/api/events").send(flatSuccess).expect(200);
    const summary = (await request(a).get("/api/summary").expect(200)).body;
    expect(summary.students[0].status).toBe("green");
    const events = (await request(a).get("/api/events").expect(200)).body;
    expect(events[0].category).toBe("运行成功");
    expect(events[0].subtype).toBeNull();
  });

  it("无效 body → 400", async () => {
    await request(app()).post("/api/events").send({ foo: 1 }).expect(400);
  });
});

describe("GET /api/student/:id", () => {
  it("上报后可查详情（事件倒序）；未知名 404", async () => {
    const a = app();
    await request(a).post("/api/events").send(flatError);
    const d = (await request(a).get("/api/student/stu001").expect(200)).body;
    expect(d.events[0].subtype).toBe("除数为0");
    await request(a).get("/api/student/nope").expect(404);
  });
});

describe("POST /api/suggestions/ack", () => {
  it("ack 后 summary 中该建议标记已处理；缺 id 400", async () => {
    const a = app();
    // 单人单错 → 该 subtype 占比 100% ≥40% → class-review
    await request(a).post("/api/events").send(flatError);
    let summary = (await request(a).get("/api/summary").expect(200)).body;
    expect(summary.suggestions.some((s: any) => s.id === "class-review:除数为0")).toBe(true);
    await request(a).post("/api/suggestions/ack").send({ id: "class-review:除数为0" }).expect(200, { ok: true });
    summary = (await request(a).get("/api/summary").expect(200)).body;
    expect(summary.suggestions.find((s: any) => s.id === "class-review:除数为0").acked).toBe(true);
    await request(a).post("/api/suggestions/ack").send({}).expect(400);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL，`Cannot find module '../index'`。

- [ ] **Step 4: 实现 app 工厂**

`packages/server/src/index.ts`：

```ts
import express, { type Express } from "express";
import cors from "cors";
import path from "node:path";
import type { TeacherSnapshot } from "@classroom/shared";
import { createPersistence } from "./persistence";
import { normalize } from "./eventIngress";
import { createCache } from "./explainService/cache";
import { createExplainService } from "./explainService";
import { createStateManager } from "./stateManager";
import { createAggregator } from "./aggregator";
import { createTeacherHub, type TeacherHub } from "./teacherHub";

export interface AppDeps {
  /** 测试传 ":memory:"；缺省 data/assistant.db（相对 server 包） */
  dbPath?: string;
  /** 生产传 dashboard/dist 目录；缺省/不存在则不托管静态文件 */
  staticDir?: string;
}

export function createApp(deps: AppDeps = {}): { app: Express; hub: TeacherHub } {
  const persistence = createPersistence(deps.dbPath);
  const stateManager = createStateManager();
  const cache = createCache(persistence);
  const explainService = createExplainService(cache);
  const aggregator = createAggregator();

  const buildSnapshot = (): TeacherSnapshot => {
    const now = Date.now();
    const records = stateManager.listRecords();
    return { ts: now, classId: records[0]?.classId ?? "default", ...aggregator.recompute(records, now) };
  };

  const hub = createTeacherHub(buildSnapshot);

  const app = express();
  app.use(cors());
  app.use(express.json());

  // SSE（spec §6）
  app.get("/api/stream/teacher", (req, res) => hub.handleStream(req, res));

  // 学生上报（learner 零改造：flat 格式不变）
  app.post("/api/events", async (req, res) => {
    const ev = normalize(req.body);
    if (!ev) return res.status(400).json({ error: "缺少必要字段" });

    persistence.upsertStudent(ev.studentId, ev.studentName, ev.classId);

    // runSuccess 只记活动信号，不调 LLM（spec §5 / §11 差距 #2）
    const explanation = ev.success ? null : await explainService.explain(ev);

    stateManager.apply(ev, explanation);
    persistence.insertEvent({
      studentId: ev.studentId, classId: ev.classId, eventType: ev.eventType,
      rawMessage: ev.rawMessage,
      category: ev.success ? "运行成功" : explanation!.category,
      subtype: ev.success ? null : explanation!.subtype,
      knowledge: ev.success ? null : explanation!.knowledge,
      filePath: ev.filePath ?? null, lineNo: ev.lineNo ?? null,
      exitCode: ev.exitCode ?? null,
      timestamp: new Date(ev.ts).toISOString(),
    });

    hub.publish(buildSnapshot());
    res.json({ ok: true });
  });

  // 全量快照（首载/断线重连补齐）
  app.get("/api/summary", (_req, res) => res.json(buildSnapshot()));

  // 单生错误历史（抽屉）
  app.get("/api/student/:id", (req, res) => {
    const detail = stateManager.getStudentDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: "未找到该学生" });
    res.json(detail);
  });

  // 标记建议已处理（V1 仅内存）
  app.post("/api/suggestions/ack", (req, res) => {
    const id = typeof req.body?.id === "string" ? req.body.id : null;
    if (!id) return res.status(400).json({ error: "缺少 id" });
    aggregator.ack(id);
    res.json({ ok: true });
  });

  // 调试接口（沿用 demo）
  app.get("/api/events", (req, res) =>
    res.json(persistence.getRecentEvents(parseInt(String(req.query.limit ?? "50"), 10))));
  app.get("/api/stats", (_req, res) => res.json({
    events: persistence.getEventStats(),
    cache: persistence.getCacheStats(),
    runtime: cache.getStats(),
    onlineClients: hub.clientCount(),
  }));

  // 生产：托管 dashboard 构建产物
  if (deps.staticDir) {
    app.use(express.static(deps.staticDir));
    app.get("/", (_req, res) => res.sendFile(path.join(deps.staticDir!, "index.html")));
  }

  return { app, hub };
}
```

`packages/server/src/main.ts`：

```ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "./index";

const PORT = Number(process.env.PORT) || 3000;
const dist = path.resolve(__dirname, "..", "..", "dashboard", "dist");

const { app, hub } = createApp({ staticDir: fs.existsSync(dist) ? dist : undefined });
hub.startHeartbeat();

app.listen(PORT, () => {
  console.log(`[Server] AI 助教服务器运行在 http://localhost:${PORT}`);
  console.log(`[Server] SSE: http://localhost:${PORT}/api/stream/teacher`);
  console.log(`[Server] 仪表盘: ${fs.existsSync(dist) ? `http://localhost:${PORT}/` : "未检测到 dashboard/dist（先 pnpm --filter @classroom/dashboard build）"}`);
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS（含 Task 4–12 全部用例）。
Run: `pnpm --filter @classroom/server build`
Expected: `tsc --noEmit` 无错误。

- [ ] **Step 6: 手工验证 SSE 端到端（curl，supertest 不便测流）**

终端 1 启动：`pnpm dev:server`
终端 2 订阅：`curl -N http://localhost:3000/api/stream/teacher` → 立即看到 `{"type":"snapshot",...}`
终端 3 发事件：`curl -X POST http://localhost:3000/api/events -H "Content-Type: application/json" -d "{\"student_id\":\"stu001\",\"student_name\":\"张三\",\"class_id\":\"3A\",\"timestamp\":\"2026-09-17T02:00:00.000Z\",\"event_type\":\"run\",\"raw_message\":\"division by zero\",\"error_type\":\"ZeroDivisionError\",\"error_message\":\"division by zero\",\"exit_code\":1}"`
Expected: 终端 2 在 POST 后收到一条 `{"type":"update",...}`，students 含 stu001。

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/index.ts packages/server/src/main.ts packages/server/package.json packages/server/src/__tests__/integration.test.ts
git commit -m "feat(server): 路由接线——事件主流程、summary/详情/ack 接口、静态托管"
```

---

### Task 14: dashboard 脚手架 + Pinia store + SSE 客户端 + 时间工具

**Files:**
- Create: `packages/dashboard/`（Vite vue-ts 模板生成后改造）
- Create: `packages/dashboard/src/stores/classroom.ts`、`packages/dashboard/src/api/sse.ts`、`packages/dashboard/src/composables/time.ts`
- Test: `packages/dashboard/src/__tests__/classroom.test.ts`、`sse.test.ts`、`time.test.ts`、`helpers.ts`

**Interfaces:**
- Consumes: `TeacherSnapshot`、`SSEMessage`（@classroom/shared，Task 3）
- Produces:
  - `useClassroom()` Pinia store：state `{ snapshot: TeacherSnapshot | null; sseConnected: boolean; activeStudentId: string | null }`；actions `applySnapshot(s) / applyUpdate(s) / openDrawer(id) / closeDrawer()`；getter `activeStudent`（Task 15–19 组件全部使用）
  - `connectClassroom(store, deps?): () => void`（返回 stop 函数）；`SseDeps { createEventSource?; fetchSummary?; retryDelayMs? }`（App.vue 使用）
  - `fmtTime(ts: number): string`、`fmtAgo(ts: number | null, now?: number): string`

- [ ] **Step 1: 生成脚手架并改造（随本任务交付）**

```bash
cd packages
pnpm create vite dashboard --template vue-ts
```

`packages/dashboard/package.json` 整体替换为：

```json
{
  "name": "@classroom/dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc -b && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "@classroom/shared": "workspace:*",
    "pinia": "^2.2.0",
    "vue": "^3.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.0.0",
    "@vue/test-utils": "^2.4.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0",
    "vue-tsc": "^2.1.0"
  }
}
```

`packages/dashboard/vite.config.ts` 整体替换为：

```ts
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: true } },
  },
  test: { environment: "jsdom" },
});
```

删除模板样板：`src/components/HelloWorld.vue`、`src/assets/vue.svg`、`public/vite.svg`，清空 `src/style.css`（Task 19 重写）。
若 dev 模式报 `@classroom/shared` 解析错误，在 vite.config 的 `defineConfig` 中追加 `optimizeDeps: { exclude: ["@classroom/shared"] }`。

Run: `pnpm install && pnpm --filter @classroom/dashboard build`
Expected: 构建通过。

- [ ] **Step 2: 写失败测试（store / time）**

`packages/dashboard/src/__tests__/helpers.ts`（组件测试公用）：

```ts
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useClassroom } from "../stores/classroom";
import type { TeacherSnapshot } from "@classroom/shared";

export function makeSnapshot(overrides: Partial<TeacherSnapshot> = {}): TeacherSnapshot {
  return {
    ts: 1, classId: "3A", students: [], alerts: [],
    alertSummary: "其余 0 人正常", aggregates: [], suggestions: [], ...overrides,
  };
}

export function mountWithStore(component: any): {
  wrapper: VueWrapper;
  store: ReturnType<typeof useClassroom>;
} {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(component, { global: { plugins: [pinia] } });
  return { wrapper, store: useClassroom() };
}
```

`packages/dashboard/src/__tests__/classroom.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useClassroom } from "../stores/classroom";
import { makeSnapshot } from "./helpers";

describe("classroom store（服务端快照的镜像）", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("applySnapshot / applyUpdate 直接替换快照", () => {
    const s = useClassroom();
    s.applySnapshot(makeSnapshot());
    expect(s.snapshot?.ts).toBe(1);
    s.applyUpdate(makeSnapshot({ ts: 2 }));
    expect(s.snapshot?.ts).toBe(2);
  });

  it("openDrawer / closeDrawer 与 activeStudent getter", () => {
    const s = useClassroom();
    s.applySnapshot(makeSnapshot({
      students: [{
        studentId: "stu001", studentName: "张三", status: "green", priorityScore: 0,
        lastActivityAt: 1, lastErrorAt: null, errorCountTotal: 0, recentErrors: [],
      }],
    }));
    expect(s.activeStudent).toBeNull();
    s.openDrawer("stu001");
    expect(s.activeStudent?.studentName).toBe("张三");
    s.closeDrawer();
    expect(s.activeStudentId).toBeNull();
  });
});
```

`packages/dashboard/src/__tests__/time.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { fmtTime, fmtAgo } from "../composables/time";

describe("时间工具（spec §7：zh-CN 24 小时制，本地时区）", () => {
  it("fmtTime 输出 HH:mm:ss", () => {
    expect(fmtTime(Date.parse("2026-09-17T04:05:06.000Z"))).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
  it("fmtAgo：刚刚 / N 分钟前 / 占位", () => {
    const now = Date.parse("2026-09-17T04:00:00.000Z");
    expect(fmtAgo(now - 30_000, now)).toBe("刚刚");
    expect(fmtAgo(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(fmtAgo(null, now)).toBe("—");
  });
});
```

- [ ] **Step 3: 写失败测试（SSE 客户端）**

`packages/dashboard/src/__tests__/sse.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { connectClassroom } from "../api/sse";
import { useClassroom } from "../stores/classroom";
import { makeSnapshot } from "./helpers";

class FakeES {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) { this.url = url; }
  close() { this.closed = true; }
}

describe("connectClassroom（断线 5s 重连，重连先拉 summary 对齐——spec §8）", () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.useFakeTimers(); });

  it("连接：先拉 summary 对齐，再建 EventSource", async () => {
    const store = useClassroom();
    const es = new FakeES("/api/stream/teacher");
    const stop = connectClassroom(store, {
      fetchSummary: async () => makeSnapshot({ ts: 1 }),
      createEventSource: () => es as any,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.snapshot?.ts).toBe(1);
    expect(es.url).toBe("/api/stream/teacher");
    stop();
  });

  it("收到 snapshot / update 消息 → 更新 store", async () => {
    const store = useClassroom();
    const es = new FakeES("");
    connectClassroom(store, {
      fetchSummary: async () => makeSnapshot({ ts: 1 }),
      createEventSource: () => es as any,
    });
    await vi.advanceTimersByTimeAsync(0);
    es.onmessage!({ data: JSON.stringify({ type: "update", data: makeSnapshot({ ts: 2 }) }) });
    expect(store.snapshot?.ts).toBe(2);
  });

  it("onerror：关闭连接，5s 后重连并重新对齐 summary", async () => {
    const store = useClassroom();
    const fetchSummary = vi.fn().mockResolvedValue(makeSnapshot({ ts: 1 }));
    const es1 = new FakeES("");
    let current = es1;
    const stop = connectClassroom(store, {
      fetchSummary,
      createEventSource: () => { const e = current; current = new FakeES(""); return e as any; },
      retryDelayMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    es1.onerror!();
    expect(es1.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchSummary).toHaveBeenCalledTimes(2);
    stop();
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm --filter @classroom/dashboard test`
Expected: FAIL，找不到 `../stores/classroom`、`../api/sse`、`../composables/time`。

- [ ] **Step 5: 最小实现**

`packages/dashboard/src/stores/classroom.ts`：

```ts
import { defineStore } from "pinia";
import type { TeacherSnapshot } from "@classroom/shared";

export const useClassroom = defineStore("classroom", {
  state: () => ({
    snapshot: null as TeacherSnapshot | null,
    sseConnected: false,
    activeStudentId: null as string | null,
  }),
  actions: {
    applySnapshot(s: TeacherSnapshot) { this.snapshot = s; },
    applyUpdate(s: TeacherSnapshot) { this.snapshot = s; }, // V1：全量替换（见 Task 12 取舍）
    openDrawer(id: string) { this.activeStudentId = id; },
    closeDrawer() { this.activeStudentId = null; },
  },
  getters: {
    activeStudent(state) {
      return state.snapshot?.students.find((s) => s.studentId === state.activeStudentId) ?? null;
    },
  },
});
```

`packages/dashboard/src/api/sse.ts`：

```ts
import type { TeacherSnapshot } from "@classroom/shared";

interface StoreLike {
  applySnapshot(s: TeacherSnapshot): void;
  applyUpdate(s: TeacherSnapshot): void;
  sseConnected: boolean;
}

export interface SseDeps {
  createEventSource?: (url: string) => EventSource;
  fetchSummary?: () => Promise<TeacherSnapshot>;
  retryDelayMs?: number;
}

export function connectClassroom(store: StoreLike, deps: SseDeps = {}) {
  const createES = deps.createEventSource ?? ((url: string) => new EventSource(url));
  const fetchSummary =
    deps.fetchSummary ??
    (async () => {
      const r = await fetch("/api/summary");
      if (!r.ok) throw new Error(`summary ${r.status}`);
      return (await r.json()) as TeacherSnapshot;
    });
  const retryMs = deps.retryDelayMs ?? 5000;

  let es: EventSource | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function start() {
    // 首载/重连先拉 summary 对齐（spec §8：断线重连成功先补齐快照）
    try {
      store.applySnapshot(await fetchSummary());
    } catch {
      /* 服务未起：走 EventSource 错误分支重试 */
    }
    if (stopped) return;
    es = createES("/api/stream/teacher");
    es.onopen = () => { store.sseConnected = true; };
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "snapshot") store.applySnapshot(msg.data);
      else store.applyUpdate(msg.data);
    };
    es.onerror = () => {
      store.sseConnected = false;
      es?.close();
      es = null;
      if (!stopped && timer === null) {
        timer = setTimeout(() => { timer = null; void start(); }, retryMs);
      }
    };
  }

  void start();
  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    es?.close();
  };
}
```

`packages/dashboard/src/composables/time.ts`：

```ts
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

export function fmtAgo(ts: number | null, now = Date.now()): string {
  if (ts === null) return "—";
  const m = Math.floor((now - ts) / 60_000);
  return m < 1 ? "刚刚" : `${m} 分钟前`;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @classroom/dashboard test`
Expected: PASS（store 2 + time 2 + sse 3 用例）。

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard pnpm-lock.yaml
git commit -m "feat(dashboard): Vite 脚手架、Pinia 快照镜像 store、SSE 客户端（5s 重连+summary 对齐）"
```

---

### Task 15: AlertPanel（告警条）

**Files:**
- Create: `packages/dashboard/src/components/AlertPanel.vue`
- Test: `packages/dashboard/src/__tests__/AlertPanel.test.ts`

**Interfaces:**
- Consumes: `useClassroom()`（Task 14 store）
- Produces: 组件（App.vue Task 19 使用）；点击 [查看] 调 `store.openDrawer(studentId)`

- [ ] **Step 1: 写失败测试**

`packages/dashboard/src/__tests__/AlertPanel.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import AlertPanel from "../components/AlertPanel.vue";
import { makeSnapshot, mountWithStore } from "./helpers";

const alerts = [
  { studentId: "stu001", studentName: "张三", score: 70, reason: "同一错误 5 分钟内 3 次", subtype: "缺少冒号", knowledge: "函数定义末尾要加冒号", lastErrorAt: 1 },
  { studentId: "stu002", studentName: "李四", score: 35, reason: "连续报错 5 次", subtype: "未定义变量", knowledge: "变量要先赋值再使用", lastErrorAt: 1 },
];

describe("AlertPanel", () => {
  it("渲染告警（姓名/分数/reason/subtype）与 alertSummary", async () => {
    const { wrapper, store } = mountWithStore(AlertPanel);
    store.applySnapshot(makeSnapshot({ alerts, alertSummary: "其余 3 人正常" }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("张三");
    expect(wrapper.text()).toContain("70");
    expect(wrapper.text()).toContain("同一错误 5 分钟内 3 次");
    expect(wrapper.text()).toContain("缺少冒号");
    expect(wrapper.text()).toContain("其余 3 人正常");
  });

  it("[查看] 打开抽屉；[发提示] 禁用（V2）", async () => {
    const { wrapper, store } = mountWithStore(AlertPanel);
    store.applySnapshot(makeSnapshot({ alerts }));
    await wrapper.vm.$nextTick();
    const buttons = wrapper.findAll("button");
    await buttons[0].trigger("click"); // 第一个按钮是 [查看]
    expect(store.activeStudentId).toBe("stu001");
    const disabled = buttons.filter((b) => (b.element as HTMLButtonElement).disabled);
    expect(disabled.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/dashboard test`
Expected: FAIL，无法解析 `../components/AlertPanel.vue`。

- [ ] **Step 3: 最小实现**

`packages/dashboard/src/components/AlertPanel.vue`：

```vue
<script setup lang="ts">
import { useClassroom } from "../stores/classroom";
const store = useClassroom();
</script>

<template>
  <section class="alert-panel" v-if="store.snapshot">
    <h2>优先帮助</h2>
    <div class="alert" v-for="a in store.snapshot.alerts" :key="a.studentId">
      <span class="score">{{ a.score }}</span>
      <div class="body">
        <strong>{{ a.studentName }}</strong>
        <span class="reason">{{ a.reason }}</span>
        <span class="subtype">{{ a.subtype }} · {{ a.knowledge }}</span>
      </div>
      <button class="view" @click="store.openDrawer(a.studentId)">查看</button>
      <button disabled title="V2 开放">发提示</button>
    </div>
    <p class="summary">{{ store.snapshot.alertSummary }}</p>
  </section>
</template>

<style scoped>
.alert-panel { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
.alert-panel h2 { margin: 0 0 8px; font-size: 15px; }
.alert { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); }
.alert:last-of-type { border-bottom: none; }
.score { min-width: 36px; text-align: center; background: var(--red); color: #fff; border-radius: 4px; padding: 2px 6px; font-weight: 600; }
.body { display: flex; flex-direction: column; flex: 1; font-size: 13px; }
.reason { color: var(--muted); }
.subtype { color: var(--accent); font-size: 12px; }
.summary { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
</style>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/dashboard test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/components/AlertPanel.vue packages/dashboard/src/__tests__/AlertPanel.test.ts
git commit -m "feat(dashboard): 告警条组件（top5、分数、reason、查看/发提示占位）"
```

---

### Task 16: StudentMatrix（学生矩阵）

**Files:**
- Create: `packages/dashboard/src/components/StudentMatrix.vue`
- Test: `packages/dashboard/src/__tests__/StudentMatrix.test.ts`

**Interfaces:**
- Consumes: `useClassroom()`（Task 14）；`fmtTime`（Task 14）
- Produces: 组件；点击格子调 `store.openDrawer(studentId)`；悬停 title 显示最近 3 条错误

- [ ] **Step 1: 写失败测试**

`packages/dashboard/src/__tests__/StudentMatrix.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import StudentMatrix from "../components/StudentMatrix.vue";
import { makeSnapshot, mountWithStore } from "./helpers";

const students = [
  { studentId: "stu001", studentName: "张三", status: "red", priorityScore: 70, lastActivityAt: 1, lastErrorAt: 1, errorCountTotal: 3, recentErrors: [{ ts: 1, subtype: "缺少冒号", knowledge: "k", rawMessage: "m" }] },
  { studentId: "stu002", studentName: "李四", status: "yellow", priorityScore: 15, lastActivityAt: 1, lastErrorAt: 1, errorCountTotal: 1, recentErrors: [] },
  { studentId: "stu003", studentName: "王五", status: "green", priorityScore: 0, lastActivityAt: 1, lastErrorAt: null, errorCountTotal: 0, recentErrors: [] },
];

describe("StudentMatrix", () => {
  it("渲染全部学生格子与状态色 class；悬停 title 含最近错误", async () => {
    const { wrapper, store } = mountWithStore(StudentMatrix);
    store.applySnapshot(makeSnapshot({ students }));
    await wrapper.vm.$nextTick();
    const tiles = wrapper.findAll(".tile");
    expect(tiles).toHaveLength(3);
    expect(tiles[0].classes()).toContain("red");
    expect(tiles[1].classes()).toContain("yellow");
    expect(tiles[2].classes()).toContain("green");
    expect(tiles[0].attributes("title")).toContain("缺少冒号");
    expect(wrapper.text()).toContain("张三");
  });

  it("点击格子打开抽屉", async () => {
    const { wrapper, store } = mountWithStore(StudentMatrix);
    store.applySnapshot(makeSnapshot({ students }));
    await wrapper.vm.$nextTick();
    await wrapper.findAll(".tile")[1].trigger("click");
    expect(store.activeStudentId).toBe("stu002");
  });

  it("空数据显示占位", async () => {
    const { wrapper, store } = mountWithStore(StudentMatrix);
    store.applySnapshot(makeSnapshot());
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("等待学生上报");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/dashboard test`
Expected: FAIL，无法解析组件。

- [ ] **Step 3: 最小实现**

`packages/dashboard/src/components/StudentMatrix.vue`：

```vue
<script setup lang="ts">
import { useClassroom } from "../stores/classroom";
import { fmtTime } from "../composables/time";
import type { RecentError } from "@classroom/shared";

const store = useClassroom();

function tooltip(recent: RecentError[]): string {
  return recent.map((r) => `${fmtTime(r.ts)} ${r.subtype}｜${r.knowledge}`).join("\n") || "暂无错误";
}
</script>

<template>
  <section class="matrix" v-if="store.snapshot">
    <h2>全班状态</h2>
    <div class="grid" v-if="store.snapshot.students.length">
      <div
        v-for="s in store.snapshot.students"
        :key="s.studentId"
        class="tile"
        :class="s.status"
        :title="tooltip(s.recentErrors)"
        @click="store.openDrawer(s.studentId)"
      >
        <span class="dot" />{{ s.studentName }}
      </div>
    </div>
    <p v-else class="empty">等待学生上报…</p>
  </section>
</template>

<style scoped>
.matrix { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
.matrix h2 { margin: 0 0 8px; font-size: 15px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
.tile { display: flex; align-items: center; gap: 6px; padding: 10px 8px; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-size: 14px; }
.tile:hover { border-color: var(--accent); }
.tile.red { background: #fef2f2; }
.tile.yellow { background: #fffbeb; }
.tile.green { background: #f0fdf4; }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.tile.red .dot { background: var(--red); }
.tile.yellow .dot { background: var(--yellow); }
.tile.green .dot { background: var(--green); }
.empty { color: var(--muted); font-size: 13px; }
</style>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/dashboard test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/components/StudentMatrix.vue packages/dashboard/src/__tests__/StudentMatrix.test.ts
git commit -m "feat(dashboard): 学生矩阵（响应式网格、状态色、悬停最近错误、点击开抽屉）"
```

---

### Task 17: ErrorAggPanel（错误聚合）

**Files:**
- Create: `packages/dashboard/src/components/ErrorAggPanel.vue`
- Test: `packages/dashboard/src/__tests__/ErrorAggPanel.test.ts`

**Interfaces:**
- Consumes: `useClassroom()`（Task 14）
- Produces: 组件；组行点击展开/收起学生名单

- [ ] **Step 1: 写失败测试**

`packages/dashboard/src/__tests__/ErrorAggPanel.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import ErrorAggPanel from "../components/ErrorAggPanel.vue";
import { makeSnapshot, mountWithStore } from "./helpers";

const aggregates = [
  { subtype: "缺少冒号", category: "", knowledge: "函数定义末尾要加冒号", count: 8, students: [{ studentId: "stu001", studentName: "张三" }, { studentId: "stu002", studentName: "李四" }] },
  { subtype: "意外缩进", category: "", knowledge: "缩进规则：Python 靠缩进划分代码块", count: 5, students: [{ studentId: "stu003", studentName: "王五" }] },
];

describe("ErrorAggPanel", () => {
  it("按 subtype 渲染分组：人数 + knowledge 文案", async () => {
    const { wrapper, store } = mountWithStore(ErrorAggPanel);
    store.applySnapshot(makeSnapshot({ aggregates }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("缺少冒号");
    expect(wrapper.text()).toContain("8 人");
    expect(wrapper.text()).toContain("函数定义末尾要加冒号");
    expect(wrapper.text()).toContain("意外缩进");
  });

  it("点击组行展开学生名单，再点收起", async () => {
    const { wrapper, store } = mountWithStore(ErrorAggPanel);
    store.applySnapshot(makeSnapshot({ aggregates }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".names").exists()).toBe(false);
    await wrapper.findAll(".bar-row")[0].trigger("click");
    expect(wrapper.find(".names").text()).toContain("张三");
    await wrapper.findAll(".bar-row")[0].trigger("click");
    expect(wrapper.find(".names").exists()).toBe(false);
  });

  it("空数据占位", async () => {
    const { wrapper, store } = mountWithStore(ErrorAggPanel);
    store.applySnapshot(makeSnapshot());
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("暂无聚合数据");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/dashboard test`
Expected: FAIL，无法解析组件。

- [ ] **Step 3: 最小实现**

`packages/dashboard/src/components/ErrorAggPanel.vue`：

```vue
<script setup lang="ts">
import { computed, ref } from "vue";
import { useClassroom } from "../stores/classroom";

const store = useClassroom();
const expanded = ref<string | null>(null);

const maxCount = computed(() =>
  Math.max(1, ...(store.snapshot?.aggregates.map((g) => g.count) ?? [1])),
);

function toggle(subtype: string) {
  expanded.value = expanded.value === subtype ? null : subtype;
}
</script>

<template>
  <section class="agg" v-if="store.snapshot">
    <h2>错误聚合</h2>
    <div class="group" v-for="g in store.snapshot.aggregates" :key="g.subtype">
      <div class="bar-row" @click="toggle(g.subtype)">
        <div class="bar" :style="{ width: `${(g.count / maxCount) * 100}%` }" />
        <span class="label">{{ g.subtype }} {{ g.count }} 人</span>
      </div>
      <p class="knowledge">{{ g.knowledge }}</p>
      <ul v-if="expanded === g.subtype" class="names">
        <li v-for="s in g.students" :key="s.studentId">{{ s.studentName }}</li>
      </ul>
    </div>
    <p v-if="store.snapshot.aggregates.length === 0" class="empty">暂无聚合数据</p>
  </section>
</template>

<style scoped>
.agg { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
.agg h2 { margin: 0 0 8px; font-size: 15px; }
.group { margin-bottom: 10px; }
.bar-row { display: flex; align-items: center; gap: 8px; cursor: pointer; background: var(--bg); border-radius: 4px; overflow: hidden; }
.bar { height: 22px; background: var(--accent); opacity: 0.75; border-radius: 4px 0 0 4px; }
.label { font-size: 13px; padding: 0 8px; white-space: nowrap; }
.knowledge { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
.names { margin: 4px 0 0; padding-left: 20px; font-size: 13px; color: var(--text); }
.empty { color: var(--muted); font-size: 13px; }
</style>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/dashboard test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/components/ErrorAggPanel.vue packages/dashboard/src/__tests__/ErrorAggPanel.test.ts
git commit -m "feat(dashboard): 错误聚合面板（subtype 分组条形、展开名单、知识点文案）"
```

---

### Task 18: SuggestionBar（教学建议）

**Files:**
- Create: `packages/dashboard/src/components/SuggestionBar.vue`
- Test: `packages/dashboard/src/__tests__/SuggestionBar.test.ts`

**Interfaces:**
- Consumes: `useClassroom()`（Task 14）；`POST /api/suggestions/ack`（Task 13）
- Produces: 组件；[标记已处理] → 调 ack API → 本地立即隐藏（服务端下次 update 也会带 acked，双保险）

- [ ] **Step 1: 写失败测试**

`packages/dashboard/src/__tests__/SuggestionBar.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import SuggestionBar from "../components/SuggestionBar.vue";
import { makeSnapshot, mountWithStore } from "./helpers";

const suggestions = [
  { id: "class-review:缺少冒号", kind: "class-review", text: "⚠️ 8 人卡在「缺少冒号」，建议全班讲评", acked: false },
  { id: "individual:stu001", kind: "individual", text: "🙋 张三 连续报错，建议单独辅导", acked: false },
  { id: "group-discuss:意外缩进", kind: "group-discuss", text: "💡 2 人遇到「意外缩进」，可小组讨论", acked: true },
];

describe("SuggestionBar", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("渲染未处理建议，已处理（acked）不显示", async () => {
    const { wrapper, store } = mountWithStore(SuggestionBar);
    store.applySnapshot(makeSnapshot({ suggestions }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("全班讲评");
    expect(wrapper.text()).toContain("单独辅导");
    expect(wrapper.text()).not.toContain("小组讨论"); // acked=true 的不渲染
  });

  it("[标记已处理] 调 ack API 并本地隐藏", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper, store } = mountWithStore(SuggestionBar);
    store.applySnapshot(makeSnapshot({ suggestions }));
    await wrapper.vm.$nextTick();
    await wrapper.findAll("button")[0].trigger("click");
    await wrapper.vm.$nextTick();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/suggestions/ack",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ id: "class-review:缺少冒号" }),
      }),
    );
    expect(wrapper.text()).not.toContain("全班讲评");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @classroom/dashboard test`
Expected: FAIL，无法解析组件。

- [ ] **Step 3: 最小实现**

`packages/dashboard/src/components/SuggestionBar.vue`：

```vue
<script setup lang="ts">
import { computed } from "vue";
import { useClassroom } from "../stores/classroom";

const store = useClassroom();
const visible = computed(() => store.snapshot?.suggestions.filter((s) => !s.acked) ?? []);

async function ack(id: string) {
  try {
    await fetch("/api/suggestions/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } finally {
    // 服务端下次 update 会带 acked；本地立即隐藏（双保险）
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
  <section class="suggestions" v-if="store.snapshot && visible.length">
    <div class="card" v-for="s in visible" :key="s.id" :class="s.kind">
      <span>{{ s.text }}</span>
      <button @click="ack(s.id)">标记已处理</button>
    </div>
  </section>
</template>

<style scoped>
.suggestions { display: flex; flex-wrap: wrap; gap: 8px; }
.card { display: flex; align-items: center; gap: 10px; background: var(--card); border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 6px; padding: 8px 12px; font-size: 13px; }
.card.class-review { border-left-color: var(--red); }
.card.group-discuss { border-left-color: var(--yellow); }
.card.individual { border-left-color: var(--green); }
</style>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @classroom/dashboard test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/components/SuggestionBar.vue packages/dashboard/src/__tests__/SuggestionBar.test.ts
git commit -m "feat(dashboard): 教学建议条（未处理渲染、ack 调用与本地隐藏）"
```

---

### Task 19: StudentDrawer + App 布局 + 样式（dashboard 收尾）

**Files:**
- Create: `packages/dashboard/src/components/StudentDrawer.vue`
- Modify: `packages/dashboard/src/App.vue`（整体替换）、`packages/dashboard/src/main.ts`（整体替换）、`packages/dashboard/src/style.css`（整体替换）
- Test: `packages/dashboard/src/__tests__/StudentDrawer.test.ts`、`App.test.ts`

**Interfaces:**
- Consumes: `useClassroom()`、`fmtTime / fmtAgo`（Task 14）；`GET /api/student/:id`（Task 13）
- Produces: 完整可运行仪表盘（布局：标题+SSE 状态 → SuggestionBar → AlertPanel → 主区 StudentMatrix/ErrorAggPanel → StudentDrawer 浮层）

- [ ] **Step 1: 写失败测试（StudentDrawer）**

`packages/dashboard/src/__tests__/StudentDrawer.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import StudentDrawer from "../components/StudentDrawer.vue";
import { makeSnapshot, mountWithStore } from "./helpers";

const students = [
  { studentId: "stu001", studentName: "张三", status: "red", priorityScore: 70, lastActivityAt: 5 * 60_000, lastErrorAt: 5 * 60_000, errorCountTotal: 3, recentErrors: [] },
];

const detail = {
  studentId: "stu001", studentName: "张三",
  events: [
    { ts: 2000, eventType: "run", success: false, subtype: "缺少冒号", knowledge: "函数定义末尾要加冒号", rawMessage: 'SyntaxError: expected ":"' },
    { ts: 1000, eventType: "run", success: true, subtype: null, knowledge: null, rawMessage: "run success" },
  ],
  lastActivityAt: 2000, lastErrorAt: 2000,
};

describe("StudentDrawer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("打开抽屉拉取详情：姓名、错误历史（倒序，含成功事件）、停留时长", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => detail }));
    const { wrapper, store } = mountWithStore(StudentDrawer);
    store.applySnapshot(makeSnapshot({ students }));
    store.openDrawer("stu001");
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("张三");
    expect(wrapper.text()).toContain("缺少冒号");
    expect(wrapper.text()).toContain("运行成功"); // 成功事件 subtype 显示为「运行成功」
    expect(wrapper.text()).toContain("分钟前");
    // 关闭按钮
    await wrapper.find("button.close").trigger("click");
    expect(store.activeStudentId).toBeNull();
  });

  it("未打开时不渲染", () => {
    const { wrapper } = mountWithStore(StudentDrawer);
    expect(wrapper.find(".drawer").exists()).toBe(false);
  });
});
```

- [ ] **Step 2: 写失败测试（App 集成挂载）**

`packages/dashboard/src/__tests__/App.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import App from "../App.vue";
import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";

class FakeES {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe("App", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("挂载：标题渲染、SSE 连接建立、四组件 + 抽屉就位", async () => {
    const es = new FakeES();
    vi.stubGlobal("EventSource", vi.fn().mockImplementation(() => es));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => null }));
    const wrapper = mount(App, { global: { plugins: [createPinia()] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(wrapper.text()).toContain("课堂教学实时助教");
    expect(wrapper.text()).toContain("优先帮助");
    expect(wrapper.text()).toContain("全班状态");
    expect(wrapper.text()).toContain("错误聚合");
    expect(wrapper.text()).toContain("等待学生上报");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @classroom/dashboard test`
Expected: FAIL，找不到 `StudentDrawer.vue` / App 内容为模板默认。

- [ ] **Step 4: 实现**

`packages/dashboard/src/components/StudentDrawer.vue`：

```vue
<script setup lang="ts">
import { ref, watch } from "vue";
import { useClassroom } from "../stores/classroom";
import { fmtTime, fmtAgo } from "../composables/time";

const store = useClassroom();
const detail = ref<{
  studentId: string; studentName: string;
  events: { ts: number; eventType: string; success: boolean; subtype: string | null; knowledge: string | null; rawMessage: string }[];
  lastActivityAt: number; lastErrorAt: number | null;
} | null>(null);

watch(
  () => store.activeStudentId,
  async (id) => {
    detail.value = null;
    if (!id) return;
    try {
      const res = await fetch(`/api/student/${id}`);
      detail.value = res.ok ? await res.json() : null;
    } catch {
      detail.value = null;
    }
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="store.activeStudentId" class="drawer-mask" @click.self="store.closeDrawer()">
    <aside class="drawer">
      <header>
        <h3>{{ store.activeStudent?.studentName ?? detail?.studentName ?? "未知学生" }}</h3>
        <span class="status" :class="store.activeStudent?.status">{{ store.activeStudent?.status ?? "" }}</span>
        <button class="close" @click="store.closeDrawer()">×</button>
      </header>
      <p v-if="store.activeStudent" class="meta">
        停留：{{ fmtAgo(store.activeStudent.lastActivityAt) }}
      </p>
      <ul v-if="detail" class="history">
        <li v-for="(e, i) in detail.events" :key="i" :class="{ success: e.success }">
          <span class="t">{{ fmtTime(e.ts) }}</span>
          <strong>{{ e.success ? "运行成功" : e.subtype }}</strong>
          <span class="k">{{ e.knowledge ?? "" }}</span>
          <code>{{ e.rawMessage }}</code>
        </li>
      </ul>
      <button disabled title="V2 开放">发提示</button>
    </aside>
  </div>
</template>

<style scoped>
.drawer-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.3); display: flex; justify-content: flex-end; z-index: 10; }
.drawer { width: 380px; background: var(--card); height: 100%; padding: 16px; overflow-y: auto; box-shadow: -4px 0 16px rgba(0, 0, 0, 0.1); }
header { display: flex; align-items: center; gap: 8px; }
header h3 { margin: 0; flex: 1; }
.status { font-size: 12px; padding: 2px 8px; border-radius: 4px; }
.status.red { background: #fef2f2; color: var(--red); }
.status.yellow { background: #fffbeb; color: var(--yellow); }
.status.green { background: #f0fdf4; color: var(--green); }
.close { border: none; background: none; font-size: 20px; cursor: pointer; }
.meta { color: var(--muted); font-size: 13px; }
.history { list-style: none; padding: 0; margin: 12px 0; }
.history li { padding: 8px 0; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.history li.success { color: var(--green); }
.history .t { color: var(--muted); font-size: 12px; }
.history .k { color: var(--muted); }
.history code { font-size: 12px; color: var(--accent); word-break: break-all; }
</style>
```

`packages/dashboard/src/App.vue`（整体替换）：

```vue
<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useClassroom } from "./stores/classroom";
import { connectClassroom } from "./api/sse";
import AlertPanel from "./components/AlertPanel.vue";
import StudentMatrix from "./components/StudentMatrix.vue";
import ErrorAggPanel from "./components/ErrorAggPanel.vue";
import SuggestionBar from "./components/SuggestionBar.vue";
import StudentDrawer from "./components/StudentDrawer.vue";

const store = useClassroom();
let stopSse: (() => void) | null = null;
onMounted(() => { stopSse = connectClassroom(store); });
onUnmounted(() => stopSse?.());
</script>

<template>
  <div class="app">
    <header class="app-header">
      <h1>课堂教学实时助教</h1>
      <span class="conn" :class="store.sseConnected ? 'on' : 'off'">
        {{ store.sseConnected ? "已连接" : "连接中断，重试中…" }}
      </span>
    </header>
    <SuggestionBar />
    <AlertPanel />
    <main>
      <StudentMatrix />
      <ErrorAggPanel />
    </main>
    <StudentDrawer />
  </div>
</template>
```

`packages/dashboard/src/main.ts`（整体替换）：

```ts
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./style.css";

createApp(App).use(createPinia()).mount("#app");
```

`packages/dashboard/src/style.css`（整体替换）：

```css
:root {
  --bg: #f4f6f8;
  --card: #ffffff;
  --text: #1f2937;
  --muted: #6b7280;
  --border: #e5e7eb;
  --accent: #2563eb;
  --green: #22c55e;
  --yellow: #f59e0b;
  --red: #ef4444;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: var(--bg); color: var(--text); }
.app { display: flex; flex-direction: column; gap: 12px; padding: 0 16px 24px; }
.app-header { display: flex; align-items: center; justify-content: space-between; background: #1e293b; color: #fff; margin: 0 -16px; padding: 12px 20px; }
.app-header h1 { font-size: 18px; margin: 0; }
.conn { font-size: 12px; }
.conn.on { color: #4ade80; }
.conn.off { color: #f87171; }
main { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; }
</style>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @classroom/dashboard test`
Expected: PASS（Task 14–19 全部用例）。
Run: `pnpm --filter @classroom/dashboard build`
Expected: `vue-tsc -b && vite build` 成功产出 dist。

- [ ] **Step 6: 手工验证（浏览器，开发模式联调）**

终端 1：`pnpm dev:server`；终端 2：`pnpm dev:dashboard`；浏览器开 `http://localhost:5173`：
1. 空态显示「等待学生上报…」
2. 用 Task 13 Step 6 的 curl 发 1 条报错 → 矩阵出现张三（黄）、告警条出现、聚合面板出现「除数为0 1 人」、建议条出现「⚠️ 1 人卡在…」
3. 点击矩阵格 → 抽屉打开显示错误历史
4. [标记已处理] → 建议消失
5. 杀掉 server（Ctrl+C）→ 状态点变红「连接中断」→ 重启 server → 5s 内恢复「已连接」且数据对齐

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/src
git commit -m "feat(dashboard): 学生抽屉、App 布局与全局样式，五模块齐备"
```

---

### Task 20: 模拟器升级 + 20 人端到端压测

**Files:**
- Create: `tools/simulator.js`（从 demo `simulator.js` 重写，数据样本沿用）

**Interfaces:**
- Consumes: `POST /api/events`（Task 13）
- Produces: 命令行工具 `node tools/simulator.js [--url=...] [--students=N] [--interval=ms] [--success-ratio=0.3]`

- [ ] **Step 1: 写模拟器（Node 脚本，手动验证为主）**

`tools/simulator.js`：

```js
/**
 * 学生端模拟器（升级版）
 * 发送与 learner reporter 完全一致的 flat 格式。
 * 用法：node tools/simulator.js [--url=http://localhost:3000] [--students=20] [--interval=2000] [--success-ratio=0.3]
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);
const URL = args.url || "http://localhost:3000";
const N = parseInt(args.students || "3", 10);
const INTERVAL = parseInt(args.interval || "2000", 10);
const SUCCESS_RATIO = parseFloat(args["success-ratio"] || "0.3");

const NAMES = ["张三","李四","王五","赵六","钱七","孙八","周九","吴十","郑一","王二","冯三","陈四","褚五","卫六","蒋七","沈八","韩九","杨十","朱一","秦二"];

// 真实样本（沿用 demo，来自 pylearner 实际记录）
const DIAG_SAMPLES = [
  '应为 ":"',
  "Expected an indented block",
  "name 'x' is not defined",
  "unsupported operand type(s) for +: 'str' and 'int'",
  "list index out of range",
];
const RUN_ERRORS = [
  { error_type: "SyntaxError", error_message: 'expected ":"' },
  { error_type: "ZeroDivisionError", error_message: "division by zero", file: "simple_functions.py", line: 30 },
  { error_type: "IndentationError", error_message: "expected an indented block" },
  { error_type: "NameError", error_message: "name 'totl' is not defined", file: "simple_functions.py", line: 12 },
  { error_type: "TypeError", error_message: 'can only concatenate str (not "int") to str' },
];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function post(body) {
  const res = await fetch(`${URL}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`[Sim] 上报失败 ${res.status}`);
}

function nextEvent() {
  const i = Math.floor(Math.random() * N);
  const student = {
    student_id: `stu${String(i + 1).padStart(3, "0")}`,
    student_name: NAMES[i % NAMES.length],
    class_id: "3A",
    timestamp: new Date().toISOString(),
  };
  if (Math.random() < SUCCESS_RATIO) {
    return { ...student, event_type: "run", raw_message: "run success", error_type: "RunSuccess", error_message: "", exit_code: 0, command: "python simple_functions.py", source: "terminal" };
  }
  if (Math.random() < 0.5) {
    const sample = pick(DIAG_SAMPLES);
    return { ...student, event_type: "diag", raw_message: sample, samples: [sample], file_path: "simple_functions.py" };
  }
  const e = pick(RUN_ERRORS);
  return { ...student, event_type: "run", raw_message: e.error_message, error_type: e.error_type, error_message: e.error_message, exit_code: 1, file_path: e.file, line_no: e.line, command: "python simple_functions.py", source: "terminal" };
}

let sent = 0;
console.log(`[Sim] ${N} 名学生 → ${URL}，间隔 ${INTERVAL}ms，成功率 ${SUCCESS_RATIO}`);
(async function loop() {
  while (true) {
    await post(nextEvent());
    sent++;
    if (sent % 20 === 0) console.log(`[Sim] 已发送 ${sent} 条`);
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
})();
```

- [ ] **Step 2: 联调验证（验收即测试）**

终端 1：`pnpm dev:server`；终端 2：`node tools/simulator.js --students=20 --interval=2000`；浏览器开 `http://localhost:3000/`（需先 `pnpm --filter @classroom/dashboard build`，或另开 `pnpm dev:dashboard` 用 5173）。

持续 2 分钟，逐项确认：
- [ ] 矩阵 20 格，红/黄/绿分布随时间变化（diag 样本仅 5 种，重复上报会出现红）
- [ ] 告警条 top5 按分数排序，其余 N 人正常
- [ ] 聚合面板按 subtype 分组（缺少冒号/意外缩进/除数为0 等），人数正确
- [ ] 有 subtype 占比 ≥40% 时建议条出现「全班讲评」；≥20% 出现「小组讨论」
- [ ] 抽屉打开任一学生，错误历史倒序、成功事件显示「运行成功」
- [ ] `curl http://localhost:3000/api/stats` 的 cache.total ≥ 1 且随错误种类数增长（同错误只解释一次）

- [ ] **Step 3: Commit**

```bash
git add tools/simulator.js
git commit -m "feat(tools): 学生模拟器升级（可配人数/间隔/成功率，含 runSuccess）"
```

---

### Task 21: learner 放开 runSuccess 上报（vscode-pylearner 仓库，约 5 行）

背景（2026-09-17 更新）：
1. 教师上报管道的编译错误**已由用户修复**（`buildPayload` 改为显式接收 `deps` 传参；`applyTeacherReporter` 改 async 并正确 `await secrets.get`，支持配置变化动态开关；移除 profile 视图；`teacherEnabled` 默认改为 true）——`npx tsc --noEmit` 通过。**修复在工作区尚未提交**，开始本任务前先提交
2. 剩余差距（spec §11 差距 #2）：runListener 已产生 runSuccess L1 事件，但 reporter 只放行 execution_error——服务端分不清「没在用」和「用得顺」
3. 学生姓名/班级配置方案用户暂缓决定：SecretStorage 来源不动；未配置时服务端兜底显示 Unknown/默认班（Task 5 已覆盖）

**Files:**
- Modify: `D:\ruan\vscode-pylearner\src\teacher\reporter.ts`（`buildPayload`，run 分支在 81 行附近）

**Interfaces:**
- Consumes: `TraceEvent`（learner 已有类型）；`EVENT_KINDS.runSuccess = "execution_success"`（learner 已有常量）
- Produces: run 成功事件也上报（payload 结构与 Task 5 flat runSuccess fixture 完全一致：`error_type: "RunSuccess"`、`exit_code: 0`）

- [ ] **Step 1: 修改 buildPayload——放开 runSuccess**

在 `buildPayload` 中，diag 分支之后、`execution_error` 分支之前插入：

```ts
  // run 成功也上报：服务端记为活动信号，区分「没在用」和「用得顺」（spec §11 差距 #2）
  if (event.surface === "run" && event.kind === "execution_success") {
    const p = event.payload as {
      command?: string;
      exit_code?: number;
      file?: string;
      source?: string;
    };
    return {
      ...base,
      raw_message: "run success",
      error_type: "RunSuccess",
      error_message: "",
      command: p.command,
      exit_code: 0,
      file_path: p.file,
      source: p.source,
    };
  }
```

同时把原分支上方注释 `// run 事件（只上报错误）` 改为 `// run 事件（报错）`。

- [ ] **Step 2: 编译验证**

Run（在 `D:\ruan\vscode-pylearner`）: `npm run compile`
Expected: 编译通过，无类型错误。

- [ ] **Step 3: 手工验证（F5 调试扩展）**

1. 教师机（或本机）先启动 server：`pnpm dev:server`
2. VS Code 打开 vscode-pylearner，F5 启动扩展开发主机，settings.json 配好 `pylearner.teacher.url`
3. 写一个正确脚本运行 → server 日志收到 RunSuccess、`curl /api/summary` 该生绿色（姓名显示 Unknown 属预期——配置方案暂缓，见背景 #3）
4. 改成除零错误运行 → 该生转黄，告警/聚合出现

- [ ] **Step 4: Commit（在 vscode-pylearner 仓库）**

```bash
git add src/teacher/reporter.ts
git commit -m "feat(teacher): 放开 runSuccess 上报，服务端可区分活跃与卡住"
```

---

### Task 22: 部署文档 + 端到端验收清单

**Files:**
- Create: `docs/deploy.md`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 部署指南（教师机/学生机）与 V1 验收清单

- [ ] **Step 1: 写部署文档**

`docs/deploy.md`：

```markdown
# 部署指南（V1 上行闭环）

## 教师机（1 台，课堂内网）

### 环境
- Node.js ≥ 20、pnpm ≥ 9
- Windows：防火墙放行 3000 端口入站（学生机要连进来）

### 安装与启动
​```bash
pnpm install
pnpm --filter @classroom/server start        # 默认 3000，可用 PORT 覆盖
​```

### LLM 配置（可选）
仓库根 `.env`（未配置时自动 mock 兜底，功能完整但解释为通用模板）：
​```
LLM_API_KEY=sk-xxx
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
PORT=3000
​```

### 仪表盘
- 开发期：`pnpm dev:dashboard` → http://localhost:5173（/api 已代理到 3000）
- 生产：`pnpm --filter @classroom/dashboard build` 后直接开 http://<教师机IP>:3000/

## 学生机（N 台，VS Code + pylearner 扩展）

用户级 settings.json：
​```json
{
  "pylearner.teacher.enabled": true,
  "pylearner.teacher.url": "http://<教师机IP>:3000"
}
​```
- `pylearner.student.id`：不配置（扩展用 SecretStorage 自动生成稳定 ID）
- **学生姓名/班级配置方式暂缓定案**（2026-09-17 用户决定）：当前取值来源为扩展内 SecretStorage，settings.json 写入不生效；未配置时矩阵显示 Unknown/默认班（服务端已兜底，属预期现象）。批量配置方案定案后补充本文档
- 需 Task 21 的 runSuccess 改动已打进扩展包，否则绿色状态仅表示「无错误」（上报管道编译问题已由用户于 2026-09-17 修复）

## 常见问题
| 现象 | 原因/处理 |
|---|---|
| 矩阵全是 Unknown | 学生姓名/班级配置方案暂缓（预期现象，见学生机段说明） |
| 教师端无任何数据 | `teacher.url` 指错 / 防火墙未放行 / `teacher.enabled` 未开 |
| 解释全是模板文案 | `LLM_API_KEY` 未配置或无效（mock 兜底生效，属预期降级） |
| 时间显示差 8 小时 | 渲染未走 `toLocaleTimeString('zh-CN')`（本版已内置，勿改） |
| 重启后课堂状态清零 | 设计如此（spec §8），历史事件 SQLite 可查（GET /api/events） |
```

（注意：上面代码围栏若嵌套冲突，用四反引号包裹整个文档。）

- [ ] **Step 2: 全链路验收（对照 spec §1 四问）**

在真实双机（或本机双开）环境逐项勾选：

- [ ] **全局感知**：矩阵一眼看出全班红/黄/绿分布，绿为默认态
- [ ] **优先级决策**：告警条 top5 即「先帮谁」，分数与 reason 可解释
- [ ] **教学洞察**：聚合按 subtype（非笼统 category）分组；≥40% 触发「全班讲评」、≥20% 触发「小组讨论」、连续报错学生进「单独辅导」
- [ ] **行动指引**：建议可标记已处理且不重复打扰（重启后会重现——V1 内存态，spec §6 预期）
- [ ] 错误解释为 LLM 三字段（或 mock 兜底），同一错误全班共享（`/api/stats` cache 计数验证）
- [ ] SSE 断线重连：杀 server 重启 → 仪表盘 5s 内恢复连接且 summary 对齐
- [ ] 时间显示与本地时钟一致（zh-CN、无 AM/PM）
- [ ] `pnpm -r test` 全绿；`pnpm build` 全绿
- [ ] simulator 20 人 × 2 分钟无 5xx、无未捕获异常（server 控制台干净）

- [ ] **Step 3: Commit**

```bash
git add docs/deploy.md
git commit -m "docs: V1 部署指南与端到端验收清单"
```

---

## Self-Review（全计划）

**1. Spec 覆盖**（逐节对照 spec）：
- §2 系统组成：三端契约一份（Task 3 shared）✓；SSE（Task 12）✓
- §3 技术决策：Node/Express+TS（Task 4）、Vue3+Vite 前后端分离（Task 14–19）、SSE、内存主存+SQLite（Task 4/9）✓
- §4 工程结构：pnpm monorepo 三包（Task 1/4/14）✓
- §5 服务端：eventIngress（Task 5）、explainService 缓存+去重+mock（Task 6/7/8）、stateManager（Task 9）、aggregator（Task 10/11）、teacherHub（Task 12）；studentHub/taskService 为 V2 不在本期 ✓
- §5 状态判定/优先级分/建议规则/提示词/缓存设计：Task 10/11/2/7 ✓（提示词逐字模板 Task 2）
- §6 接口：五个 V1 接口全部落在 Task 13 ✓
- §7 前端架构：五组件 + Pinia 镜像 + SSE 客户端（Task 14–19）；时间渲染约定（Task 14 time.ts）✓
- §8 错误处理：mock 兜底（Task 6）、断线 5s 重连+summary 对齐（Task 14 sse.ts）、重启清零（设计）、缺字段兜底（Task 5）✓
- §9 分期计划 V1 八项：1→Task 1；2→Task 1–3；3→Task 4–8；4→Task 9–11；5→Task 12；6→Task 14–19；7→Task 20（simulator）+Task 21（runSuccess 小改）；8→Task 22 部署清单 ✓
- §11 差距表：#1 学生姓名/班级配置**用户暂缓定案**（来源为 SecretStorage，settings.json 不生效；服务端 Unknown/默认兜底，Task 5/22 已注明）；#2 runSuccess（Task 21；上报管道编译错误用户已于 2026-09-17 修复）；#3 code_line/full_code 预留（Task 2 降级 + Task 8 prompt 入参，learner 零改动）；#4 diag 全 LLM（Task 8）；#5 教师机 IP 部署配置（Task 22）✓

**2. 占位符扫描**：无 TBD/TODO/「适当处理」类步骤；所有代码步骤含完整代码块；所有测试步骤含完整断言 ✓

**3. 类型一致性**：
- `Explanation{category,subtype,knowledge}`：Task 3 定义 → 4（getCachedExplanation/saveCache）→ 6（callLLM/mockExplain）→ 7（Cache）→ 8（ExplainService）→ 9（apply 入参）→ 13（insertEvent 组装）一致 ✓
- `NormalizedEvent`：Task 3 定义；Task 5 生产（字段 success/cacheKey/rawMessage…）与 Task 8/9/13 消费一致 ✓
- `StudentRecord/StoredEvent`：Task 9 定义 → Task 10/11 消费（events[].subtype/ts/success、lastActivityAt/lastErrorAt/consecutiveErrors）一致 ✓
- `TeacherSnapshot`：Task 3 dto；Task 11 返回 `Omit<TeacherSnapshot,"ts"|"classId">`；Task 12 SSEMessage.data；Task 13 buildSnapshot 补 ts/classId；Task 14 store 镜像；Task 15–19 组件消费字段（alerts[].reason/score/subtype/knowledge、students[].status/recentErrors、aggregates[].count/students/knowledge、suggestions[].id/text/acked）全部在 dto 中定义 ✓
- 跨仓库（Task 21）payload 字段与 Task 5 flat 格式解析一一对应（error_type:"RunSuccess"、exit_code:0）✓
- flush 检查：Task 6 测试中 `应为 ":"` 依赖 mock 关键词「应为」，关键词表已含 ✓；Task 13 集成测试在无 LLM_API_KEY 环境下断言 mock 兜底值「除数为0」，与 Task 6 MOCK_RULES 一致 ✓

**已知取舍**（非缺陷，已在对应任务注明）：V1 SSE update 为全量重算推送（Task 12）；聚合 AggItem.category 置空（Task 11）；建议 ack 内存态（spec §6 预期）。

> 执行提示（Task 22 Step 1）：deploy.md 内容中带 `​`（零宽字符）的围栏是为避免与本文档嵌套冲突的占位——写入实际文件时替换为普通的三反引号。
