# 作业流 V2.0 实现计划（多文件项目 + 评审时机分离）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不动搬运通道（HTTP + 服务端代管 git）的前提下，支持多文件项目型作业，并将评审时机从提交剥离到「运行成功」触发，评审 fail 注入实时聚合面板。

**Architecture:** 服务端扩展扫描/提交/内容接口以支持 `week-N/<dir>/exercise.json` 项目练习（files 全量快照，项目哈希幂等，writeToStudentBranch 写目录）；新增 `POST /api/reviews/request`（F5 触发评审，写回最新提交记录，fail 合成事件进 stateManager）；提交降级为纯归档（移除评审触发与启动补扫）。学生端扩展：多文件拉取/提交/恢复、F5 评审回执、会话身份确认门禁、取消自动拉取/自动提交、运行和调试侧边栏三按钮面板。

**Tech Stack:** TypeScript、Express 5、better-sqlite3、vitest（服务端 pnpm workspace）；VS Code Extension API、vitest（扩展 npm 单仓）

**Spec:** `docs/superpowers/specs/2026-10-12-git-assignments-design.md`（V2.0，本计划从 spec 立论，执行者需同时读 spec）

## Global Constraints

- **两仓路径**：服务端 `d:\ruan\classroom-assistant`（pnpm）；扩展 `d:\ruan\vscode-pylearner`（npm）。提交在各仓分别进行。
- **测试命令**：服务端 `pnpm --filter @classroom/server test`；扩展在扩展仓根 `npm test`（vitest run）。
- **dev server 运行中严禁并行跑 server 测试**（共享 `data/exercises-repo` git 工作目录会产生 index.lock 冲突，2026-10-10 实测教训）。跑 Task 1-6 的测试前确认 dev server 已停（`netstat -ano | findstr :3000` 应无监听）。
- **两仓 wire 契约手动对齐（F6）**：扩展不依赖 `@classroom/shared`。`canonicalFilesHash`、`EXERCISE_ID_REGEX`、`SubmissionFile` 形状在两仓各有一份，改动必须双侧同步。
- **路径规范**：所有相对路径用 POSIX 分隔符（`week-XX/<dir>/<file>`），周号 `padStart(2, "0")`。
- **评审三态**：pass/fail/unreviewed；unreviewed 不入缓存（现有约束，不动）。
- **学生机零 git 零凭据**：任何任务不得引入学生侧 git/Gitea 账号概念。
- **纯归档语义**：`POST /api/submissions` 不触发评审；`review_json IS NULL` 是合法终态；启动补扫（`rescanPendingReviews`）随本计划退役。
- **TDD**：每任务先写失败测试再实现；单文件练习路径的既有行为不得回归（files 缺省 = 旧行为）。

---

### Task 1: 服务端 shared 类型 + DB 迁移 + 持久层

**Files:**
- Modify: `packages/shared/src/assignment.ts`
- Modify: `packages/server/src/persistence.ts`
- Test: `packages/server/src/__tests__/persistenceV2.test.ts`（新建）

**Interfaces:**
- Produces（后续任务依赖的精确签名）:
  - shared: `type ExerciseKind = "file" | "project"`；`interface SubmissionFile { path: string; content: string }`
  - shared `Exercise` 增加 `kind?: ExerciseKind; dir?: string; entry?: string;`
  - shared `Submission` 增加 `files?: SubmissionFile[] | null;`
  - shared `PublishedExercise` 增加 `kind?: ExerciseKind; dir?: string; entry?: string;`
  - shared `SubmissionInput` 增加 `files?: SubmissionFile[];`
  - shared 新增 `interface ReviewRequestInput { studentId: string; studentName?: string; exerciseId: string; code: string; files?: SubmissionFile[]; }`
  - persistence: `insertSubmission(s: Submission & { codeHash: string; gitSynced: boolean }): void`（files 经 `s.files` 携带）
  - persistence 新增: `getLatestSubmissionByExerciseStudent(exerciseId: string, studentId: string): Submission | null`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/src/__tests__/persistenceV2.test.ts
import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";

describe("persistence V2（项目练习 + files_json）", () => {
  it("exercise 携带 kind/dir/entry 往返一致", () => {
    const p = createPersistence(":memory:");
    p.upsertAssignment({ id: "a1", title: "第 3 周作业", week: 3, isPublished: true, createdAt: 1 });
    p.upsertExercise({
      id: "e1", assignmentId: "a1", order: 1, filename: "weather-app",
      problemStatement: "题面", starterCode: "print()", testCases: [], versionHash: "v1",
      isActive: true, createdAt: 1,
      kind: "project", dir: "weather-app", entry: "main.py",
    });
    const e = p.getExercise("e1")!;
    expect(e.kind).toBe("project");
    expect(e.dir).toBe("weather-app");
    expect(e.entry).toBe("main.py");
    // 单文件默认
    p.upsertExercise({ id: "e2", assignmentId: "a1", order: 2, filename: "01.py",
      problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1 });
    expect(p.getExercise("e2")!.kind ?? "file").toBe("file");
  });

  it("submission files_json 往返 + 最新提交查询", () => {
    const p = createPersistence(":memory:");
    p.upsertAssignment({ id: "a1", title: "t", week: 3, isPublished: true, createdAt: 1 });
    p.upsertExercise({ id: "e1", assignmentId: "a1", order: 1, filename: "w",
      problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1 });
    p.insertSubmission({ id: "s1", exerciseId: "e1", studentId: "2025001", studentName: "张三",
      code: "main", source: "manual", submittedAt: 100, review: null,
      codeHash: "h1", gitSynced: false,
      files: [{ path: "main.py", content: "main" }, { path: "utils.py", content: "u" }] });
    p.insertSubmission({ id: "s2", exerciseId: "e1", studentId: "2025001", studentName: "张三",
      code: "main2", source: "manual", submittedAt: 200, review: null, codeHash: "h2", gitSynced: false });
    const latest = p.getLatestSubmissionByExerciseStudent("e1", "2025001")!;
    expect(latest.id).toBe("s2");
    expect(latest.files ?? null).toBeNull();
    const first = p.getSubmissionsByStudent("2025001").find((s) => s.id === "s1")!;
    expect(first.files).toEqual([{ path: "main.py", content: "main" }, { path: "utils.py", content: "u" }]);
  });

  it("旧库迁移：已存在的表补列不报错", () => {
    // createPersistence 对全新 :memory: 库执行同一迁移路径；再开一次模拟重启
    const p = createPersistence(":memory:");
    expect(p.getRoster()).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL（TS 报错：Exercise 无 kind 等字段 / persistence 无 getLatestSubmissionByExerciseStudent）

- [ ] **Step 3: 改 shared 类型**

`packages/shared/src/assignment.ts`：在 `ReviewStatus` 定义后加：

```ts
export type ExerciseKind = "file" | "project";
export interface SubmissionFile { path: string; content: string }
```

`Exercise` 接口内（`createdAt: number;` 之前）加：

```ts
  kind?: ExerciseKind;        // 缺省视为 "file"（存量行）
  dir?: string;               // 项目目录名（kind=project 时必填）
  entry?: string;             // 入口文件（缺省 "main.py"）
```

`Submission` 接口内加 `files?: SubmissionFile[] | null;`；`PublishedExercise` 加 `kind?: ExerciseKind; dir?: string; entry?: string;`；`SubmissionInput` 加 `files?: SubmissionFile[];`；文件尾加 `ReviewRequestInput`：

```ts
/** learner → server 运行触发评审 wire payload（spec §4.2） */
export interface ReviewRequestInput {
  studentId: string;
  studentName?: string;
  exerciseId: string;
  code: string;               // 入口文件内容
  files?: SubmissionFile[];   // 项目题必填
}
```

- [ ] **Step 4: 改 persistence**

`packages/server/src/persistence.ts`：

1) `ExerciseDbRow` 类型加 `kind?: string; dir?: string | null; entry?: string | null;`，`toExercise` 返回对象加：
```ts
    kind: (r.kind as Exercise["kind"]) ?? "file",
    dir: r.dir ?? undefined,
    entry: r.entry ?? undefined,
```
（import 行的 type 列表加 `ExerciseKind` 不必要，直接 as Exercise["kind"]。）

2) `SubmissionDbRow` 加 `files_json?: string | null;`，`toSubmission` 返回对象加：
```ts
    files: r.files_json ? (JSON.parse(r.files_json) as Submission["files"]) : null,
```
（import type 列表加 `SubmissionFile`。）

3) `db.exec(\`...\`)` 建表块**之后**（L167 反引号结束处）追加迁移：

```ts
  // V2.0 迁移：存量库补列（CREATE TABLE IF NOT EXISTS 不会给旧表加列）
  const addColumnIfMissing = (table: string, column: string, ddl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addColumnIfMissing("exercises", "kind", "kind TEXT NOT NULL DEFAULT 'file'");
  addColumnIfMissing("exercises", "dir", "dir TEXT");
  addColumnIfMissing("exercises", "entry", "entry TEXT");
  addColumnIfMissing("submissions", "files_json", "files_json TEXT");
```

4) `Persistence` 接口（L42-73）加一行：
```ts
  getLatestSubmissionByExerciseStudent(exerciseId: string, studentId: string): Submission | null;
```

5) `upsertExercise`（L247-255）SQL 改为（INSERT 列与 ON CONFLICT UPDATE 都加 kind/dir/entry）：

```ts
    upsertExercise(e) {
      db.prepare(`INSERT INTO exercises (id, assignment_id, order_no, filename, problem_statement, starter_code, test_cases_json, version_hash, is_active, created_at, kind, dir, entry)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET order_no = excluded.order_no, problem_statement = excluded.problem_statement,
          starter_code = excluded.starter_code, test_cases_json = excluded.test_cases_json,
          version_hash = excluded.version_hash, is_active = excluded.is_active,
          kind = excluded.kind, dir = excluded.dir, entry = excluded.entry`)
        .run(e.id, e.assignmentId, e.order, e.filename, e.problemStatement, e.starterCode ?? null,
          JSON.stringify(e.testCases ?? []), e.versionHash, e.isActive ? 1 : 0, e.createdAt,
          e.kind ?? "file", e.dir ?? null, e.entry ?? null);
    },
```

6) `insertSubmission`（L273-277）加 files_json 列：

```ts
    insertSubmission(s) {
      db.prepare(`INSERT INTO submissions (id, exercise_id, student_id, student_name, code, code_hash, source, git_synced, submitted_at, review_json, files_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(s.id, s.exerciseId, s.studentId, s.studentName, s.code, s.codeHash, s.source, s.gitSynced ? 1 : 0, s.submittedAt, null,
          s.files ? JSON.stringify(s.files) : null);
    },
```

7) 查询区（`getPendingReviewSubmissions` 之后）加：

```ts
    getLatestSubmissionByExerciseStudent(exerciseId, studentId) {
      const r = db.prepare("SELECT * FROM submissions WHERE exercise_id = ? AND student_id = ? ORDER BY submitted_at DESC LIMIT 1")
        .get(exerciseId, studentId) as SubmissionDbRow | undefined;
      return r ? toSubmission(r) : null;
    },
```

- [ ] **Step 5: 跑测试通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS（新测试 + 全部既有测试）

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/assignment.ts packages/server/src/persistence.ts packages/server/src/__tests__/persistenceV2.test.ts
git commit -m "feat(server): V2.0 类型契约 + DB 迁移（kind/dir/entry/files_json）+ 最新提交查询"
```

---

### Task 2: 服务端 manifest 解析 + 项目版本哈希 + 忽略清单

**Files:**
- Modify: `packages/server/src/assignmentFiles.ts`
- Test: `packages/server/src/__tests__/assignmentFilesProject.test.ts`（新建）

**Interfaces:**
- Consumes: shared `SubmissionFile`（Task 1）
- Produces:
  - `isProjectIgnoredEntry(name: string, isDir: boolean): boolean`
  - `parseExerciseManifest(content: string): { exerciseId: string | null; week: number | null; title: string | null; entry: string } | null`（非法 JSON → null）
  - `injectManifestIds(content: string, exerciseId: string, week: number): string`
  - `computeProjectVersionHash(files: SubmissionFile[]): string`（16-hex，风格同 computeExerciseVersionHash）
  - `canonicalFilesHash(files: SubmissionFile[]): string`（**两仓 wire 契约**：64-hex sha256，提交幂等用；扩展侧 Task 7 有逐字一致的副本）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/src/__tests__/assignmentFilesProject.test.ts
import { describe, it, expect } from "vitest";
import {
  isProjectIgnoredEntry, parseExerciseManifest, injectManifestIds,
  computeProjectVersionHash, canonicalFilesHash,
} from "../assignmentFiles";

describe("项目 manifest", () => {
  it("解析教师 manifest（title/entry，缺 id/week）", () => {
    const m = parseExerciseManifest(`{ "title": "天气", "entry": "main.py" }`);
    expect(m).toEqual({ exerciseId: null, week: null, title: "天气", entry: "main.py" });
  });
  it("entry 缺省 main.py；含注入 id", () => {
    const m = parseExerciseManifest(`{ "exerciseId": "id-1", "week": 3 }`);
    expect(m!.entry).toBe("main.py");
    expect(m!.exerciseId).toBe("id-1");
  });
  it("非法 JSON → null", () => {
    expect(parseExerciseManifest("not json")).toBeNull();
  });
  it("注入保留教师字段", () => {
    const out = injectManifestIds(`{ "title": "T", "entry": "app.py" }`, "uuid-9", 3);
    const m = parseExerciseManifest(out)!;
    expect(m.exerciseId).toBe("uuid-9");
    expect(m.week).toBe(3);
    expect(m.title).toBe("T");
    expect(m.entry).toBe("app.py");
  });
  it("忽略清单", () => {
    expect(isProjectIgnoredEntry("__pycache__", true)).toBe(true);
    expect(isProjectIgnoredEntry(".venv", true)).toBe(true);
    expect(isProjectIgnoredEntry("venv", true)).toBe(true);
    expect(isProjectIgnoredEntry(".git", true)).toBe(true);
    expect(isProjectIgnoredEntry("x.pyc", false)).toBe(true);
    expect(isProjectIgnoredEntry(".DS_Store", false)).toBe(true);
    expect(isProjectIgnoredEntry("main.py", false)).toBe(false);
    expect(isProjectIgnoredEntry("data", true)).toBe(false);
  });
  it("项目哈希与顺序无关；canonicalFilesHash 稳定", () => {
    const a = [{ path: "a.py", content: "1" }, { path: "b.py", content: "2" }];
    const b = [{ path: "b.py", content: "2" }, { path: "a.py", content: "1" }];
    expect(computeProjectVersionHash(a)).toBe(computeProjectVersionHash(b));
    expect(canonicalFilesHash(a)).toBe(canonicalFilesHash(b));
    expect(canonicalFilesHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeProjectVersionHash(a)).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 实现**

`packages/server/src/assignmentFiles.ts` 头部 import 改为引入类型：`import { scanExerciseId, type SubmissionFile, type TestCase } from "@classroom/shared";`，文件尾追加：

```ts
// —— V2.0 项目练习（spec §3）——

const IGNORE_DIRS = new Set(["__pycache__", ".venv", "venv", ".git"]);
const IGNORE_FILE_NAMES = new Set([".DS_Store", ".pyc"]);

export function isProjectIgnoredEntry(name: string, isDir: boolean): boolean {
  return isDir ? IGNORE_DIRS.has(name) : IGNORE_FILE_NAMES.has(name);
}

export interface ParsedManifest {
  exerciseId: string | null;
  week: number | null;
  title: string | null;
  entry: string;              // 缺省 "main.py"
}

export function parseExerciseManifest(content: string): ParsedManifest | null {
  try {
    const raw = JSON.parse(content) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) return null;
    return {
      exerciseId: typeof raw.exerciseId === "string" ? raw.exerciseId : null,
      week: typeof raw.week === "number" ? raw.week : null,
      title: typeof raw.title === "string" ? raw.title : null,
      entry: typeof raw.entry === "string" && raw.entry ? raw.entry : "main.py",
    };
  } catch {
    return null;
  }
}

export function injectManifestIds(content: string, exerciseId: string, week: number): string {
  const raw = JSON.parse(content) as Record<string, unknown>;
  return JSON.stringify({ ...raw, exerciseId, week }, null, 2) + "\n";
}

const sortFiles = (files: SubmissionFile[]) =>
  files.map((f) => ({ path: f.path, content: f.content }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/** 题目版本哈希（server 内部，16-hex，风格同 computeExerciseVersionHash） */
export function computeProjectVersionHash(files: SubmissionFile[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(sortFiles(files))).digest("hex").slice(0, 16);
}

/** 提交幂等内容哈希（两仓 wire 契约，64-hex；与 vscode-pylearner src/submission/projectFiles.ts 逐字一致，改动必须双侧同步） */
export function canonicalFilesHash(files: SubmissionFile[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(sortFiles(files))).digest("hex");
}
```

- [ ] **Step 4: 跑测试通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/assignmentFiles.ts packages/server/src/__tests__/assignmentFilesProject.test.ts
git commit -m "feat(server): exercise.json manifest 解析/注入 + 项目版本哈希 + canonicalFilesHash 契约"
```

---

### Task 3: 服务端 syncService 项目目录扫描

**Files:**
- Modify: `packages/server/src/syncService.ts`
- Test: `packages/server/src/__tests__/syncProject.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1（persistence kind/dir/entry）、Task 2（manifest 函数、isProjectIgnoredEntry、computeProjectVersionHash）
- Produces: 扫描后 DB 中项目练习行：`filename = <目录名>`、`kind: "project"`、`dir: <目录名>`、`entry`、题面/starterCode 取自入口文件头部（parseExerciseFile 复用）；manifest 缺 id 时 `injections` 含 `week-N/<dir>/exercise.json`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/src/__tests__/syncProject.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPersistence } from "../persistence";
import { createSyncService } from "../syncService";
import type { GitService } from "../gitService";

// 最小假 git：记录注入回写，不做真实 git 操作
function makeFakeGit(): GitService & { injections: { path: string; content: string }[][] } {
  const g = {
    injections: [] as { path: string; content: string }[][],
    async ensureClone() {},
    async alignToRemote() {},
    async hasUnpushedMainCommits() { return false; },
    async pushMain() { return "ok" as const; },
    async commitAndPushMain(files: { path: string; content: string }[]) { g.injections.push(files); return "ok" as const; },
    async createStudentBranches() {},
    async writeToStudentBranch() { return "ok" as const; },
    async readFileFromMain() { return ""; },
  };
  return g as unknown as GitService & typeof g;
}

describe("syncService 项目扫描", () => {
  let repoDir: string;
  beforeEach(() => { repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-")); });
  afterEach(() => { fs.rmSync(repoDir, { recursive: true, force: true }); });

  it("识别项目目录：入库 kind/dir/entry + 注入 manifest id", async () => {
    fs.mkdirSync(path.join(repoDir, "week-3", "weather-app", "data"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "week-3", "weather-app", "exercise.json"),
      `{ "title": "天气", "entry": "main.py" }`);
    fs.writeFileSync(path.join(repoDir, "week-3", "weather-app", "main.py"),
      "# -*- coding: utf-8 -*-\n# ===== classroom-assistant =====\n# ===============================\n# 题目：做天气\n# ===== 代码区 =====\nprint('hi')\n");
    fs.writeFileSync(path.join(repoDir, "week-3", "weather-app", "utils.py"), "def f(): pass\n");
    fs.writeFileSync(path.join(repoDir, "week-3", "weather-app", "data", "city.txt"), "BJ\n");
    fs.mkdirSync(path.join(repoDir, "week-3", "weather-app", "__pycache__"));
    fs.writeFileSync(path.join(repoDir, "week-3", "weather-app", "__pycache__", "x.pyc"), "bin");
    fs.mkdirSync(path.join(repoDir, "week-3", "notes"));   // 无 manifest：忽略+警告

    const p = createPersistence(":memory:");
    const git = makeFakeGit();
    const sync = createSyncService({ persistence: p, git, repoDir });
    const r = await sync.syncNow();

    const ex = p.getExercises(p.getAssignments()[0].id).find((e) => e.kind === "project");
    expect(ex).toBeTruthy();
    expect(ex!.filename).toBe("weather-app");
    expect(ex!.dir).toBe("weather-app");
    expect(ex!.entry).toBe("main.py");
    expect(ex!.problemStatement).toContain("做天气");
    expect(r.importedNew).toBe(1);
    expect(r.warnings.some((w) => w.includes("notes"))).toBe(true);   // 无 manifest 警告
    // 注入 manifest id（exercise.json 路径）
    const flat = git.injections.flat();
    expect(flat.some((f) => f.path === "week-3/weather-app/exercise.json" && f.content.includes("exerciseId"))).toBe(true);
  });

  it("已注入 id 的项目二次扫描不重复注入；versionHash 变更计入 updated", async () => {
    fs.mkdirSync(path.join(repoDir, "week-3", "app2"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "week-3", "app2", "exercise.json"),
      `{ "exerciseId": "fixed-id", "week": 3, "entry": "main.py" }`);
    fs.writeFileSync(path.join(repoDir, "week-3", "app2", "main.py"), "print(1)\n");
    const p = createPersistence(":memory:");
    const git = makeFakeGit();
    await createSyncService({ persistence: p, git, repoDir }).syncNow();
    expect(git.injections.length).toBe(0);   // 有 id 不注入
    const ex = p.getExercises(p.getAssignments()[0].id).find((e) => e.dir === "app2")!;
    expect(ex.id).toBe("fixed-id");
    fs.writeFileSync(path.join(repoDir, "week-3", "app2", "main.py"), "print(2)\n");
    const r2 = await createSyncService({ persistence: p, git, repoDir }).syncNow();
    expect(r2.updated).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL（找不到 kind === "project" 的行——单文件扫描逻辑忽略子目录）

- [ ] **Step 3: 实现 scanOnce 项目段**

`packages/server/src/syncService.ts`：import 行加 `isProjectIgnoredEntry, parseExerciseManifest, injectManifestIds, computeProjectVersionHash`（来自 `./assignmentFiles`）。

`scanOnce` 内，现有 `files.forEach(...)` 之后、`result.deactivated += ...` 之前插入项目扫描段：

```ts
      // V2.0 项目练习：week-N 一级子目录含 exercise.json = 一个 exercise（spec §3）
      const subdirs = dirName
        ? fs.readdirSync(path.join(repoDir, dirName), { withFileTypes: true }).filter((e) => e.isDirectory())
        : [];
      let dirOrder = files.length;
      for (const sd of subdirs) {
        if (isProjectIgnoredEntry(sd.name, true)) continue;
        const manifestRel = `${dirName}/${sd.name}/exercise.json`;
        const manifestAbs = path.join(repoDir, manifestRel);
        if (!fs.existsSync(manifestAbs)) {
          result.warnings.push(`week-${week}/${sd.name} 不是项目练习（缺 exercise.json），已忽略`);
          continue;
        }
        const manifest = parseExerciseManifest(fs.readFileSync(manifestAbs, "utf8"));
        if (!manifest) {
          result.warnings.push(`week-${week}/${sd.name}/exercise.json 不是合法 JSON，已忽略`);
          continue;
        }
        // 递归收集项目文件（忽略清单），路径相对项目目录
        const projFiles: { path: string; content: string }[] = [];
        const walk = (relDir: string) => {
          for (const ent of fs.readdirSync(path.join(repoDir, relDir), { withFileTypes: true })) {
            if (isProjectIgnoredEntry(ent.name, ent.isDirectory())) continue;
            const rel = `${relDir}/${ent.name}`;
            if (ent.isDirectory()) walk(rel);
            else projFiles.push({ path: rel.slice(`${dirName}/${sd.name}/`.length), content: fs.readFileSync(path.join(repoDir, rel), "utf8") });
          }
        };
        walk(`${dirName}/${sd.name}`);
        const entryAbs = path.join(repoDir, dirName, sd.name, manifest.entry);
        if (!fs.existsSync(entryAbs)) {
          result.warnings.push(`week-${week}/${sd.name} 入口文件 ${manifest.entry} 不存在，已忽略`);
          continue;
        }
        const entryParsed = parseExerciseFile(fs.readFileSync(entryAbs, "utf8"));
        const versionHash = computeProjectVersionHash(projFiles);
        dirOrder += 1;
        // 对账双轨：manifest id 优先，回退 (week, 目录名)——filename = 目录名
        let exercise = manifest.exerciseId ? persistence.getExercise(manifest.exerciseId) : null;
        if (!exercise) exercise = persistence.findExerciseByPath(week, sd.name);
        if (!exercise) {
          const id = manifest.exerciseId ?? randomUUID();
          persistence.upsertExercise({
            id, assignmentId: assignment!.id, order: dirOrder, filename: sd.name,
            problemStatement: entryParsed.problemStatement, starterCode: entryParsed.starterCode,
            testCases: [], versionHash, isActive: true, createdAt: Date.now(),
            kind: "project", dir: sd.name, entry: manifest.entry,
          });
          result.importedNew++;
          seenIds.push(id);
          if (!manifest.exerciseId) injections.push({ path: manifestRel, content: injectManifestIds(fs.readFileSync(manifestAbs, "utf8"), id, week) });
        } else {
          if (exercise.versionHash !== versionHash) {
            result.updated++;
            if (assignment!.isPublished && persistence.getSubmissionsByExercise(exercise.id).length > 0) {
              result.warnings.push(`week-${week}/${sd.name} 已发布且有提交，内容已变更——评审基准已切换，请通知学生（A30）`);
            }
          }
          persistence.upsertExercise({
            ...exercise, order: dirOrder, problemStatement: entryParsed.problemStatement,
            starterCode: entryParsed.starterCode, versionHash, isActive: true,
            kind: "project", dir: sd.name, entry: manifest.entry,
          });
          seenIds.push(exercise.id);
          if (!manifest.exerciseId) injections.push({ path: manifestRel, content: injectManifestIds(fs.readFileSync(manifestAbs, "utf8"), exercise.id, week) });
        }
      }
```

注意：`files` 变量名沿用现有 `const files = dirName ? ...filter(f => f.endsWith(".py")).sort() : [];`——项目段引用它取 `files.length` 作为起始 order。

- [ ] **Step 4: 跑测试通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS（含既有 sync 测试不回归）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/syncService.ts packages/server/src/__tests__/syncProject.test.ts
git commit -m "feat(server): syncService 识别 week-N 项目目录（manifest 对账/注入/忽略清单/项目版本哈希）"
```

---

### Task 4: 服务端 gitService 项目能力 + content 端点 JSON + published 清单扩展

**Files:**
- Modify: `packages/server/src/gitService.ts`
- Modify: `packages/server/src/controllers/assignmentController.ts`
- Modify: `packages/server/src/routes/assignments.ts:43-49`
- Test: `packages/server/src/__tests__/contentProject.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1（Exercise kind/dir/entry）
- Produces:
  - GitService 新增: `listFilesFromMain(dirRel: string): Promise<string[]>`（`git ls-tree -r --name-only main:<dirRel>`，只读不入 mutex）
  - GitService.writeToStudentBranch args 扩展: `{ studentId; studentName; week; filename; content; files?: { path: string; content: string }[] }`——files 存在时 filename=项目目录名，删除式重写 `week-XX/<dir>/` 后写全部文件，commit message `submit: week-XX/<dir>/ (project) by <id> <name>`
  - `readExerciseContent` 返回值改为联合 JSON（routes 层 res.json）：
    - `{ ok: true; kind: "file"; filename: string; content: string }`
    - `{ ok: true; kind: "project"; filename: string; dir: string; entry: string; files: SubmissionFile[] }`
    - `{ ok: false; status: 404; error: string }`
  - `buildPublishedList` 的 exercises 行含 `kind/dir/entry`（缺省 kind "file"）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/src/__tests__/contentProject.test.ts
import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { readExerciseContent, buildPublishedList } from "../controllers/assignmentController";
import type { GitService } from "../gitService";

function makeFakeGit(files: Record<string, string>): GitService {
  return {
    async ensureClone() {},
    async alignToRemote() {},
    async hasUnpushedMainCommits() { return false; },
    async pushMain() { return "ok"; },
    async commitAndPushMain() { return "ok"; },
    async createStudentBranches() {},
    async writeToStudentBranch() { return "ok"; },
    async readFileFromMain(rel: string) {
      if (!(rel in files)) throw new Error("not found");
      return files[rel];
    },
    async listFilesFromMain(dirRel: string) {
      return Object.keys(files).filter((k) => k.startsWith(dirRel + "/")).map((k) => k.slice(dirRel.length + 1));
    },
  } as unknown as GitService;
}

describe("content 端点 + published 清单（项目）", () => {
  function seed() {
    const p = createPersistence(":memory:");
    p.replaceRoster([{ studentId: "2025001", studentName: "张三" }]);
    p.upsertAssignment({ id: "a1", title: "第 3 周", week: 3, isPublished: true, createdAt: 1, publishedAt: 1 });
    p.upsertExercise({ id: "ef", assignmentId: "a1", order: 1, filename: "01.py",
      problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1 });
    p.upsertExercise({ id: "ep", assignmentId: "a1", order: 2, filename: "weather-app",
      problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1,
      kind: "project", dir: "weather-app", entry: "main.py" });
    return p;
  }
  const repoFiles: Record<string, string> = {
    "week-03/weather-app/main.py": "# main",
    "week-03/weather-app/utils.py": "# utils",
    "week-03/weather-app/data/city.txt": "BJ",
    "week-03/01.py": "# single",
  };

  it("项目题返回 files 数组（含子目录路径与 entry）", async () => {
    const p = seed();
    const r = await readExerciseContent(p, "", makeFakeGit(repoFiles), "ep");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("project");
    if (r.kind !== "project") return;
    expect(r.dir).toBe("weather-app");
    expect(r.entry).toBe("main.py");
    expect(r.files.map((f) => f.path).sort()).toEqual(["data/city.txt", "main.py", "utils.py"]);
  });
  it("单文件题返回 kind file（响应结构升级）", async () => {
    const p = seed();
    const r = await readExerciseContent(p, "", makeFakeGit(repoFiles), "ef");
    expect(r).toEqual({ ok: true, kind: "file", filename: "01.py", content: "# single" });
  });
  it("published 清单携带 kind/dir/entry", () => {
    const p = seed();
    const list = buildPublishedList(p);
    const proj = list[0].exercises.find((e) => e.id === "ep")!;
    expect(proj.kind).toBe("project");
    expect(proj.dir).toBe("weather-app");
    expect(list[0].exercises.find((e) => e.id === "ef")!.kind ?? "file").toBe("file");
  });
  it("入口文件缺失 → 404", async () => {
    const p = seed();
    const r = await readExerciseContent(p, "", makeFakeGit({ "week-03/weather-app/utils.py": "# u" }), "ep");
    expect(r).toEqual({ ok: false, status: 404, error: "入口文件不存在" });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL（listFilesFromMain 不存在；readExerciseContent 返回旧结构）

- [ ] **Step 3: gitService 扩展**

`packages/server/src/gitService.ts`：

1) `GitService` 接口（L17-27）加两处：

```ts
  /** 列出 main ref 下某目录的全部文件（V2.0 项目 content；只读 ref 不入 mutex） */
  listFilesFromMain(dirRel: string): Promise<string[]>;
```

`writeToStudentBranch` 的 args 类型改为：

```ts
  writeToStudentBranch(args: {
    studentId: string; studentName: string; week: number; filename: string; content: string;
    files?: { path: string; content: string }[];   // V2.0 项目：filename=目录名
  }): Promise<GitPushResult>;
```

2) `writeToStudentBranch` 实现（L134-169）中，`const rel = ...` 与 `writeFiles(...)` 之间改为分支：

```ts
        let message: string;
        if (args.files) {
          // 项目归档：删除式重写 week-XX/<dir>/（学生分支服务端独占，安全）
          const relDir = `week-${String(args.week).padStart(2, "0")}/${args.filename}`;
          fs.rmSync(path.join(deps.repoDir, relDir), { recursive: true, force: true });
          writeFiles(args.files.map((f) => ({ path: `${relDir}/${f.path}`, content: f.content })));
          message = `submit: ${relDir}/ (project) by ${args.studentId} ${args.studentName}`;
        } else {
          const rel = `week-${String(args.week).padStart(2, "0")}/${args.filename}`;
          writeFiles([{ path: rel, content: args.content }]);
          message = `submit: ${rel} by ${args.studentId} ${args.studentName}`;
        }
```

其后的 `git(["commit", "-m", \`submit: ${rel} by ...\`, ...])` 改为 `git(["commit", "-m", message, ...])`。

3) 返回对象内加（`readFileFromMain` 旁）：

```ts
    async listFilesFromMain(dirRel) {
      const out = await git(["ls-tree", "-r", "--name-only", `main:${dirRel}`]);
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    },
```

- [ ] **Step 4: assignmentController + routes**

`packages/server/src/controllers/assignmentController.ts`：

1) import 加 `type SubmissionFile`（来自 `@classroom/shared`）。

2) `buildPublishedList`（L19-28）exercises map 改为：

```ts
        .map((e) => ({ id: e.id, filename: e.filename, versionHash: e.versionHash,
          kind: e.kind ?? "file", dir: e.dir, entry: e.entry })),
```

3) `readExerciseContent`（L31-49）整体替换为：

```ts
export type ExerciseContentResult =
  | { ok: true; kind: "file"; filename: string; content: string }
  | { ok: true; kind: "project"; filename: string; dir: string; entry: string; files: SubmissionFile[] }
  | { ok: false; status: 404; error: string };

export async function readExerciseContent(p: Persistence, repoDir: string, git: GitService | null, exerciseId: string):
  Promise<ExerciseContentResult> {
  const exercise = p.getExercise(exerciseId);
  if (!exercise || !exercise.isActive) return { ok: false, status: 404, error: "练习不存在或已下线" };
  const assignment = p.getAssignment(exercise.assignmentId);
  if (!assignment || !assignment.isPublished) return { ok: false, status: 404, error: "练习未发布" };
  const weekDir = `week-${String(assignment.week).padStart(2, "0")}`;

  if ((exercise.kind ?? "file") === "project" && exercise.dir) {
    const dirRel = `${weekDir}/${exercise.dir}`;
    const entry = exercise.entry ?? "main.py";
    const files: SubmissionFile[] = [];
    if (git) {
      let paths: string[];
      try {
        paths = await git.listFilesFromMain(dirRel);
      } catch {
        return { ok: false, status: 404, error: "项目目录不存在" };
      }
      if (!paths.includes(entry)) return { ok: false, status: 404, error: "入口文件不存在" };
      for (const rel of paths) {
        files.push({ path: rel, content: await git.readFileFromMain(`${dirRel}/${rel}`) });
      }
    } else {
      const walk = (relDir: string) => {
        for (const ent of fs.readdirSync(path.join(repoDir, relDir), { withFileTypes: true })) {
          const rel = `${relDir}/${ent.name}`;
          if (ent.isDirectory()) walk(rel);
          else files.push({ path: rel.slice(dirRel.length + 1), content: fs.readFileSync(path.join(repoDir, rel), "utf8") });
        }
      };
      walk(path.join(repoDir, dirRel) === repoDir ? "" : dirRel);
      if (!files.some((f) => f.path === entry)) return { ok: false, status: 404, error: "入口文件不存在" };
    }
    return { ok: true, kind: "project", filename: exercise.dir, dir: exercise.dir, entry, files };
  }

  const rel = `${weekDir}/${exercise.filename}`;
  if (git) {
    try {
      return { ok: true, kind: "file", filename: exercise.filename, content: await git.readFileFromMain(rel) };
    } catch {
      return { ok: false, status: 404, error: "文件不存在" };
    }
  }
  const abs = path.join(repoDir, rel);
  if (!fs.existsSync(abs)) return { ok: false, status: 404, error: "文件不存在" };
  return { ok: true, kind: "file", filename: exercise.filename, content: fs.readFileSync(abs, "utf8") };
}
```

（无 git 兜底分支里 walk 的调用写法：直接 `const walk = (absDir: string, relDir: string) => {...}`，从 `path.join(repoDir, dirRel)` 开始，rel 取相对 dirRel 的路径——实现时按此写清楚，避免上面的占位式写法。）

`packages/server/src/routes/assignments.ts` L43-49 content 路由改为：

```ts
  app.get("/api/exercises/:id/content", async (req, res) => {
    const r = await readExerciseContent(deps.persistence, deps.repoDir, deps.git, req.params.id);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json(r);
  });
```

（移除 Content-Type/Content-Disposition 附件头——响应升级为 JSON，扩展端 Task 10 同步改为 JSON 解析。）

- [ ] **Step 5: 跑测试通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/gitService.ts packages/server/src/controllers/assignmentController.ts packages/server/src/routes/assignments.ts packages/server/src/__tests__/contentProject.test.ts
git commit -m "feat(server): gitService 项目读写能力 + content 端点 JSON 化（files 下发）+ published 清单携带 kind/dir/entry"
```

---

### Task 5: 服务端提交纯归档 + files 校验/幂等 + 启动补扫退役

**Files:**
- Modify: `packages/server/src/controllers/submissionController.ts`
- Modify: `packages/server/src/index.ts:21,70-73,197,214`
- Test: `packages/server/src/__tests__/submissionFiles.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1（persistence files_json / SubmissionInput.files）、Task 2（canonicalFilesHash）、Task 4（writeToStudentBranch files）
- Produces:
  - `SubmissionDeps` 收窄为 `{ persistence: Persistence; git: GitService | null; publish: (msg: SSEMessage) => void; }`（reviewService 移出——Task 6 的 ReviewRouteDeps 接手）
  - `createSubmission(deps, input)`：项目题幂等键 = `(exerciseId, studentId, canonicalFilesHash(files))`；单文件题维持 `(exerciseId, studentId, sha256(code))`；重复提交直接返回不再重评
  - 导出 `validateFiles(files: SubmissionFile[]): string | null`（Task 6 复用）
  - `runReviewAndPublish` / `rescanPendingReviews` 删除；`archiveToGit` 保留并传 files

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/src/__tests__/submissionFiles.test.ts
import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { createSubmission, validateFiles, type SubmissionDeps } from "../controllers/submissionController";
import type { GitService } from "../gitService";
import type { SSEMessage } from "@classroom/shared";

function makeDeps(p = createPersistence(":memory:")) {
  const sse: SSEMessage[] = [];
  const gitArgs: unknown[] = [];
  const git = {
    async ensureClone() {}, async alignToRemote() {}, async hasUnpushedMainCommits() { return false; },
    async pushMain() { return "ok"; }, async commitAndPushMain() { return "ok"; },
    async createStudentBranches() {},
    async writeToStudentBranch(args: unknown) { gitArgs.push(args); return "ok"; },
    async readFileFromMain() { return ""; }, async listFilesFromMain() { return []; },
  } as unknown as GitService;
  const deps: SubmissionDeps = { persistence: p, git, publish: (m) => sse.push(m) };
  return { p, deps, sse, gitArgs };
}

function seed(p: ReturnType<typeof createPersistence>) {
  p.replaceRoster([{ studentId: "2025001", studentName: "张三" }]);
  p.upsertAssignment({ id: "a1", title: "t", week: 3, isPublished: true, createdAt: 1, publishedAt: 1 });
  p.upsertExercise({ id: "ef", assignmentId: "a1", order: 1, filename: "01.py",
    problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1 });
  p.upsertExercise({ id: "ep", assignmentId: "a1", order: 2, filename: "weather-app",
    problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1,
    kind: "project", dir: "weather-app", entry: "main.py" });
}

describe("提交纯归档（files）", () => {
  it("项目题提交：入库 files + git 归档传 files + SSE + review 为 null", () => {
    const { p, deps, sse, gitArgs } = makeDeps();
    seed(p);
    const files = [{ path: "main.py", content: "m" }, { path: "utils.py", content: "u" }];
    const r = createSubmission(deps, {
      exerciseId: "ep", studentId: "2025001", studentName: "张三",
      code: "m", filePath: "week-03/weather-app/main.py", source: "manual", files,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.submission.review).toBeNull();   // 纯归档
    expect(r.submission.files).toEqual(files);
    expect(sse.some((m) => m.type === "submission_received")).toBe(true);
    expect(gitArgs.length).toBe(1);
    expect((gitArgs[0] as { files?: unknown }).files).toEqual(files);
  });

  it("项目题幂等：同 files 重复提交 created=false 且不再归档", () => {
    const { p, deps, gitArgs } = makeDeps();
    seed(p);
    const files = [{ path: "main.py", content: "m" }];
    const input = { exerciseId: "ep" as const, studentId: "2025001", studentName: "张三",
      code: "m", filePath: "x", source: "manual" as const, files };
    expect(createSubmission(deps, input).created ?? false).toBe(true);
    const second = createSubmission(deps, input);
    expect(second.created ?? true).toBe(false);
    expect(gitArgs.length).toBe(1);
  });

  it("校验链：项目缺 files / code 与入口不一致 / 路径穿越 / 单文件带 files 均拒绝", () => {
    const { p, deps } = makeDeps();
    seed(p);
    expect(createSubmission(deps, { exerciseId: "ep", studentId: "2025001", studentName: "张三",
      code: "m", source: "manual" } as never).ok).toBe(false);
    expect(createSubmission(deps, { exerciseId: "ep", studentId: "2025001", studentName: "张三",
      code: "WRONG", source: "manual", files: [{ path: "main.py", content: "m" }] }).ok).toBe(false);
    expect(createSubmission(deps, { exerciseId: "ep", studentId: "2025001", studentName: "张三",
      code: "m", source: "manual", files: [{ path: "../evil.py", content: "x" }, { path: "main.py", content: "m" }] }).ok).toBe(false);
    expect(createSubmission(deps, { exerciseId: "ef", studentId: "2025001", studentName: "张三",
      code: "s", source: "manual", files: [{ path: "01.py", content: "s" }] }).ok).toBe(false);
  });

  it("validateFiles 边界：空/超50个/超100KB/超500KB", () => {
    expect(validateFiles([])).toBeTruthy();
    expect(validateFiles(Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.py`, content: "x" })))).toBeTruthy();
    expect(validateFiles([{ path: "big.py", content: "a".repeat(101 * 1024) }])).toBeTruthy();
    expect(validateFiles(Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.py`, content: "a".repeat(90 * 1024) })))).toBeTruthy();
    expect(validateFiles([{ path: "ok.py", content: "x" }])).toBeNull();
  });

  it("单文件题旧行为完全保留（无 files）", () => {
    const { p, deps } = makeDeps();
    seed(p);
    const r = createSubmission(deps, { exerciseId: "ef", studentId: "2025001", studentName: "张三",
      code: "print(1)", source: "manual" });
    expect(r.ok && r.created).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL（validateFiles 未导出；项目题按单文件哈希处理等）

- [ ] **Step 3: 改 submissionController**

`packages/server/src/controllers/submissionController.ts`：

1) import 区：去 `ReviewService`；加 `canonicalFilesHash`（`./assignmentFiles`）与 `type SubmissionFile, type ReviewResult`（`@classroom/shared` 已有 ReviewResult，补 SubmissionFile）。

2) `SubmissionDeps` 改为：

```ts
export interface SubmissionDeps {
  persistence: Persistence;
  git: GitService | null;             // 未配置 → 跳过归档（git_synced 保持 0，同步任务补推）
  publish: (msg: SSEMessage) => void;
}
```

3) `computeCodeHash` 之后加校验与哈希工具：

```ts
const MAX_FILES = 50;
const MAX_FILE_BYTES = 100 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024;

/** files 快照校验（V2.0 wire 约束，spec §4.1）；返回 null = 通过，否则错误文案 */
export function validateFiles(files: SubmissionFile[]): string | null {
  if (!Array.isArray(files) || files.length === 0) return "files 不能为空";
  if (files.length > MAX_FILES) return "文件数超过 50 上限";
  let total = 0;
  for (const f of files) {
    if (!f || typeof f.path !== "string" || !f.path || typeof f.content !== "string") return "文件项缺少 path/content";
    if (f.path.includes("\\") || f.path.startsWith("/") || /^[a-zA-Z]:/.test(f.path) || f.path.split("/").includes("..")) {
      return `非法路径：${f.path}`;
    }
    if (f.path.split("/").some((seg) => ["__pycache__", ".venv", "venv", ".git"].includes(seg) || seg.endsWith(".pyc") || seg === ".DS_Store")) {
      return `不应提交的文件：${f.path}`;
    }
    const size = Buffer.byteLength(f.content, "utf8");
    if (size > MAX_FILE_BYTES) return `文件超过 100KB：${f.path}`;
    total += size;
  }
  if (total > MAX_TOTAL_BYTES) return "项目总大小超过 500KB";
  return null;
}
```

4) `createSubmission` 主体（校验链至返回）替换为：

```ts
export function createSubmission(deps: SubmissionDeps, input: SubmissionInput): CreateSubmissionResult {
  const { persistence } = deps;
  if (!input?.exerciseId || !input.studentId || typeof input.code !== "string") {
    return { ok: false, status: 400, error: "缺少必要字段" };
  }
  const exercise = persistence.getExercise(input.exerciseId);
  if (!exercise || !exercise.isActive) return { ok: false, status: 400, error: "练习不存在或已下线" };
  const assignment = persistence.getAssignment(exercise.assignmentId);
  if (!assignment || !assignment.isPublished) return { ok: false, status: 400, error: "练习未发布" };
  const rosterEntry = persistence.getRosterEntry(input.studentId.trim());
  if (!rosterEntry) return { ok: false, status: 400, error: "学号不在名册" };

  const kind = exercise.kind ?? "file";
  let codeHash: string;
  let files: SubmissionFile[] | null;
  if (kind === "project") {
    if (!input.files) return { ok: false, status: 400, error: "项目练习必须提交 files" };
    const verr = validateFiles(input.files);
    if (verr) return { ok: false, status: 400, error: verr };
    const entry = exercise.entry ?? "main.py";
    const entryFile = input.files.find((f) => f.path === entry);
    if (!entryFile) return { ok: false, status: 400, error: `缺少入口文件 ${entry}` };
    if (entryFile.content !== input.code) return { ok: false, status: 400, error: "code 与入口文件内容不一致" };
    if (Buffer.byteLength(input.code, "utf8") > 50 * 1024) return { ok: false, status: 400, error: "代码超过 50KB 限制" };
    codeHash = canonicalFilesHash(input.files);
    files = input.files;
  } else {
    if (input.files) return { ok: false, status: 400, error: "单文件练习不支持 files" };
    if (Buffer.byteLength(input.code, "utf8") > 50 * 1024) return { ok: false, status: 400, error: "代码超过 50KB 限制" };
    codeHash = computeCodeHash(input.code);
    files = null;
  }

  // 纯归档（spec §4.1）：幂等命中直接返回，不重评
  const existing = persistence.findSubmissionByKey(exercise.id, rosterEntry.studentId, codeHash);
  if (existing) return { ok: true, created: false, submission: existing };

  const submission: Submission = {
    id: randomUUID(), exerciseId: exercise.id, studentId: rosterEntry.studentId,
    studentName: rosterEntry.studentName, code: input.code,
    source: input.source === "manual" ? "manual" : "auto",
    submittedAt: Date.now(), review: null, files,
  };
  persistence.insertSubmission({ ...submission, codeHash, gitSynced: false });
  deps.publish({ type: "submission_received", data: {
    submissionId: submission.id, exerciseId: exercise.id, studentId: submission.studentId,
    assignmentId: assignment.id, submittedAt: submission.submittedAt } });
  void archiveToGit(deps, submission).catch((err) =>
    logEvent({ event: "git.async_error", level: "error", data: { submissionId: submission.id, error: String(err) } }));
  return { ok: true, created: true, submission };
}
```

5) `archiveToGit` 的 `writeToStudentBranch` 调用加 files：

```ts
  const r = await deps.git.writeToStudentBranch({
    studentId: submission.studentId, studentName: submission.studentName,
    week: assignment.week, filename: exercise.filename, content: submission.code,
    files: submission.files ?? undefined,
  });
```

6) **删除** `runReviewAndPublish` 与 `rescanPendingReviews` 两个函数（评审逻辑移至 Task 6 的 reviewController）。

- [ ] **Step 4: 改 index.ts 装配**

`packages/server/src/index.ts`：

1) L21 import 改为 `import { type SubmissionDeps } from "../controllers/submissionController";`（去 `rescanPendingReviews`）。
2) L70-73 `submissionDeps` 改为 `const submissionDeps: SubmissionDeps = { persistence, git, publish: (msg) => hub.publishMessage(msg) };`（去 reviewService——Task 6 会把它接进 review 路由）。
3) L214 `void rescanPendingReviews(submissionDeps).catch(() => {});` 整行删除，并在上方注释块（L208「补扫 review 为空的提交（A29）」）改为「V2.0：纯归档语义，启动不再补扫（review NULL 为合法态）」。

- [ ] **Step 5: 跑测试通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS（若既有 submission 测试引用了已删导出，按新语义修断言：重复提交不再触发重评）

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/controllers/submissionController.ts packages/server/src/index.ts packages/server/src/__tests__/submissionFiles.test.ts
git commit -m "feat(server): 提交纯归档——files 校验/项目哈希幂等/评审触发移除/启动补扫退役"
```

---

### Task 6: 服务端 reviews/request 路由 + 评审 fail 注入聚合

**Files:**
- Create: `packages/server/src/controllers/reviewController.ts`
- Create: `packages/server/src/routes/reviews.ts`
- Modify: `packages/server/src/index.ts`（注册路由）
- Test: `packages/server/src/__tests__/reviewRequest.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1（`getLatestSubmissionByExerciseStudent`、`ReviewRequestInput`）、Task 5（`validateFiles`）、现有 `ReviewService.review(exercise, code)`、`StateManager.apply(ev, explanation)`、`NormalizedEvent`（shared/events.ts）
- Produces:
  - `POST /api/reviews/request` → 200 `{ review: ReviewResult, submissionId: string | null }` / 400 `{ error }`
  - `buildReviewInput(exercise: Exercise, code: string, files?: SubmissionFile[]): string`（入口 + 其余 .py 按路径拼接，带分隔头）
  - `requestReview(deps: ReviewRequestDeps, input: ReviewRequestInput): Promise<ReviewRequestResult>`
  - `ReviewRequestDeps = { persistence; reviewService; stateManager; publish: (msg: SSEMessage) => void; publishSnapshot: () => void; }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/src/__tests__/reviewRequest.test.ts
import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { createStateManager, type StateManager } from "../stateManager";
import { requestReview, buildReviewInput, type ReviewRequestDeps } from "../controllers/reviewController";
import type { ReviewService } from "../reviewService";
import type { SSEMessage } from "@classroom/shared";

function makeDeps(reviewStatus: "pass" | "fail" | "unreviewed") {
  const p = createPersistence(":memory:");
  p.replaceRoster([{ studentId: "2025001", studentName: "张三" }]);
  p.upsertAssignment({ id: "a1", title: "t", week: 3, isPublished: true, createdAt: 1, publishedAt: 1 });
  p.upsertExercise({ id: "ep", assignmentId: "a1", order: 1, filename: "weather-app",
    problemStatement: "做天气", starterCode: "", testCases: [], versionHash: "v1", isActive: true, createdAt: 1,
    kind: "project", dir: "weather-app", entry: "main.py" });
  const review = { status: reviewStatus, reason: "死循环风险", reviewedAt: 1, model: "m", source: "llm" as const };
  const reviewService = { async review() { return review; } } as unknown as ReviewService;
  const stateManager = createStateManager();
  const sse: SSEMessage[] = [];
  let snapshotPushes = 0;
  const deps: ReviewRequestDeps = {
    persistence: p, reviewService, stateManager,
    publish: (m) => sse.push(m),
    publishSnapshot: () => { snapshotPushes++; },
  };
  return { p, deps, sse, snapshotPushes, review };
}

const files = [{ path: "main.py", content: "m" }, { path: "utils.py", content: "u" }];
const baseInput = { studentId: "2025001", exerciseId: "ep", code: "m", files };

describe("运行触发评审（reviews/request）", () => {
  it("buildReviewInput：入口 + 其余 .py 拼接（非 .py 不入）", () => {
    const ex = { entry: "main.py" } as never;
    const out = buildReviewInput(ex, "MAIN", [...files, { path: "data/x.txt", content: "T" }]);
    expect(out.startsWith("MAIN")).toBe(true);
    expect(out).toContain("# ===== 文件: utils.py =====");
    expect(out).toContain("u");
    expect(out).not.toContain("x.txt");
  });

  it("有提交记录：写回最新 review + SSE review_complete", async () => {
    const { p, deps, sse, review } = makeDeps("fail");
    p.insertSubmission({ id: "s1", exerciseId: "ep", studentId: "2025001", studentName: "张三",
      code: "m", source: "manual", submittedAt: 100, review: null, codeHash: "h", gitSynced: true, files });
    const r = await requestReview(deps, baseInput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submissionId).toBe("s1");
    expect(r.review.status).toBe("fail");
    const latest = p.getLatestSubmissionByExerciseStudent("ep", "2025001")!;
    expect(latest.review!.status).toBe("fail");
    expect(sse.some((m) => m.type === "review_complete")).toBe(true);
  });

  it("fail 注入聚合：stateManager 出现 review_fail 事件 + 快照推送", async () => {
    const { p, deps, snapshotPushes } = makeDeps("fail");
    p.insertSubmission({ id: "s1", exerciseId: "ep", studentId: "2025001", studentName: "张三",
      code: "m", source: "manual", submittedAt: 100, review: null, codeHash: "h", gitSynced: true });
    await requestReview(deps, baseInput);
    const rec = deps.stateManager.listRecords()[0];
    expect(rec).toBeTruthy();
    const failEvents = rec!.events.filter((e) => e.subtype === "review_fail");
    expect(failEvents.length).toBe(1);
    expect(failEvents[0].knowledge).toBe("死循环风险");
    expect(rec!.consecutiveErrors).toBe(1);
    expect(snapshotPushes).toBe(1);
  });

  it("无提交记录：仅回传评审，不落库不注入", async () => {
    const { p, deps, stateManager } = { ...makeDeps("pass"), stateManager: undefined as unknown as StateManager };
    const d = makeDeps("pass");
    const r = await requestReview(d.deps, baseInput);
    expect(r.ok && r.submissionId).toBe(null);
    expect(d.p.getSubmissionsByStudent("2025001")).toEqual([]);
    expect(d.deps.stateManager.listRecords()).toEqual([]);
    void p; void stateManager;
  });

  it("校验链：名册/未发布/项目缺 files", async () => {
    const { deps } = makeDeps("pass");
    expect((await requestReview(deps, { ...baseInput, studentId: "999" })).ok).toBe(false);
    const d2 = makeDeps("pass");
    d2.p.upsertAssignment({ id: "a2", title: "t", week: 9, isPublished: false, createdAt: 1 });
    expect((await requestReview(deps, { ...baseInput, files: undefined })).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @classroom/server test`
Expected: FAIL（reviewController 不存在）

- [ ] **Step 3: 实现 reviewController**

```ts
// packages/server/src/controllers/reviewController.ts
import type {
  Exercise, NormalizedEvent, ReviewResult, SSEMessage, SubmissionFile, ReviewRequestInput,
} from "@classroom/shared";
import type { Persistence } from "../persistence";
import type { ReviewService } from "../reviewService";
import type { StateManager } from "../stateManager";
import { validateFiles } from "./submissionController";
import { logEvent } from "../logger";

export interface ReviewRequestDeps {
  persistence: Persistence;
  reviewService: ReviewService;
  stateManager: StateManager;
  publish: (msg: SSEMessage) => void;
  publishSnapshot: () => void;   // fail 注入后推全量快照（告警/聚合面板刷新）
}

export type ReviewRequestResult =
  | { ok: true; review: ReviewResult; submissionId: string | null }
  | { ok: false; status: 400; error: string };

/** 评审输入组装（spec §4.2）：入口 + 其余 .py 按路径拼接，非 .py 素材不入 */
export function buildReviewInput(exercise: Pick<Exercise, "entry">, code: string, files?: SubmissionFile[]): string {
  if (!files) return code;
  const entry = exercise.entry ?? "main.py";
  const others = files
    .filter((f) => f.path.endsWith(".py") && f.path !== entry)
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return [code, ...others.map((f) => `\n\n# ===== 文件: ${f.path} =====\n${f.content}`)].join("");
}

/** fail 合成事件注入 stateManager（spec §4.3）：进告警面板 + 知识点聚合 */
function injectReviewFail(
  deps: ReviewRequestDeps,
  args: { studentId: string; studentName: string; review: ReviewResult },
): void {
  const ev: NormalizedEvent = {
    studentId: args.studentId, studentName: args.studentName, classId: "default",
    eventType: "run", success: false,
    errorType: "review_fail", errorMessage: args.review.reason, samples: [],
    rawMessage: `评审未通过：${args.review.reason}`, cacheKey: null, ts: Date.now(),
  };
  deps.stateManager.apply(ev, { category: "逻辑错误", subtype: "review_fail", knowledge: args.review.reason });
  deps.publishSnapshot();
  logEvent({ event: "review.fail_injected", level: "info", data: { studentId: args.studentId, exerciseId: undefined, reason: args.review.reason } });
}

export async function requestReview(deps: ReviewRequestDeps, input: ReviewRequestInput): Promise<ReviewRequestResult> {
  if (!input?.studentId || !input.exerciseId || typeof input.code !== "string") {
    return { ok: false, status: 400, error: "缺少必要字段" };
  }
  const rosterEntry = deps.persistence.getRosterEntry(input.studentId.trim());
  if (!rosterEntry) return { ok: false, status: 400, error: "学号不在名册" };
  const exercise = deps.persistence.getExercise(input.exerciseId);
  if (!exercise || !exercise.isActive) return { ok: false, status: 400, error: "练习不存在或已下线" };
  const assignment = deps.persistence.getAssignment(exercise.assignmentId);
  if (!assignment || !assignment.isPublished) return { ok: false, status: 400, error: "练习未发布" };

  const kind = exercise.kind ?? "file";
  if (kind === "project") {
    if (!input.files) return { ok: false, status: 400, error: "项目练习必须携带 files" };
    const verr = validateFiles(input.files);
    if (verr) return { ok: false, status: 400, error: verr };
    const entry = exercise.entry ?? "main.py";
    const entryFile = input.files.find((f) => f.path === entry);
    if (!entryFile) return { ok: false, status: 400, error: `缺少入口文件 ${entry}` };
    if (entryFile.content !== input.code) return { ok: false, status: 400, error: "code 与入口文件内容不一致" };
  }
  if (Buffer.byteLength(input.code, "utf8") > 50 * 1024) {
    return { ok: false, status: 400, error: "代码超过 50KB 限制" };
  }

  const reviewCode = buildReviewInput(exercise, input.code, kind === "project" ? input.files : undefined);
  const review = await deps.reviewService.review(exercise, reviewCode);   // 缓存三态机制原样（A30）

  const latest = deps.persistence.getLatestSubmissionByExerciseStudent(exercise.id, rosterEntry.studentId);
  if (latest) {
    deps.persistence.updateSubmissionReview(latest.id, review);
    deps.publish({ type: "review_complete", data: {
      submissionId: latest.id, exerciseId: exercise.id, studentId: rosterEntry.studentId,
      assignmentId: assignment.id, submittedAt: latest.submittedAt, review } });
    if (review.status === "fail") {
      injectReviewFail(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, review });
    }
  }
  return { ok: true, review, submissionId: latest?.id ?? null };
}
```

- [ ] **Step 4: 路由 + 装配**

```ts
// packages/server/src/routes/reviews.ts
import type { Express } from "express";
import { requestReview, type ReviewRequestDeps } from "../controllers/reviewController";
import { logEvent } from "../logger";

export function registerReviewRoutes(app: Express, deps: ReviewRequestDeps) {
  app.post("/api/reviews/request", async (req, res) => {
    const r = await requestReview(deps, req.body);
    if (!r.ok) {
      logEvent({ event: "api.review_rejected", level: "warn", data: { error: r.error } });
      return res.status(r.status).json({ error: r.error });
    }
    return res.json({ review: r.review, submissionId: r.submissionId });
  });
}
```

`packages/server/src/index.ts`：

1) import 区加：
```ts
import { registerReviewRoutes } from "./routes/reviews";
import { type ReviewRequestDeps } from "./controllers/reviewController";
```
2) 路由注册区（`registerSubmissionRoutes` 之后）加：
```ts
  const reviewRequestDeps: ReviewRequestDeps = {
    persistence, reviewService, stateManager,
    publish: (msg) => hub.publishMessage(msg),
    publishSnapshot: () => hub.publish(buildSnapshot()),
  };
  registerReviewRoutes(app, reviewRequestDeps);
```

- [ ] **Step 5: 跑测试通过**

Run: `pnpm --filter @classroom/server test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/controllers/reviewController.ts packages/server/src/routes/reviews.ts packages/server/src/index.ts packages/server/src/__tests__/reviewRequest.test.ts
git commit -m "feat(server): POST /api/reviews/request——F5 触发评审、写回最新提交、fail 注入实时聚合"
```

---

### Task 7: 扩展 projectFiles 工具（忽略清单 + canonicalFilesHash 副本 + 目录快照）

**Files:**
- Create: `d:\ruan\vscode-pylearner\src\submission\projectFiles.ts`
- Test: `d:\ruan\vscode-pylearner\src\test\projectFiles.test.ts`（新建）

**Interfaces:**
- Consumes: 无（纯新模块）
- Produces:
  - `interface SubmissionFile { path: string; content: string }`（与 server shared 对齐的本地副本，F6）
  - `canonicalFilesHash(files: SubmissionFile[]): string`——与 server `assignmentFiles.canonicalFilesHash` **逐字一致**
  - `isIgnoredEntry(name: string, isDir: boolean): boolean`（忽略集比 server 多 `exercise.json`——manifest 不入学生提交快照）
  - `interface ProjectFs { readDirectory(fsPath: string): Promise<[string, FileType][] | null>; readFile(fsPath: string): Promise<string | null> }`（`FileType` 用 `{ isDirectory: boolean }` 形状自定义，避免测试引 vscode）
  - `listProjectFiles(fs: ProjectFs, dirFsPath: string): Promise<SubmissionFile[] | null>`——递归收集，path 相对 dirFsPath 的 POSIX 路径；目录不可读 → null

- [ ] **Step 1: 写失败测试**

```ts
// src/test/projectFiles.test.ts
import { describe, it, expect } from "vitest";
import { canonicalFilesHash, isIgnoredEntry, listProjectFiles, type ProjectFs } from "../submission/projectFiles";

const tree: Record<string, string | "dir"> = {
  "C:\\ws\\week-03\\app": "dir",
  "C:\\ws\\week-03\\app\\main.py": "# main",
  "C:\\ws\\week-03\\app\\utils.py": "# u",
  "C:\\ws\\week-03\\app\\exercise.json": "{}",
  "C:\\ws\\week-03\\app\\data": "dir",
  "C:\\ws\\week-03\\app\\data\\city.txt": "BJ",
  "C:\\ws\\week-03\\app\\__pycache__": "dir",
  "C:\\ws\\week-03\\app\\__pycache__\\x.pyc": "bin",
  "C:\\ws\\week-03\\app\\.venv": "dir",
  "C:\\ws\\week-03\\app\\.venv\\y.py": "# v",
};

const fs: ProjectFs = {
  async readDirectory(fsPath) {
    if (!(fsPath in tree)) return null;
    return Object.keys(tree)
      .filter((k) => k.startsWith(fsPath + "\\"))
      .map((k) => k.slice(fsPath.length + 1))
      .filter((rest) => !rest.includes("\\"))
      .map((name) => [name, tree[`${fsPath}\\${name}`] === "dir" ? { isDirectory: true } : { isDirectory: false }] as [string, { isDirectory: boolean }]);
  },
  async readFile(fsPath) {
    const v = tree[fsPath];
    return typeof v === "string" ? v : null;
  },
};

describe("projectFiles", () => {
  it("listProjectFiles：递归收集、排除忽略集与 exercise.json、POSIX 相对路径", async () => {
    const files = await listProjectFiles(fs, "C:\\ws\\week-03\\app");
    expect(files!.map((f) => f.path).sort()).toEqual(["data/city.txt", "main.py", "utils.py"]);
  });
  it("目录不存在 → null", async () => {
    expect(await listProjectFiles(fs, "C:\\nope")).toBeNull();
  });
  it("canonicalFilesHash 与 server 契约一致（排序无关、64-hex）", () => {
    const a = [{ path: "a.py", content: "1" }, { path: "b.py", content: "2" }];
    const b = [{ path: "b.py", content: "2" }, { path: "a.py", content: "1" }];
    expect(canonicalFilesHash(a)).toBe(canonicalFilesHash(b));
    expect(canonicalFilesHash(a)).toMatch(/^[0-9a-f]{64}$/);
    // 与 server 端相同输入的期望值（人工对拍一次写入测试固定）
    expect(canonicalFilesHash([{ path: "main.py", content: "m" }]))
      .toBe("e2a63f7c4e6f5b8b1a3ef9dbb4e1e6a5e8d4b03c1a9b6d8e0f2b7f9a4c5d3e6b1");
  });
  it("isIgnoredEntry 覆盖 server 忽略集 + exercise.json", () => {
    expect(isIgnoredEntry("__pycache__", true)).toBe(true);
    expect(isIgnoredEntry(".venv", true)).toBe(true);
    expect(isIgnoredEntry("venv", true)).toBe(true);
    expect(isIgnoredEntry(".git", true)).toBe(true);
    expect(isIgnoredEntry("x.pyc", false)).toBe(true);
    expect(isIgnoredEntry(".DS_Store", false)).toBe(true);
    expect(isIgnoredEntry("exercise.json", false)).toBe(true);
    expect(isIgnoredEntry("main.py", false)).toBe(false);
  });
});
```

（注：第三个 it 的固定期望 hash 值在实现后用 `node -e "console.log(require('crypto').createHash('sha256').update(JSON.stringify([{path:'main.py',content:'m'}])).digest('hex'))"` 实算替换——Step 3 完成后运行一次，把真实值填进测试再提交。）

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/submission/projectFiles.ts
import crypto from "node:crypto";

/** 两仓 wire 契约（F6）：与 server shared SubmissionFile 对齐 */
export interface SubmissionFile { path: string; content: string }

/** 忽略清单：server 端集合 + exercise.json（manifest 不入学生提交快照，本地保留供定位） */
const IGNORE_DIRS = new Set(["__pycache__", ".venv", "venv", ".git"]);
const IGNORE_FILES = new Set([".DS_Store", ".pyc", "exercise.json"]);

export function isIgnoredEntry(name: string, isDir: boolean): boolean {
  return isDir ? IGNORE_DIRS.has(name) : IGNORE_FILES.has(name);
}

/**
 * 提交幂等内容哈希——两仓契约：与 server assignmentFiles.canonicalFilesHash 逐字一致，改动必须双侧同步。
 */
export function canonicalFilesHash(files: SubmissionFile[]): string {
  const sorted = files
    .map((f) => ({ path: f.path, content: f.content }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export interface ProjectFs {
  readDirectory(fsPath: string): Promise<[string, { isDirectory: boolean }][] | null>;
  readFile(fsPath: string): Promise<string | null>;
}

/** 递归收集项目目录文件快照；path 为相对目录的 POSIX 路径；目录不可读 → null */
export async function listProjectFiles(fs: ProjectFs, dirFsPath: string): Promise<SubmissionFile[] | null> {
  const entries = await fs.readDirectory(dirFsPath);
  if (entries === null) return null;
  const out: SubmissionFile[] = [];
  for (const [name, type] of entries) {
    if (isIgnoredEntry(name, type.isDirectory)) continue;
    const abs = `${dirFsPath}\\${name}`;
    if (type.isDirectory) {
      const sub = await listProjectFiles(fs, abs);
      if (sub) out.push(...sub.map((f) => ({ path: `${name}/${f.path}`, content: f.content })));
    } else {
      const content = await fs.readFile(abs);
      if (content !== null) out.push({ path: name, content });
    }
  }
  return out;
}
```

- [ ] **Step 4: 实算对拍值并修正测试**

Run: `node -e "const c=require('crypto');console.log(c.createHash('sha256').update(JSON.stringify([{path:'main.py',content:'m'}])).digest('hex'))"`
把输出的真实 hash 填入 Step 1 测试的固定期望值（同时用 server 侧 Task 2 的 canonicalFilesHash 对同一输入跑一次，确认两仓一致）。

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**（在扩展仓执行）

```bash
git add src/submission/projectFiles.ts src/test/projectFiles.test.ts
git commit -m "feat: projectFiles 工具——忽略清单/canonicalFilesHash 契约副本/项目目录快照"
```

---

### Task 8: 扩展 exerciseLocator（单文件头部 id + 项目 manifest 定位）

**Files:**
- Create: `d:\ruan\vscode-pylearner\src\submission\exerciseLocator.ts`
- Test: `d:\ruan\vscode-pylearner\src\test\exerciseLocator.test.ts`（新建）

**Interfaces:**
- Consumes: `scanExerciseId`（src/submission/exerciseHeader.ts，现有）
- Produces:
  - `interface LocatedExercise { exerciseId: string; kind: "file" | "project"; entry?: string; projectDirFsPath?: string }`
  - `resolveExercise(deps: LocatorDeps, filePath: string, content: string): Promise<LocatedExercise | null>`
  - `LocatorDeps = { rootFsPath: string; join: (dir: string, rel: string) => string; readFile: (fsPath: string) => Promise<string | null> }`
  - `readExerciseManifest(deps: LocatorDeps, projectDirFsPath: string): Promise<{ exerciseId: string; entry: string } | null>`（读 `<dir>/exercise.json`，JSON 解析失败/缺 id → null）

- [ ] **Step 1: 写失败测试**

```ts
// src/test/exerciseLocator.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveExercise, readExerciseManifest } from "../submission/exerciseLocator";

const ID = "01234567-89ab-cdef-0123-456789abcdef";
const root = path.join("C:", "ws");
const files: Record<string, string> = {
  [path.join(root, "week-03", "weather-app", "exercise.json")]: `{ "exerciseId": "${ID}", "entry": "main.py" }`,
  [path.join(root, "week-03", "weather-app", "main.py")]: "# main",
};
const deps = {
  rootFsPath: root,
  join: (d: string, r: string) => path.join(d, r),
  readFile: async (fsPath: string) => files[fsPath] ?? null,
};

describe("exerciseLocator", () => {
  it("单文件：头部 id 直取，kind=file", async () => {
    const r = await resolveExercise(deps, path.join(root, "week-03", "01.py"), `# exercise-id: ${ID}\nprint(1)`);
    expect(r).toEqual({ exerciseId: ID, kind: "file" });
  });
  it("项目：当前文件（含非入口 .py）经 exercise.json 定位", async () => {
    const r = await resolveExercise(deps, path.join(root, "week-03", "weather-app", "utils.py"), "def f(): pass");
    expect(r).toEqual({ exerciseId: ID, kind: "project", entry: "main.py", projectDirFsPath: path.join(root, "week-03", "weather-app") });
  });
  it("manifest 缺 id / 非法 JSON / 无 manifest → null", async () => {
    const bad = { ...deps, readFile: async () => `{ "entry": "main.py" }` };
    expect(await resolveExercise(bad, path.join(root, "week-03", "weather-app", "utils.py"), "x")).toBeNull();
    const bad2 = { ...deps, readFile: async () => "not-json" };
    expect(await readExerciseManifest(bad2, path.join(root, "week-03", "weather-app"))).toBeNull();
    const none = { ...deps, readFile: async () => null };
    expect(await resolveExercise(none, path.join(root, "week-03", "misc", "a.py"), "x")).toBeNull();
  });
  it("week 目录外的文件 → null", async () => {
    expect(await resolveExercise(deps, path.join(root, "other", "a.py"), "x")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/submission/exerciseLocator.ts
import { scanExerciseId } from "./exerciseHeader";

export interface LocatedExercise {
  exerciseId: string;
  kind: "file" | "project";
  entry?: string;                 // 项目：入口文件（缺省 main.py）
  projectDirFsPath?: string;      // 项目：week-XX/<dir> 绝对路径
}

export interface LocatorDeps {
  rootFsPath: string;
  join: (dir: string, rel: string) => string;
  readFile: (fsPath: string) => Promise<string | null>;
}

/** 读项目 manifest；缺 exerciseId / 非法 → null（spec §5.2：项目题定位走 exercise.json） */
export async function readExerciseManifest(
  deps: LocatorDeps, projectDirFsPath: string,
): Promise<{ exerciseId: string; entry: string } | null> {
  const raw = await deps.readFile(deps.join(projectDirFsPath, "exercise.json"));
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as { exerciseId?: string; entry?: string };
    if (typeof m.exerciseId !== "string" || !m.exerciseId) return null;
    return { exerciseId: m.exerciseId, entry: typeof m.entry === "string" && m.entry ? m.entry : "main.py" };
  } catch {
    return null;
  }
}

const WEEK_SEG_RE = /[\\/]week-(\d{2})[\\/]/;

/** 定位当前文件所属 exercise：优先头部 id（单文件）；否则按 week-XX/<dir>/exercise.json（项目） */
export async function resolveExercise(
  deps: LocatorDeps, filePath: string, content: string,
): Promise<LocatedExercise | null> {
  const headerId = scanExerciseId(content);
  if (headerId) return { exerciseId: headerId, kind: "file" };

  const norm = filePath.replace(/\//g, "\\");
  const root = deps.rootFsPath.replace(/\//g, "\\").replace(/[\\/]+$/, "");
  if (!norm.startsWith(root + "\\")) return null;
  const rel = norm.slice(root.length + 1);          // week-03\<...>
  const m = rel.match(/^week-\d{2}\\([^\\]+)\\(.+)$/);
  if (!m) return null;                               // week 目录一级 .py（无头部 id）或目录外 → 非 exercise
  const projectDirFsPath = deps.join(deps.join(root, rel.split("\\")[0]), m[1]);
  const manifest = await readExerciseManifest(deps, projectDirFsPath);
  if (!manifest) return null;
  return { exerciseId: manifest.exerciseId, kind: "project", entry: manifest.entry, projectDirFsPath };
}
```

- [ ] **Step 4: 跑测试通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**（扩展仓）

```bash
git add src/submission/exerciseLocator.ts src/test/exerciseLocator.test.ts
git commit -m "feat: exerciseLocator——单文件头部 id / 项目 manifest 双轨定位"
```

---

### Task 9: 扩展提交链多文件化（纯归档语义）

**Files:**
- Create: `d:\ruan\vscode-pylearner\src\submission\projectSnapshot.ts`
- Modify: `d:\ruan\vscode-pylearner\src\submission\submissionReporter.ts`
- Modify: `d:\ruan\vscode-pylearner\src\submission\submitCommand.ts:4-10`
- Test: `d:\ruan\vscode-pylearner\src\test\projectSnapshot.test.ts`、`src\test\submitCodeProject.test.ts`（新建）

**Interfaces:**
- Consumes: Task 7（`listProjectFiles/canonicalFilesHash/SubmissionFile/ProjectFs`）、Task 8（`resolveExercise/readExerciseManifest/LocatorDeps`）、现有 `KeyValueStore`
- Produces:
  - `buildProjectSnapshot(deps: SnapshotDeps, filePath: string, content: string): Promise<{ exerciseId: string; files: SubmissionFile[]; entryContent: string } | null>`
  - `SnapshotDeps = { locator: LocatorDeps; projectFs: ProjectFs }`
  - `SubmissionDeps` 扩展: `buildProjectSnapshot?: (filePath: string, content: string) => Promise<{ exerciseId: string; files: SubmissionFile[]; entryContent: string } | null>`
  - `submitCode` 行为：项目题 payload 携带 `files`，幂等键改 `canonicalFilesHash(files)`；单文件题维持 `sha256(content)`
  - `OUTCOME_TEXT.submitted` 文案改为归档语义

- [ ] **Step 1: 写失败测试**

```ts
// src/test/projectSnapshot.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildProjectSnapshot } from "../submission/projectSnapshot";

const ID = "01234567-89ab-cdef-0123-456789abcdef";
const root = path.join("C:", "ws");
const appDir = path.join(root, "week-03", "weather-app");
const fileContents: Record<string, string> = {
  [path.join(appDir, "exercise.json")]: `{ "exerciseId": "${ID}", "entry": "main.py" }`,
  [path.join(appDir, "main.py")]: "# entry",
  [path.join(appDir, "utils.py")]: "# u",
  [path.join(appDir, "data", "city.txt")]: "BJ",
};
const tree: Record<string, string | "dir"> = {
  [appDir]: "dir",
  [path.join(appDir, "main.py")]: "f",
  [path.join(appDir, "utils.py")]: "f",
  [path.join(appDir, "exercise.json")]: "f",
  [path.join(appDir, "data")]: "dir",
  [path.join(appDir, "data", "city.txt")]: "f",
};
const deps = {
  locator: {
    rootFsPath: root,
    join: (d: string, r: string) => path.join(d, r),
    readFile: async (p: string) => fileContents[p] ?? null,
  },
  projectFs: {
    async readDirectory(fsPath: string) {
      if (!(fsPath in tree)) return null;
      return Object.keys(tree)
        .filter((k) => k.startsWith(fsPath + path.sep) && !k.slice(fsPath.length + 1).includes(path.sep))
        .map((k) => k.slice(fsPath.length + 1))
        .map((name) => [name, tree[`${fsPath}${path.sep}${name}`] === "dir" ? { isDirectory: true } : { isDirectory: false }] as [string, { isDirectory: boolean }]);
    },
    readFile: async (p: string) => fileContents[p] ?? null,
  },
};

describe("buildProjectSnapshot", () => {
  it("项目文件快照 + 入口内容，排除 exercise.json", async () => {
    const snap = await buildProjectSnapshot(deps, path.join(appDir, "utils.py"), "# u");
    expect(snap!.exerciseId).toBe(ID);
    expect(snap!.entryContent).toBe("# entry");
    expect(snap!.files.map((f) => f.path).sort()).toEqual(["data/city.txt", "main.py", "utils.py"]);
  });
  it("非项目文件 → null", async () => {
    expect(await buildProjectSnapshot(deps, path.join(root, "week-03", "01.py"), "print(1)")).toBeNull();
  });
});
```

```ts
// src/test/submitCodeProject.test.ts
import { describe, it, expect } from "vitest";
import { submitCode, type SubmissionDeps } from "../submission/submissionReporter";
import { canonicalFilesHash } from "../submission/projectFiles";

const ID = "01234567-89ab-cdef-0123-456789abcdef";
function makeDeps() {
  const state = new Map<string, unknown>();
  const posts: unknown[] = [];
  const deps: SubmissionDeps = {
    teacherUrl: () => "http://t",
    getIdentity: () => ({ studentId: "2025001", studentName: "张三" }),
    onIdentityMissing: () => {},
    globalState: {
      get: (k: string) => state.get(k),
      update: async (k: string, v: unknown) => { state.set(k, v); },
    },
    fetchImpl: (async (url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ submission: {} }), { status: 201 });
    }) as unknown as typeof fetch,
    saveIfDirty: async () => {},
    buildProjectSnapshot: async () => ({
      exerciseId: ID,
      files: [{ path: "main.py", content: "m" }, { path: "utils.py", content: "u" }],
      entryContent: "m",
    }),
  };
  return { deps, posts, state };
}

describe("submitCode 项目化", () => {
  it("项目题：payload 携带 files，code=入口内容，幂等键=canonicalFilesHash", async () => {
    const { deps, posts, state } = makeDeps();
    const r = await submitCode(deps, { filePath: "C:\\ws\\week-03\\app\\utils.py", content: "# u", source: "manual" });
    expect(r).toBe("submitted");
    const body = posts[0] as { files?: unknown[]; code?: string };
    expect(body.files!.length).toBe(2);
    expect(body.code).toBe("m");
    const last = state.get("pylearner.submission.lastHashes") as Record<string, string>;
    expect(last[ID]).toBe(canonicalFilesHash([{ path: "main.py", content: "m" }, { path: "utils.py", content: "u" }]));
  });
  it("同快照重复提交 → skipped", async () => {
    const { deps } = makeDeps();
    await submitCode(deps, { filePath: "x", content: "c", source: "manual" });
    expect(await submitCode(deps, { filePath: "x", content: "c", source: "manual" })).toBe("skipped");
  });
  it("单文件题（无快照函数）：旧行为 payload 无 files", async () => {
    const { deps, posts } = makeDeps();
    (deps as unknown as { buildProjectSnapshot: undefined }).buildProjectSnapshot = undefined;
    const r = await submitCode(deps, { filePath: "C:\\ws\\week-03\\01.py", content: `# exercise-id: ${ID}\nprint(1)`, source: "manual" });
    expect(r).toBe("submitted");
    expect((posts[0] as { files?: unknown }).files).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现 projectSnapshot + 改 submitCode**

```ts
// src/submission/projectSnapshot.ts
import { resolveExercise, type LocatorDeps } from "./exerciseLocator";
import { listProjectFiles, type ProjectFs, type SubmissionFile } from "./projectFiles";

export interface SnapshotDeps { locator: LocatorDeps; projectFs: ProjectFs }

export interface ProjectSnapshot { exerciseId: string; files: SubmissionFile[]; entryContent: string }

/** 当前文件属于项目练习 → 全量快照（排除 exercise.json）+ 入口内容；否则 null */
export async function buildProjectSnapshot(deps: SnapshotDeps, filePath: string, content: string): Promise<ProjectSnapshot | null> {
  const located = await resolveExercise(deps.locator, filePath, content);
  if (!located || located.kind !== "project" || !located.projectDirFsPath) return null;
  const files = await listProjectFiles(deps.projectFs, located.projectDirFsPath);
  if (!files || files.length === 0) return null;
  const entryFile = files.find((f) => f.path === (located.entry ?? "main.py"));
  if (!entryFile) return null;
  return { exerciseId: located.exerciseId, files, entryContent: entryFile.content };
}
```

`src/submission/submissionReporter.ts`：

1) import 加 `import { canonicalFilesHash, type SubmissionFile } from "./projectFiles";`，`SubmissionDeps` 接口加：

```ts
  /** 项目题快照（V2.0）：返回 null = 非项目文件；缺省时仅支持单文件头部 id */
  buildProjectSnapshot?: (filePath: string, content: string) => Promise<{ exerciseId: string; files: SubmissionFile[]; entryContent: string } | null>;
```

2) `submitCode` 主体改为（身份门控/防抖结构保留，定位与 payload 分支化）：

```ts
export async function submitCode(deps: SubmissionDeps, args: { filePath: string; content: string; source: "auto" | "manual" }): Promise<SubmitOutcome> {
  const identity = deps.getIdentity();
  if (!identity.studentId || !identity.studentName) {
    deps.onIdentityMissing();
    return "identity-missing";
  }
  await deps.saveIfDirty?.(args.filePath);

  // 定位（V2.0）：项目快照优先，回退单文件头部 id
  let exerciseId: string | null = null;
  let files: SubmissionFile[] | undefined;
  let payloadCode = args.content;
  const snapshot = deps.buildProjectSnapshot ? await deps.buildProjectSnapshot(args.filePath, args.content) : null;
  if (snapshot) {
    exerciseId = snapshot.exerciseId;
    files = snapshot.files;
    payloadCode = snapshot.entryContent;
  } else {
    exerciseId = scanExerciseId(args.content);
  }
  if (!exerciseId) return "not-exercise";

  const codeHash = files ? canonicalFilesHash(files) : crypto.createHash("sha256").update(args.content).digest("hex");
  const last = (deps.globalState.get(LAST_HASHES_KEY) ?? {}) as Record<string, string>;
  if (last[exerciseId] === codeHash) return "skipped";
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.teacherUrl()}/api/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        exerciseId, studentId: identity.studentId, studentName: identity.studentName,
        code: payloadCode, filePath: args.filePath, source: args.source,
        ...(files ? { files } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "" })) as { error?: string };
      if (body.error === "学号不在名册") {
        deps.onIdentityMissing();
        return "identity-missing";
      }
      return "error";
    }
    last[exerciseId] = codeHash;
    await deps.globalState.update(LAST_HASHES_KEY, last);
    return "submitted";
  } catch {
    return "error";
  }
}
```

3) **删除** `makeHandleRunSuccess`（自动提交链整体退役；F5 评审链在 Task 12 以新模块接回）。

`src/submission/submitCommand.ts` L4-10 文案改：

```ts
export const OUTCOME_TEXT: Record<SubmitOutcome, string> = {
  submitted: "✅ 已归档（运行成功后会自动评审并给出回执）",
  skipped: "该代码已归档过，未重复提交",
  "not-exercise": "当前文件不是课堂练习（缺少课堂头部），无需提交",
  "identity-missing": "请先在身份页设置学号与姓名",
  error: "归档失败，请稍后重试或联系教员",
};
```

- [ ] **Step 4: 修 extension.ts 编译错误**

`makeHandleRunSuccess` 已删——extension.ts L232-238 的引用暂改为注释掉整段 `l1Writer.setSubmissionHandler(...)`（Task 12 会用评审链重新接上）。`npm run compile` 通过即可。

- [ ] **Step 5: 跑测试通过**

Run: `npm test` 然后 `npm run compile`
Expected: PASS + 编译通过（既有 submitCode 旧测试若断言 payload/自动提交，按新语义修正）

- [ ] **Step 6: Commit**（扩展仓）

```bash
git add src/submission/projectSnapshot.ts src/submission/submissionReporter.ts src/submission/submitCommand.ts src/extension.ts src/test/projectSnapshot.test.ts src/test/submitCodeProject.test.ts
git commit -m "feat: 提交链多文件化——项目快照/files payload/项目哈希幂等/纯归档文案"
```

---

### Task 10: 扩展拉取多文件（content JSON 化）

**Files:**
- Modify: `d:\ruan\vscode-pylearner\src\pull\pullCommand.ts`
- Test: `d:\ruan\vscode-pylearner\src\test\pullProject.test.ts`（新建）

**Interfaces:**
- Consumes: 服务端 Task 4 契约——content 响应 `{ kind: "file", filename, content } | { kind: "project", filename, dir, entry, files }`；published 行 exercises 含 `kind/dir/entry`
- Produces: `pullAssignments` 处理项目题（逐文件「存在跳过 + 版本变更提示」）；`pulled` 计文件数

- [ ] **Step 1: 写失败测试**

```ts
// src/test/pullProject.test.ts
import { describe, it, expect } from "vitest";
import { pullAssignments, type PullDeps } from "../pull/pullCommand";

const published = [{
  id: "a1", title: "第 3 周", week: 3,
  exercises: [
    { id: "ef", filename: "01.py", versionHash: "v1", kind: "file" as const },
    { id: "ep", filename: "weather-app", versionHash: "v2", kind: "project" as const, dir: "weather-app", entry: "main.py" },
  ],
}];
const projectContent = {
  kind: "project", filename: "weather-app", dir: "weather-app", entry: "main.py",
  files: [
    { path: "main.py", content: "# m" },
    { path: "data/city.txt", content: "BJ" },
  ],
};

function makeDeps(existing: Set<string>) {
  const written: string[] = [];
  const deps: PullDeps = {
    teacherUrl: () => "http://t",
    globalState: {
      store: new Map<string, unknown>(),
      get(k: string) { return this.store.get(k); },
      update(k: string, v: unknown) { this.store.set(k, v); return Promise.resolve(); },
    },
    fetchImpl: (async (url: string) => {
      if (url.endsWith("/api/assignments/published")) return new Response(JSON.stringify(published), { status: 200 });
      if (url.endsWith("/api/exercises/ep/content")) return new Response(JSON.stringify(projectContent), { status: 200 });
      if (url.endsWith("/api/exercises/ef/content")) return new Response(JSON.stringify({ kind: "file", filename: "01.py", content: "# s" }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch,
    fileExists: async (rel: string) => existing.has(rel),
    writeFile: async (rel: string, content: string) => { written.push(rel); void content; },
  };
  return { deps, written };
}

describe("pullAssignments 项目化", () => {
  it("全量拉取：单文件 + 项目逐文件写入（含子目录）", async () => {
    const { deps, written } = makeDeps(new Set());
    const r = await pullAssignments(deps);
    expect(r.pulled).toBe(3);
    expect(written.sort()).toEqual([
      "week-03/01.py",
      "week-03/weather-app/data/city.txt",
      "week-03/weather-app/main.py",
    ].sort());
  });
  it("二次拉取：全部跳过；versionHash 变更提示（项目以入口文件存在为锚）", async () => {
    const { deps } = makeDeps(new Set(["week-03/01.py", "week-03/weather-app/main.py", "week-03/weather-app/data/city.txt"]));
    const r1 = await pullAssignments(deps);
    expect(r1.pulled).toBe(0);
    expect(r1.updateNotices).toEqual([]);
    // 服务端改题 → versionHash 变了，本地未改 → 仅提示
    published[0].exercises[1].versionHash = "v2-changed";
    const r2 = await pullAssignments(deps);
    expect(r2.pulled).toBe(0);
    expect(r2.updateNotices.some((n) => n.includes("weather-app") && n.includes("题目已更新"))).toBe(true);
  });
  it("部分文件缺失（学生删了 data/）：仅补缺失文件", async () => {
    const { deps, written } = makeDeps(new Set(["week-03/01.py", "week-03/weather-app/main.py"]));
    const r = await pullAssignments(deps);
    expect(r.pulled).toBe(1);
    expect(written).toEqual(["week-03/weather-app/data/city.txt"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（项目题按单文件拉取，content JSON 未解析）

- [ ] **Step 3: 实现**

`src/pull/pullCommand.ts`：

1) `PublishedAssignmentLite` exercises 类型改：

```ts
  exercises: { id: string; filename: string; versionHash: string; kind?: "file" | "project"; dir?: string; entry?: string }[];
```

2) 主循环（L24-40）替换为：

```ts
  for (const a of list) {
    const weekDir = `week-${String(a.week).padStart(2, "0")}`;
    for (const ex of a.exercises) {
      const isProject = ex.kind === "project" && ex.dir;
      const rel = isProject ? `${weekDir}/${ex.dir}` : `${weekDir}/${ex.filename}`;
      const contentRes = await doFetch(`${deps.teacherUrl()}/api/exercises/${ex.id}/content`);
      if (!contentRes.ok) continue;
      const body = await contentRes.json() as
        | { kind: "file"; filename: string; content: string }
        | { kind: "project"; filename: string; dir: string; entry: string; files: { path: string; content: string }[] };

      if (body.kind === "project") {
        let wrote = 0;
        for (const f of body.files) {
          const fileRel = `${rel}/${f.path}`;
          if (await deps.fileExists(fileRel)) continue;
          await deps.writeFile(fileRel, f.content);
          wrote++;
        }
        const anchor = `${rel}/${body.entry}`;
        if (wrote === 0 && await deps.fileExists(anchor)) {
          if (versions[ex.id] && versions[ex.id] !== ex.versionHash) {
            result.updateNotices.push(`${rel} 题目已更新，本地文件未改动，请注意最新要求`);   // A30 仅通知
          }
        }
        result.pulled += wrote;
      } else {
        const fileRel = `${weekDir}/${ex.filename}`;
        if (await deps.fileExists(fileRel)) {
          if (versions[ex.id] && versions[ex.id] !== ex.versionHash) {
            result.updateNotices.push(`${fileRel} 题目已更新，本地文件未改动，请注意最新要求`);
          }
          versions[ex.id] = ex.versionHash;
          continue;
        }
        await deps.writeFile(fileRel, body.content);
        result.pulled++;
      }
      versions[ex.id] = ex.versionHash;
    }
  }
```

3) `makeRunPull` 的通知文案不变（已按文件数表述）。

- [ ] **Step 4: 跑测试通过**

Run: `npm test`
Expected: PASS（既有 pull 旧测试若直接给 text 响应，改为 JSON body 后修正）

- [ ] **Step 5: Commit**（扩展仓）

```bash
git add src/pull/pullCommand.ts src/test/pullProject.test.ts
git commit -m "feat: 拉取多文件——content JSON 化、项目逐文件写入/跳过/更新提示"
```

---

### Task 11: 扩展恢复多文件

**Files:**
- Modify: `d:\ruan\vscode-pylearner\src\commands\restoreSubmissions.ts`
- Test: `d:\ruan\vscode-pylearner\src\test\restoreProject.test.ts`（新建）

**Interfaces:**
- Consumes: 服务端 `GET /api/submissions/student/:id` 行含 `files?: SubmissionFile[] | null`（Task 1 行映射）；published exercises 含 `kind/dir`
- Produces: 项目提交按 `files` 逐文件写回 `week-XX/<dir>/<path>`；identical/确认弹窗均按文件粒度

- [ ] **Step 1: 写失败测试**

```ts
// src/test/restoreProject.test.ts
import { describe, it, expect } from "vitest";
import { restoreSubmissions, type RestoreDeps } from "../commands/restoreSubmissions";

const published = [{
  id: "a1", week: 3,
  exercises: [
    { id: "ef", filename: "01.py", kind: "file" as const },
    { id: "ep", filename: "weather-app", kind: "project" as const, dir: "weather-app" },
  ],
}];
const submissions = [
  { exerciseId: "ep", code: "# m", submittedAt: 200,
    files: [{ path: "main.py", content: "# m" }, { path: "utils.py", content: "# u" }] },
  { exerciseId: "ef", code: "# s", submittedAt: 100, files: null },
];

function makeDeps(local: Record<string, string | null>) {
  const written: { rel: string; content: string }[] = [];
  const deps: RestoreDeps = {
    teacherUrl: () => "http://t",
    getStudentId: () => "2025001",
    fetchImpl: (async (url: string) => {
      if (url.endsWith("/api/assignments/published")) return new Response(JSON.stringify(published), { status: 200 });
      if (url.includes("/api/submissions/student/")) return new Response(JSON.stringify(submissions), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch,
    readFile: async (rel: string) => local[rel] ?? null,
    writeFile: async (rel: string, content: string) => { written.push({ rel, content }); },
  };
  return { deps, written };
}

describe("restoreSubmissions 项目化", () => {
  it("项目行按 files 逐文件恢复；单文件行为不变", async () => {
    const { deps, written } = makeDeps({});
    const r = await restoreSubmissions(deps);
    expect(r.restored.sort()).toEqual([
      "week-03/01.py", "week-03/weather-app/main.py", "week-03/weather-app/utils.py",
    ].sort());
    void written;
  });
  it("本地一致的文件跳过（identical 按文件粒度）", async () => {
    const { deps } = makeDeps({ "week-03/weather-app/main.py": "# m" });
    const r = await restoreSubmissions(deps);
    expect(r.restored.includes("week-03/weather-app/main.py")).toBe(false);
    expect(r.restored.includes("week-03/weather-app/utils.py")).toBe(true);
    expect(r.identical).toEqual(["week-03/weather-app/main.py"]);
  });
  it("旧服务端行为兼容：行无 files 字段按单文件恢复", async () => {
    const { deps } = makeDeps({});
    const r = await restoreSubmissions(deps);
    expect(r.restored).toContain("week-03/01.py");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/commands/restoreSubmissions.ts`：

1) `SubmissionRow` 加 `files?: { path: string; content: string }[] | null;`；`PublishedLite` exercises 加 `kind?: "file" | "project"; dir?: string;`。

2) `restoreSubmissions` 主循环（L64-72）替换为：

```ts
  const result: RestoreResult = { restored: [], identical: [], unmapped: [] };
  const plan: { rel: string; code: string }[] = [];
  for (const [exerciseId, sub] of latestByExercise(rows)) {
    const rel = pathOf.get(exerciseId);
    if (!rel) { result.unmapped.push(exerciseId); continue; }
    // V2.0：项目提交按 files 逐文件恢复；旧行（无 files）按单文件
    const targets = sub.files && sub.files.length > 0
      ? sub.files.map((f) => ({ rel: `${rel}/${f.path}`, code: f.content }))
      : [{ rel, code: sub.code }];
    for (const t of targets) {
      const local = await deps.readFile(t.rel);
      if (local === t.code) { result.identical.push(t.rel); continue; }
      plan.push(t);
    }
  }
```

（`pathOf` 构造处：项目行 `pathOf.set(ex.id, \`week-XX/${ex.dir}\`)`——在 L51-56 的映射循环中按 `ex.kind === "project" && ex.dir` 分支，项目用 dir 作基路径。）

3) 其余（confirm/write）不变——plan 本就按文件粒度。

- [ ] **Step 4: 跑测试通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**（扩展仓）

```bash
git add src/commands/restoreSubmissions.ts src/test/restoreProject.test.ts
git commit -m "feat: 恢复我的提交——项目 files 逐文件写回（兼容无 files 旧行）"
```

---

### Task 12: 扩展 F5 评审链 + 自动提交退役

**Files:**
- Create: `d:\ruan\vscode-pylearner\src\submission\reviewRequester.ts`
- Modify: `d:\ruan\vscode-pylearner\src\extension.ts:224-238`
- Modify: `d:\ruan\vscode-pylearner\src\constants.ts:31`
- Modify: `d:\ruan\vscode-pylearner\package.json`（删 autoSubmit 配置）
- Test: `d:\ruan\vscode-pylearner\src\test\reviewRequester.test.ts`（新建）

**Interfaces:**
- Consumes: Task 9（`buildProjectSnapshot`/ProjectSnapshot 形状）、服务端 Task 6（`POST /api/reviews/request` 契约）、现有 `TraceEvent`（src/events/types）
- Produces:
  - `requestReview(deps: ReviewerDeps, args: { filePath: string; content: string }): Promise<"reviewed" | "not-exercise" | "identity-missing" | "error">`
  - `ReviewerDeps = { teacherUrl; getIdentity; buildProjectSnapshot; fetchImpl?; notify: (message: string, isWarning: boolean) => void }`
  - `makeRunSuccessReviewer(deps: ReviewerDeps, vscode, readFile): (event: TraceEvent) => Promise<void>`（替代已删的 makeHandleRunSuccess：定位逻辑同源——payload.file 优先，活动编辑器兜底）
  - 回执文案：pass `✅ 评审通过：<reason>`；fail `❌ 评审未通过：<reason>`（warning 级）；unreviewed `⚪ 本次未能完成评审，稍后再试`

- [ ] **Step 1: 写失败测试**

```ts
// src/test/reviewRequester.test.ts
import { describe, it, expect } from "vitest";
import { requestReview, type ReviewerDeps } from "../submission/reviewRequester";

const ID = "01234567-89ab-cdef-0123-456789abcdef";
function makeDeps(status: "pass" | "fail" | "unreviewed", reason = "边界未处理") {
  const notices: [string, boolean][] = [];
  const posts: unknown[] = [];
  const deps: ReviewerDeps = {
    teacherUrl: () => "http://t",
    getIdentity: () => ({ studentId: "2025001", studentName: "张三" }),
    buildProjectSnapshot: async () => null,
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ review: { status, reason, reviewedAt: 1, model: "m", source: "llm" }, submissionId: "s1" }), { status: 200 });
    }) as unknown as typeof fetch,
    notify: (m, w) => notices.push([m, w]),
  };
  return { deps, notices, posts };
}

describe("requestReview（F5 评审）", () => {
  it("单文件：payload 无 files，回执按三态", async () => {
    const { deps, notices } = makeDeps("pass", "通过");
    const r = await requestReview(deps, { filePath: "x", content: `# exercise-id: ${ID}\nprint(1)` });
    expect(r).toBe("reviewed");
    expect(notices[0][0]).toContain("评审通过");
  });
  it("fail → warning 回执带 reason", async () => {
    const { deps, notices } = makeDeps("fail");
    await requestReview(deps, { filePath: "x", content: `# exercise-id: ${ID}\nprint(1)` });
    expect(notices[0][0]).toContain("评审未通过");
    expect(notices[0][0]).toContain("边界未处理");
    expect(notices[0][1]).toBe(true);
  });
  it("unreviewed → 中性提示", async () => {
    const { deps, notices } = makeDeps("unreviewed");
    await requestReview(deps, { filePath: "x", content: `# exercise-id: ${ID}\nprint(1)` });
    expect(notices[0][0]).toContain("未能完成评审");
    expect(notices[0][1]).toBe(false);
  });
  it("项目：buildProjectSnapshot 命中 → payload 携带 files + code=入口", async () => {
    const { deps, posts } = makeDeps("pass");
    deps.buildProjectSnapshot = async () => ({ exerciseId: ID, files: [{ path: "main.py", content: "M" }], entryContent: "M" });
    await requestReview(deps, { filePath: "app/utils.py", content: "# u" });
    const body = posts[0] as { files?: unknown[]; code?: string };
    expect(body.files!.length).toBe(1);
    expect(body.code).toBe("M");
  });
  it("非练习文件 → not-exercise 静默；无身份 → identity-missing", async () => {
    const d1 = makeDeps("pass");
    expect(await requestReview(d1.deps, { filePath: "x", content: "print(1)" })).toBe("not-exercise");
    const d2 = makeDeps("pass");
    d2.deps.getIdentity = () => ({ studentId: null, studentName: null });
    expect(await requestReview(d2.deps, { filePath: "x", content: `# exercise-id: ${ID}\n` })).toBe("identity-missing");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/submission/reviewRequester.ts
import type { TraceEvent } from "../events/types";
import { scanExerciseId } from "./exerciseHeader";
import type { SubmissionFile } from "./projectFiles";

export interface ReviewerDeps {
  teacherUrl: () => string;
  getIdentity: () => { studentId: string | null; studentName: string | null };
  buildProjectSnapshot: (filePath: string, content: string) => Promise<{ exerciseId: string; files: SubmissionFile[]; entryContent: string } | null>;
  fetchImpl?: typeof fetch;
  notify: (message: string, isWarning: boolean) => void;
}

export type ReviewOutcome = "reviewed" | "not-exercise" | "identity-missing" | "error";

interface ReviewResponse {
  review: { status: "pass" | "fail" | "unreviewed"; reason: string };
  submissionId: string | null;
}

/** F5 运行成功 → 评审工作区快照（spec §5.3）；与提交互不触发 */
export async function requestReview(deps: ReviewerDeps, args: { filePath: string; content: string }): Promise<ReviewOutcome> {
  const snapshot = await deps.buildProjectSnapshot(args.filePath, args.content);
  const exerciseId = snapshot?.exerciseId ?? scanExerciseId(args.content);
  if (!exerciseId) return "not-exercise";
  const identity = deps.getIdentity();
  if (!identity.studentId || !identity.studentName) return "identity-missing";   // F5 静默，不弹身份页
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.teacherUrl()}/api/reviews/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId: identity.studentId, studentName: identity.studentName, exerciseId,
        code: snapshot ? snapshot.entryContent : args.content,
        ...(snapshot ? { files: snapshot.files } : {}),
      }),
    });
    if (!res.ok) return "error";
    const body = (await res.json()) as ReviewResponse;
    const { status, reason } = body.review;
    if (status === "pass") deps.notify(`✅ 评审通过${reason ? `：${reason}` : ""}`, false);
    else if (status === "fail") deps.notify(`❌ 评审未通过：${reason}`, true);
    else deps.notify("⚪ 本次未能完成评审，稍后再试", false);
    return "reviewed";
  } catch {
    return "error";
  }
}

/** run 成功事件入口（替代原自动提交链）：定位逻辑同源——payload.file 优先，活动编辑器兜底 */
export function makeRunSuccessReviewer(
  deps: ReviewerDeps,
  vscode: typeof import("vscode"),
  readFile: (fsPath: string) => Promise<string | null>,
): (event: TraceEvent) => Promise<void> {
  return async (event) => {
    try {
      const payload = event.payload as { file?: string };
      let filePath: string | null = payload.file ?? null;
      if (!filePath) {
        const active = vscode.window.activeTextEditor?.document;
        if (active && active.uri.fsPath.endsWith(".py")) filePath = active.uri.fsPath;
      }
      if (!filePath) return;
      const content = await readFile(filePath);
      if (content === null) return;
      await requestReview(deps, { filePath, content });
    } catch (err) {
      console.warn("[ReviewRequester] run review failed:", err instanceof Error ? err.message : String(err));
    }
  };
}
```

- [ ] **Step 4: 装配（extension.ts + 配置退役）**

`src/extension.ts` L224-238 区替换为：

```ts
  const submissionDeps: SubmissionDeps = {
    teacherUrl: identityDeps.teacherUrl,
    getIdentity,
    onIdentityMissing: () =>
      maybeOpenIdentityPage(identityDeps, context, loadStudentIdentity(context.globalState)),
    globalState: context.globalState,
    saveIfDirty,
  };
  // V2.0：F5 评审链（替代自动提交；提交按钮纯归档）
  const projectFs = {
    readDirectory: async (fsPath: string) => {
      try {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(fsPath));
        return entries.map(([name, type]) => [name, { isDirectory: type === vscode.FileType.Directory }] as [string, { isDirectory: boolean }]);
      } catch {
        return null;
      }
    },
    readFile: async (fsPath: string) => {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath)));
      } catch {
        return null;
      }
    },
  };
  const snapshotDeps = {
    locator: {
      rootFsPath: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
      join: (d: string, r: string) => vscode.Uri.joinPath(vscode.Uri.file(d), r).fsPath,
      readFile,
    },
    projectFs,
  };
  const buildProjectSnapshot = (filePath: string, content: string) =>
    buildProjectSnapshotImpl(snapshotDeps, filePath, content);
  (submissionDeps as SubmissionDeps & { buildProjectSnapshot?: unknown }).buildProjectSnapshot = buildProjectSnapshot;
  const reviewer = makeRunSuccessReviewer(
    { teacherUrl: identityDeps.teacherUrl, getIdentity, buildProjectSnapshot,
      notify: (m, w) => void (w ? vscode.window.showWarningMessage(m) : vscode.window.showInformationMessage(m)) },
    vscode, readFile,
  );
  l1Writer.setSubmissionHandler((ev) => {
    const cfg = vscode.workspace.getConfiguration("pylearner");
    if (!cfg.get<boolean>(CONFIG_KEYS.submissionEnabled, true)) return;
    void reviewer(ev);   // 内部整体 try/catch
  });
```

import 区加：`import { makeRunSuccessReviewer } from "./submission/reviewRequester"; import { buildProjectSnapshot as buildProjectSnapshotImpl } from "./submission/projectSnapshot";`。

注意：`locator.rootFsPath` 的类型是 `string`（Task 8 LocatorDeps），这里给了函数——把 LocatorDeps.rootFsPath 保持 `string`，装配处包一层：`locator: { rootFsPath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", ... }`（激活时求值一次即可；工作区切换需重载窗口，课堂场景可接受）。

`src/constants.ts` L31 删除 `submissionAutoSubmit: "pylearner.submission.autoSubmit",` 一行；`package.json` 删除 `pylearner.submission.autoSubmit` 配置块（L171-174）。

- [ ] **Step 5: 跑测试通过**

Run: `npm test` 然后 `npm run compile`
Expected: PASS + 编译通过

- [ ] **Step 6: Commit**（扩展仓）

```bash
git add src/submission/reviewRequester.ts src/extension.ts src/constants.ts package.json src/test/reviewRequester.test.ts
git commit -m "feat: F5 运行成功触发评审（三态回执）；自动提交链与 autoSubmit 配置退役"
```

---

### Task 13: 扩展会话身份确认门禁 + 状态栏警告色

**Files:**
- Create: `d:\ruan\vscode-pylearner\src\identity\sessionConfirm.ts`
- Modify: `d:\ruan\vscode-pylearner\src\extension.ts`（状态栏 + 三命令包门禁）
- Test: `d:\ruan\vscode-pylearner\src\test\sessionConfirm.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `getIdentity` 闭包、`openIdentityPage`/`maybeOpenIdentityPage`、statusBar
- Produces:
  - `createSessionConfirmGate(deps: GateDeps): { ensureConfirmed(): Promise<boolean>; isConfirmed(): boolean; reset(): void }`
  - `GateDeps = { vscode: typeof import("vscode"); getIdentity: () => { studentId: string | null; studentName: string | null }; onSwitchIdentity: () => void; onConfirmed: () => void }`
  - 语义：每窗口会话首次调用弹模态「本机记录的课堂身份是：学号 · 姓名，这是你本人吗？」[是我本人 / 切换身份]；Esc/关闭 = 未确认；确认后本会话不再弹；`reset()` 供身份变更后强制重确认

- [ ] **Step 1: 写失败测试**

```ts
// src/test/sessionConfirm.test.ts
import { describe, it, expect } from "vitest";
import { createSessionConfirmGate, type GateDeps } from "../identity/sessionConfirm";

function makeDeps(answer: string | undefined) {
  const calls: { switch: number; confirmed: number; prompts: number } = { switch: 0, confirmed: 0, prompts: 0 };
  const deps: GateDeps = {
    vscode: {
      window: { showInformationMessage: async () => { calls.prompts++; return answer; } },
    },
  } as unknown as GateDeps;
  deps.getIdentity = () => ({ studentId: "2025001", studentName: "张三" });
  deps.onSwitchIdentity = () => { calls.switch++; };
  deps.onConfirmed = () => { calls.confirmed++; };
  return { deps, calls, gate: createSessionConfirmGate(deps) };
}

describe("会话身份确认门禁", () => {
  it("首次确认弹窗 → 是我本人 → 通过且不再弹", async () => {
    const { gate, calls } = makeDeps("是我本人");
    expect(await gate.ensureConfirmed()).toBe(true);
    expect(await gate.ensureConfirmed()).toBe(true);
    expect(calls.prompts).toBe(1);
    expect(calls.confirmed).toBe(1);
  });
  it("Esc（undefined）→ 拦截；下次仍会弹", async () => {
    const { gate, calls } = makeDeps(undefined);
    expect(await gate.ensureConfirmed()).toBe(false);
    expect(calls.prompts).toBe(1);
  });
  it("切换身份 → 拦截并打开身份页", async () => {
    const { gate, calls } = makeDeps("切换身份");
    expect(await gate.ensureConfirmed()).toBe(false);
    expect(calls.switch).toBe(1);
  });
  it("无身份 → 直接引导身份页", async () => {
    const { deps, calls } = makeDeps("是我本人");
    deps.getIdentity = () => ({ studentId: null, studentName: null });
    const gate = createSessionConfirmGate(deps);
    expect(await gate.ensureConfirmed()).toBe(false);
    expect(calls.switch).toBe(1);
    expect(calls.prompts).toBe(0);
  });
  it("reset 后重新弹窗（身份变更场景）", async () => {
    const { gate, calls } = makeDeps("是我本人");
    await gate.ensureConfirmed();
    gate.reset();
    expect(await gate.ensureConfirmed()).toBe(true);
    expect(calls.prompts).toBe(2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/identity/sessionConfirm.ts
export interface GateDeps {
  vscode: typeof import("vscode");
  getIdentity: () => { studentId: string | null; studentName: string | null };
  onSwitchIdentity: () => void;   // 打开身份页
  onConfirmed: () => void;        // 状态栏恢复正常
}

/** 共享电脑防误用（spec §5.5/§5.6）：每窗口会话确认一次，未确认拦截关键动作 */
export function createSessionConfirmGate(deps: GateDeps) {
  let confirmed = false;
  return {
    isConfirmed: () => confirmed,
    reset() { confirmed = false; },
    async ensureConfirmed(): Promise<boolean> {
      const id = deps.getIdentity();
      if (!id.studentId || !id.studentName) {
        deps.onSwitchIdentity();
        return false;
      }
      if (confirmed) return true;
      const pick = await deps.vscode.window.showInformationMessage(
        `本机记录的课堂身份是：${id.studentId} · ${id.studentName}\n这是你本人吗？`,
        { modal: true },
        "是我本人",
        "切换身份",
      );
      if (pick === "是我本人") {
        confirmed = true;
        deps.onConfirmed();
        return true;
      }
      if (pick === "切换身份") deps.onSwitchIdentity();
      return false;   // Esc / 关闭同样视为未确认
    },
  };
}
```

- [ ] **Step 4: 装配（extension.ts）**

1) statusBar 区（L182-189）`updateStatusBar` 改：

```ts
  const updateStatusBar = () => {
    const id = loadStudentIdentity(context.globalState);
    statusBar.text = id.studentId
      ? (sessionGate?.isConfirmed()
          ? `$(account) ${id.studentId} ${id.studentName ?? ""}`.trim()
          : `$(warning) ${id.studentId} ${id.studentName ?? ""} ?`.trim())
      : "$(account) 设置学号";
    statusBar.tooltip = sessionGate?.isConfirmed()
      ? "课堂助手身份：点击设置学号/姓名"
      : "身份待确认：点击任意作业按钮时确认，或点击此处重新设置";
    statusBar.show();
  };
```

（`sessionGate` 声明提前到 updateStatusBar 之前：`let sessionGate: ReturnType<typeof createSessionConfirmGate> | undefined;`，紧随其后创建并赋值，再调用 `updateStatusBar()`。）

2) gate 创建（statusBar 定义之后）：

```ts
  sessionGate = createSessionConfirmGate({
    vscode,
    getIdentity,
    onSwitchIdentity: () => openIdentityPage(identityDeps, context),
    onConfirmed: () => updateStatusBar(),
  });
```

3) `identityDeps.onSaved`（L199）改为 `onSaved: () => { sessionGate?.reset(); updateStatusBar(); },`（身份换人后强制重确认）。

4) 三个作业命令包门禁——`registerCommand(CMD_IDS.submitExercise, ...)` / `pullAssignments` / `restoreSubmissions` 的回调体外层包：

```ts
    vscode.commands.registerCommand(CMD_IDS.pullAssignments, async () => {
      if (!sessionGate || !(await sessionGate.ensureConfirmed())) return;
      void runPull();
    })
```

提交/恢复同理：先 `await ensureConfirmed()` 再执行原命令体。

- [ ] **Step 5: 跑测试通过**

Run: `npm test` 然后 `npm run compile`
Expected: PASS

- [ ] **Step 6: Commit**（扩展仓）

```bash
git add src/identity/sessionConfirm.ts src/extension.ts src/test/sessionConfirm.test.ts
git commit -m "feat: 会话身份确认门禁——共享电脑防误用，未确认拦截三作业命令，状态栏警告色"
```

---

### Task 14: 扩展「运行和调试」三按钮面板 + 取消激活自动拉取

**Files:**
- Modify: `d:\ruan\vscode-pylearner\package.json`（views 加 debug 容器条目）
- Create: `d:\ruan\vscode-pylearner\src\views\assignmentPanel.ts`
- Modify: `d:\ruan\vscode-pylearner\src\constants.ts:15-18`
- Modify: `d:\ruan\vscode-pylearner\src\extension.ts:449`（删自动拉取）

**Interfaces:**
- Consumes: `CMD_IDS.pullAssignments / submitExercise / restoreSubmissions`（现有）
- Produces: 运行和调试视图内「课堂作业」树面板（三行：图标+文字，点击执行命令）

- [ ] **Step 1: package.json contributes 扩展**

`contributes.views` 改为（保留现有 pylearner-sidebar，新增 debug 容器条目）：

```json
    "views": {
      "pylearner-sidebar": [
        {
          "type": "webview",
          "id": "pylearner.chatView",
          "name": "Chat"
        }
      ],
      "debug": [
        {
          "type": "tree",
          "id": "pylearner.assignmentPanel",
          "name": "课堂作业"
        }
      ]
    },
```

（`"debug"` 是 VS Code 内置「运行和调试」视图容器 id；活动栏 `viewsContainers` 不动。）

- [ ] **Step 2: constants + 面板实现**

`src/constants.ts` 的 `VIEW_IDS` 加：

```ts
  assignmentPanel: "pylearner.assignmentPanel",
```

```ts
// src/views/assignmentPanel.ts
import * as vscode from "vscode";
import { CMD_IDS } from "../constants";

interface PanelItem {
  label: string;
  command: string;
  icon: vscode.ThemeIcon;
}

/** 「运行和调试」侧边栏的课堂作业面板（spec §5.5）：三行入口，点击执行既有命令 */
export function createAssignmentPanel(): vscode.TreeDataProvider<PanelItem> {
  const items: PanelItem[] = [
    { label: "拉取作业", command: CMD_IDS.pullAssignments, icon: new vscode.ThemeIcon("repo-pull") },
    { label: "提交作业", command: CMD_IDS.submitExercise, icon: new vscode.ThemeIcon("cloud-upload") },
    { label: "恢复我的提交", command: CMD_IDS.restoreSubmissions, icon: new vscode.ThemeIcon("history") },
  ];
  return {
    getChildren: () => items,
    getTreeItem: (item) => {
      const tree = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
      tree.command = { command: item.command, title: item.label };
      tree.iconPath = item.icon;
      return tree;
    },
  };
}
```

- [ ] **Step 3: 注册 + 删自动拉取（extension.ts）**

1) import 加 `import { createAssignmentPanel } from "./views/assignmentPanel";`。
2) 命令注册区加：

```ts
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(VIEW_IDS.assignmentPanel, createAssignmentPanel())
  );
```

3) L449 `void runPull(); // 激活自动拉取（A26，后台）` 整行删除，L424 注释尾部「+ 激活自动拉取（A26，异步不阻塞激活）」改为「（V2.0：自动拉取已取消，仅按钮触发）」。

- [ ] **Step 4: 编译 + 全量测试**

Run: `npm run compile` 然后 `npm test`
Expected: 编译通过、测试全绿（纯 UI 壳无新单测；面板行为在 Task 15 手工验证）

- [ ] **Step 5: Commit**（扩展仓）

```bash
git add package.json src/views/assignmentPanel.ts src/constants.ts src/extension.ts
git commit -m "feat: 运行和调试侧边栏「课堂作业」三按钮面板；取消激活自动拉取"
```

---

### Task 15: 演示环境端到端验证（手工清单）

**Files:**
- 无代码产出；验证 Task 1-14 的整体行为（spec §7 迁移步骤 + §6 演示环境实测）

**Interfaces:**
- Consumes: 全部前序任务；演示环境（dev server + 演示 git 仓库 `D:\demo\classroom-exercises.git` + 工作副本 `D:\demo\exercises-work` + GLM 评审）

- [ ] **Step 1: 服务端全量测试 + 启动**

Run: `pnpm --filter @classroom/server test`（确认 dev server 已停）；然后 `pnpm dev:server`
Expected: 测试全绿；服务启动无报错，**启动日志中不再出现补扫评审**（rescanPendingReviews 已移除）

- [ ] **Step 2: 教师侧造题**

在 `D:\demo\exercises-work` 新建 `week-5/weather-app/`：`exercise.json`（`{ "title": "天气查询", "entry": "main.py" }`）+ `main.py`（头部题面 + 代码区）+ `utils.py` + `data/city.txt`；git add/commit/push。
等待 60 秒同步（或 POST `/api/sync`），在仪表盘 `#/admin` 确认新 exercise 出现（kind=project，manifest 已被注入 exerciseId 并回推）。

- [ ] **Step 3: 学生端拉取**

F5 调试扩展（或重打包 vsix 安装）→ 打开学生工作区 → 运行和调试侧边栏出现「课堂作业」面板（三行）→ 点「拉取作业」→ 身份确认弹窗（首次）→ `week-05/weather-app/` 三文件落盘。
再点一次「拉取作业」→ 提示 0 个文件（全部跳过）。教师改题推送后再拉 → 出现「题目已更新」警告且**本地文件未被覆盖**。

- [ ] **Step 4: 提交归档（不评审）**

编辑 `main.py` → 点「提交作业」→ 提示「✅ 已归档」。验证：
- 服务端 `GET /api/submissions/student/<学号>` 该行 `files` 数组完整、`review` 为 null
- 学生分支 `git log`：`student-<学号>` 分支出现 `(project)` 提交，`week-05/weather-app/` 下文件完整
- 再点「提交作业」→ 「已归档过，未重复提交」

- [ ] **Step 5: F5 评审**

运行 `main.py`（正确版）→ 评审回执「✅ 评审通过」；改出逻辑错误（如死循环缺出口）→ 运行 → 回执「❌ 评审未通过：<reason>」；仪表盘：提交矩阵该格子变红 + **告警面板出现该学生 + 聚合面板出现 review_fail 条目（knowledge=LLM reason）**。运行报错（语法错）→ 仅监控页出现错误，**无评审回执**。

- [ ] **Step 6: 恢复 + 换机模拟**

删除本地 `week-05/weather-app/` → 点「恢复我的提交」→ 确认弹窗 → 三文件找回。
模拟换机：新建空目录作为工作区 → 拉取（新模板）→ 恢复（我的最新代码）→ 文件内容为最后提交版本。

- [ ] **Step 7: 共享电脑场景**

换身份（状态栏 → 身份页 → 另一学号）→ 状态栏变 `$(warning) 学号 姓名 ?` → 点「拉取作业」→ 再次弹确认。确认前所有作业按钮均被拦截。

- [ ] **Step 8: 单文件题回归**

对既有 week-3/week-4 单文件题走一遍拉取→提交→F5 评审→恢复，确认行为与升级前一致（payload 无 files、归档单文件、评审回执正常）。

- [ ] **Step 9: 记录验证结果**

在本计划文件对应勾选框打勾；发现的缺陷回补到对应 Task 修复后重跑该 Task 测试。

---

## Self-Review 记录

- **Spec 覆盖**：§3（Task 1-3）、§4.1（Task 5）、§4.2/§4.3（Task 6）、§4.4 content/恢复（Task 4 + Task 1 行映射 + Task 11）、§5.1-5.5（Task 7-14）、§6 测试（各 Task 单测 + Task 15 e2e）、§7 迁移（Task 15 顺序即迁移顺序，教师仓库零迁移由 Task 15 Step 2 验证）、§8 风险缓解（尺寸限制 Task 5、忽略清单 Task 2/7、缓存 Task 6 复用、确认弹窗 Task 13）。§4.4 published 改造在 Task 4；「`GET /api/assignments` 改造（git 元数据）」经 V2.0 通道不变收敛为 published 行扩展（remoteUrl/分支名等 git 元数据随 V1.x 方案废弃，不再需要）。
- **占位符扫描**：Task 4 Step 4 无 git 兜底分支的 walk 已注明实现写法；Task 7 Step 4 的对拍 hash 已给出实算命令；无 TBD/TODO。
- **类型一致性**：`canonicalFilesHash` 两仓签名一致（Task 2/Task 7）；`SubmissionFile` 形状两仓一致；`buildProjectSnapshot` 返回形状在 Task 9 定义、Task 12 ReviewerDeps 复用一致；`validateFiles` Task 5 导出、Task 6 导入；`getLatestSubmissionByExerciseStudent` Task 1 定义、Task 6 消费。
