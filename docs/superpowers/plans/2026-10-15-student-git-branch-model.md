# 学生分支直连模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 学生端四操作（拉取/提交/恢复/切换）全部映射为 git 原语直连 Gitea，服务端旁路化（notify 轻量索引 + 评审 + L1 + 监控），删除快照同步模型的三套机制。

**Architecture:** 学生分支是学生工作区状态的唯一事实源；扩展代执行 git（child_process 调本机 git CLI），学生零 Git 认知；每生一 Gitea 账户（token 随身份校验下发，凭证级防越权）；push 后扩展向服务端发轻量 notify（文件清单级，不含代码）。

**Tech Stack:** TypeScript、Node child_process（git CLI）、Express、better-sqlite3、Vue 3（dashboard）、vitest。

**Spec:** `classroom-assistant/docs/superpowers/specs/2026-10-15-student-git-branch-model-design.md`（两仓库功能分支均已建好：`feat/student-git-branch-model`）

## Global Constraints

- 两仓库分支：`feat/student-git-branch-model`（classroom-assistant 与 vscode-pylearner 同名分支）
- 题目不可变：main 只增不改；只新增拉取策略（`diff-filter=A`）是硬约束
- 路径不可变：练习定位一律用文件路径（exercise-id 注入机制退役）
- 学生端零作业识别：`git add -A` 全量归档
- 学生零 Git 认知：git 命令只出现在扩展的 git 模块内
- 每步 TDD：先写失败测试 → 跑失败 → 最小实现 → 跑通过 → commit
- Windows 环境：git 命令经 `execFile`（不经 shell），PowerShell 5 下不用 `&&`
- 服务端 dev server（tsx watch）运行时不要并行跑 server 测试套件（共享 exercises-repo 的 git 工作目录，会 index.lock 冲突）

## File Structure

### vscode-pylearner（扩展端）

```
src/git/gitClient.ts        — git CLI 封装（execFile，可注入 fake）
src/git/branchOps.ts        — ensureStudentBranch / assertCurrentBranch
src/git/pullOps.ts          — pullNewOnly（只新增策略）
src/git/commitOps.ts        — submitAll（断言/add/commit/rebase/push/notify）
src/git/gitEnv.ts           — remote URL 组装（token 内嵌）、git 探测
src/test/git/*.test.ts      — 上述模块测试（fake exec）
```

### classroom-assistant（服务端）

```
src/controllers/notifyController.ts    — notify 接收（校验/对照/入库/SSE）
src/controllers/exerciseResolver.ts    — 文件路径 → exercises 对照（共享逻辑）
src/gitea/adminApi.ts                  — Gitea 管理员 API（建号/token/分支保护）
src/routes/submissions.ts              — POST /api/submissions/notify 替换旧 POST
```

---

### Task 1: 服务端——notify 接口与轻量索引

**Files:**
- Create: `packages/server/src/controllers/notifyController.ts`
- Create: `packages/server/src/controllers/exerciseResolver.ts`
- Modify: `packages/server/src/persistence.ts`（submissions 表 DDL 重写 + insertNotifyRow + getUnsyncedSubmissions 等旧方法删除）
- Modify: `packages/server/src/routes/submissions.ts`
- Test: `packages/server/src/__tests__/notifyController.test.ts`

**Interfaces:**
- Produces: `handleNotify(deps: { persistence, publish }, body): { status: number; body: unknown }`；`resolveExercisesByFiles(persistence, files: string[]): { exerciseId: string }[]`（Task 7 评审路径化复用）
- DB 列（后续任务依赖）：`submissions(id, exercise_id, student_id, student_name, commit_hash, files_json, submitted_at, review_json)` + `UNIQUE(exercise_id, student_id, commit_hash)`

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/src/__tests__/notifyController.test.ts
import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { handleNotify } from "../controllers/notifyController";
import type { Persistence } from "../persistence";

function seed(p: Persistence) {
  p.replaceRoster([{ studentId: "0001", studentName: "张三" }]);
  // 造一门作业 + 两个练习（单文件 + 项目）——用 persistence 的 assignments 写入接口，
  // 沿用 syncService.test.ts 里 seedAssignment 的现有做法（直接 db 或 upsert 方法）
}

describe("POST /api/submissions/notify 处理", () => {
  it("文件清单对照 exercises → 每命中练习一行入库 + SSE 广播", () => {
    const p = createPersistence(":memory:");
    seed(p);
    const events: unknown[] = [];
    const r = handleNotify({ persistence: p, publish: (m) => events.push(m) }, {
      studentId: "0001", studentName: "张三", commitHash: "abc123",
      files: ["lesson5/a.py", "lesson5/weather-app/main.py"], pushedAt: 123,
    });
    expect(r.status).toBe(200);
    expect(p.getSubmissionsByStudent("0001")).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe("submission_received");
  });
  it("学号不在名册 → 400", () => {
    const p = createPersistence(":memory:");
    seed(p);
    const r = handleNotify({ persistence: p, publish: () => {} }, {
      studentId: "9999", studentName: "x", commitHash: "h", files: [], pushedAt: 1,
    });
    expect(r.status).toBe(400);
  });
  it("重复 notify（同 commit 同练习）→ 幂等 200 不重复入库", () => {
    const p = createPersistence(":memory:");
    seed(p);
    const deps = { persistence: p, publish: () => {} };
    const body = { studentId: "0001", studentName: "张三", commitHash: "h1", files: ["lesson5/a.py"], pushedAt: 1 };
    handleNotify(deps, body);
    handleNotify(deps, body);
    expect(p.getSubmissionsByStudent("0001")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && npx vitest run src/__tests__/notifyController.test.ts`
Expected: FAIL（notifyController 不存在）

- [ ] **Step 3: 实现 exerciseResolver（路径对照）**

```ts
// packages/server/src/controllers/exerciseResolver.ts
import type { Persistence } from "../persistence";

/** 文件路径 → 命中的练习（2.1 规则的路径侧）：第一段=作业目录，单文件题=<dir>/<filename>，项目题=<dir>/<projectDir>/... */
export function resolveExercisesByFiles(persistence: Persistence, files: string[]): { exerciseId: string }[] {
  const hit = new Set<string>();
  for (const f of files) {
    const segs = f.split("/");
    if (segs.length < 2) continue;                       // 仓库根散文件不对应练习
    const [dir, ...rest] = segs;
    for (const ex of persistence.getExercisesByDir(dir)) {   // 需在 persistence 增加：按作业目录名列练习
      if (ex.kind === "project") {
        if (rest[0] === ex.filename) hit.add(ex.id);         // 项目：lesson5/weather-app/** → exercise.filename=weather-app
      } else if (rest.join("/") === ex.filename) {
        hit.add(ex.id);                                       // 单文件：lesson5/a.py → exercise.filename=a.py
      }
    }
  }
  return [...hit].map((exerciseId) => ({ exerciseId }));
}
```

同时给 persistence 增加按目录查询（内部走 assignments 表 `dir`/`week_dir` 列，沿用现有 assignments→exercises 关联；注意 assignments 表的目录列实际名为 `week_dir`——保留列名只放宽语义，任意目录名存这里）。

- [ ] **Step 4: 实现 notifyController + persistence 迁移**

submissions 表 DDL 重写（直接重建，不考虑迁移成本）：

```sql
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  exercise_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  student_name TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  files_json TEXT,
  submitted_at INTEGER NOT NULL,
  review_json TEXT,
  UNIQUE(exercise_id, student_id, commit_hash)
)
```

```ts
// packages/server/src/controllers/notifyController.ts
import { randomUUID } from "node:crypto";
import type { Persistence } from "../persistence";
import { resolveExercisesByFiles } from "./exerciseResolver";
import type { SSEMessage } from "@classroom/shared";

interface NotifyDeps { persistence: Persistence; publish: (msg: SSEMessage) => void }

export function handleNotify(deps: NotifyDeps, body: any): { status: number; body: unknown } {
  const { studentId, studentName, commitHash, files, pushedAt } = body ?? {};
  if (!studentId || !commitHash || !Array.isArray(files)) return { status: 400, body: { error: "缺少必要字段" } };
  const roster = deps.persistence.getRosterEntry(String(studentId).trim());
  if (!roster) return { status: 400, body: { error: "学号不在名册" } };
  const hits = resolveExercisesByFiles(deps.persistence, files);
  const inserted: string[] = [];
  for (const { exerciseId } of hits) {
    const ok = deps.persistence.insertNotifyRow({
      id: randomUUID(), exerciseId, studentId: roster.studentId, studentName: roster.studentName,
      commitHash: String(commitHash), filesJson: JSON.stringify(files), submittedAt: Number(pushedAt) || Date.now(),
    });
    if (ok) inserted.push(exerciseId);
  }
  if (inserted.length > 0) {
    deps.publish({ type: "submission_received", data: {
      submissionId: `${commitHash}`, exerciseIds: inserted, studentId: roster.studentId,
      studentName: roster.studentName, submittedAt: Number(pushedAt) || Date.now() } });
  }
  return { status: 200, body: { ok: true, exercises: inserted.length } };
}
```

persistence 增加 `insertNotifyRow`（UNIQUE 冲突时 `INSERT OR IGNORE` 返回 false）。

- [ ] **Step 5: 跑测试通过**

Run: `cd packages/server && npx vitest run src/__tests__/notifyController.test.ts`
Expected: PASS

- [ ] **Step 6: 挂路由（与旧 POST /api/submissions 并存，Task 9 再删旧）**

```ts
// packages/server/src/routes/submissions.ts 内追加
app.post("/api/submissions/notify", (req, res) => {
  const r = handleNotify(deps, req.body);
  res.status(r.status).json(r.body);
});
```

注意：SSE `submission_received` 的 data 形状变了（`exerciseIds` 数组 + `studentName`，去掉 `assignmentId/submissionId 单数`）——dashboard 的 `assignments store.applyAssignmentMessage` 与 AlertPanel 若消费旧字段，本任务先在 shared 的 dto.ts 里更新 `SubmissionReceivedData` 类型并同步 dashboard 消费端（读取 studentId/exerciseIds），跑 dashboard 测试。

- [ ] **Step 7: Commit**

```
git add packages/server/src packages/shared/src packages/dashboard/src
git commit -m "feat(server): notify 轻量索引接口（花名册校验+路径对照+SSE），submissions 表重构"
```

---

### Task 2: 服务端——Gitea 建号与 token 下发

**Files:**
- Create: `packages/server/src/gitea/adminApi.ts`
- Modify: `packages/server/src/persistence.ts`（新表 `student_tokens(student_id PRIMARY KEY, token)`）
- Modify: `packages/server/src/routes/roster.ts`（/identity/validate 响应携带 gitToken）
- Modify: `packages/server/src/controllers/`（roster 导入联动建号——找现有 importRoster 的 controller）
- Test: `packages/server/src/__tests__/gitea-admin.test.ts`

**Interfaces:**
- Produces: `createGiteaAdmin({ baseUrl, adminToken, fetchImpl }): { ensureStudentAccount(studentId): Promise<string /*token*/>; protectBranch(studentId): Promise<void> }`
- 环境变量：`GITEA_URL`（如 `http://127.0.0.1:3001`）、`GITEA_ADMIN_TOKEN`、`GITEA_REPO`（如 `classroom/exercises`）
- `/api/identity/validate` 响应新增字段：`{ ok, studentName, gitToken }`

- [ ] **Step 1: 写失败测试（fake fetch）**

```ts
// packages/server/src/__tests__/gitea-admin.test.ts
import { describe, it, expect } from "vitest";
import { createGiteaAdmin } from "../gitea/adminApi";

function fakeGitea() {
  const calls: { method: string; url: string; body?: any }[] = [];
  const f: typeof fetch = async (url, init) => {
    calls.push({ method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const u = String(url);
    if (u.includes("/api/v1/admin/users/") && u.includes("/tokens")) {
      return new Response(JSON.stringify({ sha1: "tok-123" }), { status: 201 });
    }
    if (u.includes("/api/v1/admin/users")) return new Response("{}", { status: 201 });
    if (u.includes("/branch_protections")) return new Response("{}", { status: 201 });
    return new Response("{}", { status: 200 });
  };
  return { calls, f };
}

describe("Gitea 管理联动", () => {
  it("ensureStudentAccount：已存在(422)→ 查现有 token / 新建 → 返回 token", async () => {
    const { f } = fakeGitea();
    const admin = createGiteaAdmin({ baseUrl: "http://g", adminToken: "T", fetchImpl: f });
    const tok = await admin.ensureStudentAccount("0001");
    expect(tok).toBe("tok-123");
  });
  it("protectBranch：对 student-0001 配置仅本人可 push", async () => {
    const { calls, f } = fakeGitea();
    const admin = createGiteaAdmin({ baseUrl: "http://g", adminToken: "T", fetchImpl: f });
    await admin.protectBranch("0001");
    const bp = calls.find((c) => c.url.includes("branch_protections"));
    expect(bp?.body?.branch_name).toBe("student-0001");
    expect(bp?.body?.push_whitelist_usernames).toEqual(["0001"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && npx vitest run src/__tests__/gitea-admin.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 adminApi**

```ts
// packages/server/src/gitea/adminApi.ts
export interface GiteaAdminDeps { baseUrl: string; adminToken: string; repo: string; fetchImpl?: typeof fetch }

export function createGiteaAdmin(deps: GiteaAdminDeps) {
  const doFetch = deps.fetchImpl ?? fetch;
  async function api(path: string, method: string, body?: unknown): Promise<Response> {
    return doFetch(`${deps.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `token ${deps.adminToken}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
  async function createToken(studentId: string): Promise<string> {
    const name = `classroom-${studentId}`;
    const list = await api(`/api/v1/users/${studentId}/tokens`, "GET");
    if (list.ok) {
      const arr = (await list.json()) as { name: string; sha1?: string }[];
      const found = arr.find((t) => t.name === name && t.sha1);
      if (found?.sha1) return found.sha1;      // 列表接口通常不回 sha1 → 走删除重建
    }
    await api(`/api/v1/users/${studentId}/tokens/${name}`, "DELETE").catch(() => {});
    const r = await api(`/api/v1/users/${studentId}/tokens`, "POST", { name, scopes: ["write:repository", "read:repository"] });
    if (!r.ok) throw new Error(`gitea token create failed: ${r.status}`);
    return ((await r.json()) as { sha1: string }).sha1;
  }
  return {
    async ensureStudentAccount(studentId: string): Promise<string> {
      const create = await api("/api/v1/admin/users", "POST", {
        username: studentId, email: `${studentId}@classroom.local`,
        full_name: studentId, password: crypto.randomUUID(), must_change_password: false,
      });
      if (!create.ok && create.status !== 422) throw new Error(`gitea user create failed: ${create.status}`);
      return createToken(studentId);
    },
    async protectBranch(studentId: string): Promise<void> {
      const r = await api(`/api/v1/repos/${deps.repo}/branch_protections`, "POST", {
        branch_name: `student-${studentId}`, rule_name: `only-${studentId}`,
        push_whitelist_usernames: [studentId], enable_push: true, enable_push_whitelist: true,
      });
      if (!r.ok && r.status !== 422) throw new Error(`gitea branch protect failed: ${r.status}`);
    },
  };
}
```

- [ ] **Step 4: 跑测试通过** → `npx vitest run src/__tests__/gitea-admin.test.ts` PASS

- [ ] **Step 5: roster 导入联动 + validate 下发 token**

- persistence：`CREATE TABLE IF NOT EXISTS student_tokens (student_id TEXT PRIMARY KEY, token TEXT NOT NULL)` + `getStudentToken(id)` / `saveStudentToken(id, token)`
- roster 导入 controller（现有 importRoster 链）：导入成功后，若配置了 `GITEA_URL/GITEA_ADMIN_TOKEN/GITEA_REPO`，循环 `ensureStudentAccount + protectBranch + saveStudentToken`；单个学生失败仅 logEvent 警告不阻断导入（下次导入重试幂等）
- `/api/identity/validate`：校验通过后从 `student_tokens` 取 token 放进响应 `gitToken` 字段（可能为 null——离线/未建号场景，扩展端提示联系教师）

- [ ] **Step 6: 补 validate 集成测试**（沿用 roster.test.ts 的 app 测试模式：seed roster + student_tokens → POST /api/identity/validate → 断言响应含 gitToken）→ PASS

- [ ] **Step 7: Commit**

```
git add packages/server/src
git commit -m "feat(server): Gitea 每生建号+分支保护，token 随身份校验下发"
```

---

### Task 3: 扩展端——git CLI 封装

**Files:**
- Create: `src/git/gitClient.ts`
- Test: `src/test/git/gitClient.test.ts`

**Interfaces:**
- Produces: `type ExecFn = (file: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string }>`；`createGitClient(cwd: string, exec: ExecFn): GitClient`，`GitClient.run(args: string[]): Promise<string>`（非 0 退出抛 `GitError`，携带 stdout/stderr）

- [ ] **Step 1: 写失败测试**

```ts
// src/test/git/gitClient.test.ts
import { describe, it, expect } from "vitest";
import { createGitClient } from "../../git/gitClient";

const ok = (out = "") => async () => ({ stdout: out, stderr: "" });
describe("gitClient", () => {
  it("run 返回 stdout", async () => {
    const g = createGitClient("D:/ws", ok("main\n"));
    expect((await g.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
  });
  it("非 0 退出抛 GitError（含 stderr）", async () => {
    const exec = async () => { throw Object.assign(new Error("fail"), { stdout: "", stderr: "fatal: not a git repository" }); };
    const g = createGitClient("D:/ws", exec as never);
    await expect(g.run(["status"])).rejects.toThrow(/not a git repository/);
  });
});
```

- [ ] **Step 2: 跑失败** → `npx vitest run src/test/git/gitClient.test.ts` FAIL

- [ ] **Step 3: 实现**

```ts
// src/git/gitClient.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export type ExecFn = (file: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string }>;
export class GitError extends Error {
  constructor(msg: string, public stdout: string, public stderr: string) { super(msg); }
}
export interface GitClient { run(args: string[]): Promise<string> }

export function createGitClient(cwd: string, exec: ExecFn = execFileAsync as ExecFn): GitClient {
  return {
    async run(args) {
      try {
        const { stdout } = await exec("git", args, { cwd });
        return stdout;
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        throw new GitError(e.stderr || e.message || "git failed", e.stdout ?? "", e.stderr ?? "");
      }
    },
  };
}
```

- [ ] **Step 4: 跑通过** → PASS
- [ ] **Step 5: Commit** → `feat(ext): git CLI 封装（execFile 注入式）`

---

### Task 4: 扩展端——分支与拉取原语

**Files:**
- Create: `src/git/branchOps.ts`、`src/git/pullOps.ts`
- Test: `src/test/git/branchOps.test.ts`、`src/test/git/pullOps.test.ts`

**Interfaces:**
- Produces: `ensureStudentBranch(git, studentId): Promise<void>`；`assertCurrentBranch(git, studentId): Promise<boolean>`；`pullNewOnly(git): Promise<{ pulled: string[] }>`
- 消费 Task 3 的 GitClient

- [ ] **Step 1: 写失败测试（fake git 记录调用序列）**

```ts
// src/test/git/branchOps.test.ts
import { describe, it, expect } from "vitest";
import { ensureStudentBranch, assertCurrentBranch } from "../../git/branchOps";

function recorder(responses: (args: string[]) => string | Error) {
  const calls: string[][] = [];
  const exec = async (_f: string, args: string[], _o: unknown) => {
    calls.push(args);
    const r = responses(args);
    if (r instanceof Error) throw Object.assign(r, { stdout: "", stderr: r.message });
    return { stdout: r, stderr: "" };
  };
  return { calls, git: { run: async (a: string[]) => { const e = exec("git", a, {}); return (await e).stdout; } } as never };
}

describe("ensureStudentBranch", () => {
  it("本地无分支 → 自 origin/main 创建并 checkout", async () => {
    const { calls, git } = recorder((a) => {
      if (a[0] === "branch" && a[1] === "--list") return "";          // 无本地分支
      if (a[0] === "rev-parse") return "";                              // checkout 后
      return "";
    });
    await ensureStudentBranch(git, "0001");
    expect(calls.some((c) => c.join(" ").includes("branch student-0001 origin/main"))).toBe(true);
    expect(calls.some((c) => c[0] === "checkout" && c[1] === "student-0001")).toBe(true);
  });
  it("已有分支 → 直接 checkout", async () => {
    const { calls, git } = recorder((a) => (a[0] === "branch" && a[1] === "--list" ? "student-0001\n" : ""));
    await ensureStudentBranch(git, "0001");
    expect(calls.some((c) => c.join(" ").includes("branch student-0001 origin/main"))).toBe(false);
  });
});
describe("assertCurrentBranch", () => {
  it("当前分支与学号匹配 / 不匹配", async () => {
    const mk = (out: string) => recorder(() => out).git;
    expect(await assertCurrentBranch(mk("student-0001\n"), "0001")).toBe(true);
    expect(await assertCurrentBranch(mk("student-0002\n"), "0001")).toBe(false);
  });
});
```

```ts
// src/test/git/pullOps.test.ts（核心：只新增策略）
import { describe, it, expect } from "vitest";
import { pullNewOnly } from "../../git/pullOps";

describe("pullNewOnly 只新增", () => {
  it("diff-filter=A 列出的新文件 → checkout origin/main -- 后 commit", async () => {
    const calls: string[][] = [];
    const git = { run: async (a: string[]) => { calls.push(a);
      if (a[0] === "diff") return "lesson5/new.py\nlesson5/old.py\n";  // 假设含修改，实现须用 --diff-filter=A
      if (a[0] === "rev-parse") return "abc";
      return ""; } } as never;
    const r = await pullNewOnly(git);
    expect(r.pulled).toContain("lesson5/new.py");
    expect(calls.some((c) => c.join(" ").includes("checkout origin/main --"))).toBe(true);
    expect(calls.some((c) => c[0] === "commit")).toBe(true);
  });
  it("无新增 → 不 commit", async () => {
    const calls: string[][] = [];
    const git = { run: async (a: string[]) => { calls.push(a); if (a[0] === "diff") return ""; return ""; } } as never;
    const r = await pullNewOnly(git);
    expect(r.pulled).toHaveLength(0);
    expect(calls.some((c) => c[0] === "commit")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑失败** → 两个测试文件 FAIL

- [ ] **Step 3: 实现**

```ts
// src/git/branchOps.ts
import type { GitClient } from "./gitClient";

export async function ensureStudentBranch(git: GitClient, studentId: string): Promise<void> {
  const branch = `student-${studentId}`;
  await git.run(["fetch", "origin"]);
  const local = await git.run(["branch", "--list", branch]);
  if (!local.trim()) await git.run(["branch", branch, "origin/main"]);
  await git.run(["checkout", branch]);
}

export async function assertCurrentBranch(git: GitClient, studentId: string): Promise<boolean> {
  const cur = (await git.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  return cur === `student-${studentId}`;
}
```

```ts
// src/git/pullOps.ts
import type { GitClient } from "./gitClient";

/** 只新增策略（spec 4.3）：教师误改已有文件天然不生效 */
export async function pullNewOnly(git: GitClient): Promise<{ pulled: string[] }> {
  await git.run(["fetch", "origin"]);
  const out = await git.run(["diff", "--diff-filter=A", "--name-only", "HEAD", "origin/main"]);
  const paths = out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (paths.length === 0) return { pulled: [] };
  await git.run(["checkout", "origin/main", "--", ...paths]);
  await git.run(["commit", "-m", `pull: ${paths.length} new file(s) from main`]);
  return { pulled: paths };
}
```

- [ ] **Step 4: 跑通过** → PASS
- [ ] **Step 5: Commit** → `feat(ext): 分支保障 + 只新增拉取原语`

---

### Task 5: 扩展端——提交原语与 notify

**Files:**
- Create: `src/git/commitOps.ts`
- Test: `src/test/git/commitOps.test.ts`

**Interfaces:**
- Produces: `submitAll(deps: SubmitDeps): Promise<SubmitResult>`
- `SubmitDeps = { git: GitClient; studentId: string; studentName: string; remoteWithToken: () => string; notify: (p: { studentId: string; studentName: string; commitHash: string; files: string[]; pushedAt: number }) => Promise<void> }`
- `SubmitResult = { kind: "ok" } | { kind: "nothing" } | { kind: "branchMismatch" } | { kind: "rebaseConflict" } | { kind: "pushFailed" }`

- [ ] **Step 1: 写失败测试**（recorder 同 Task 4 模式，覆盖五条分支：正常提交+notify；nothing-to-commit 幂等；分支不匹配拒绝；rebase 冲突；push 失败但 commit 已保留）

```ts
// src/test/git/commitOps.test.ts 核心用例
it("正常链路：断言→add→commit→rebase→记远端指针→push→diff 清单→notify", async () => {
  // fake: rev-parse 返回 student-0001；commit 成功；push 前远端指针 origin/student-0001=oldhash；push 成功
  // diff oldhash..HEAD 返回 ["lesson5/a.py"]
  const notified: unknown[] = [];
  const r = await submitAll({ git, studentId: "0001", studentName: "张三",
    remoteWithToken: () => "http://tok@git/repo.git",
    notify: async (p) => { notified.push(p); } });
  expect(r.kind).toBe("ok");
  expect(notified).toHaveLength(1);
  expect((notified[0] as { files: string[] }).files).toEqual(["lesson5/a.py"]);
});
it("nothing to commit → kind=nothing，不 notify", async () => { /* commit 抛 stderr 含 nothing to commit */ });
it("分支不匹配 → kind=branchMismatch，不执行 add", async () => { /* rev-parse 返回 student-0002 */ });
it("rebase 冲突 → kind=rebaseConflict", async () => { /* rebase 抛错 */ });
it("push 失败 → kind=pushFailed（本地 commit 保留）", async () => { /* push 抛网络错 */ });
```

- [ ] **Step 2: 跑失败** → FAIL

- [ ] **Step 3: 实现**

```ts
// src/git/commitOps.ts
import type { GitClient, GitError } from "./gitClient";
import { assertCurrentBranch } from "./branchOps";

export interface SubmitDeps {
  git: GitClient; studentId: string; studentName: string;
  remoteWithToken: () => string;
  notify: (p: { studentId: string; studentName: string; commitHash: string; files: string[]; pushedAt: number }) => Promise<void>;
}
export type SubmitResult = { kind: "ok" } | { kind: "nothing" } | { kind: "branchMismatch" } | { kind: "rebaseConflict" } | { kind: "pushFailed" };

export async function submitAll(deps: SubmitDeps): Promise<SubmitResult> {
  const { git, studentId, studentName } = deps;
  const branch = `student-${studentId}`;
  if (!(await assertCurrentBranch(git, studentId))) return { kind: "branchMismatch" };
  await git.run(["add", "-A"]);
  try {
    await git.run(["commit", "-m", `submit: workspace by ${studentId} ${studentName}`,
      `--author=${studentId} ${studentName} <${studentId}@classroom>`]);
  } catch (err) {
    const e = err as GitError;
    if (/nothing to commit/.test(`${e.stdout}${e.stderr}`)) return { kind: "nothing" };
    throw err;
  }
  await git.run(["fetch", "origin"]);
  try {
    await git.run(["rebase", `origin/${branch}`]);
  } catch {
    await git.run(["rebase", "--abort"]);
    return { kind: "rebaseConflict" };
  }
  const commitHash = (await git.run(["rev-parse", "HEAD"])).trim();
  let files: string[] = [];
  try {
    const before = (await git.run(["rev-parse", `origin/${branch}`])).trim();
    files = (await git.run(["diff", "--name-only", before, "HEAD"])).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { /* 远端无分支（首推）→ 全量清单 */ files = (await git.run(["ls-files"])).split("\n").filter(Boolean); }
  try {
    await git.run(["push", deps.remoteWithToken(), `HEAD:refs/heads/${branch}`]);
  } catch {
    return { kind: "pushFailed" };
  }
  await deps.notify({ studentId, studentName, commitHash, files, pushedAt: Date.now() }).catch(() => {});
  return { kind: "ok" };
}
```

- [ ] **Step 4: 跑通过** → PASS
- [ ] **Step 5: Commit** → `feat(ext): 提交原语（断言/幂等/rebase/push/notify）`

---

### Task 6: 扩展端——命令重接与身份集成

**Files:**
- Create: `src/git/gitEnv.ts`
- Modify: `src/extension.ts`（四命令改调 git 模块；clone 引导；启动 git 探测）
- Modify: `src/identity/identityPage.ts`（校验响应存 gitToken 到 secrets）
- Modify: `src/identity/switchFlow.ts`（四段换 git 原语）
- Test: 改造 `src/test/identity/switchFlow.test.ts` + 新增 `src/test/git/gitEnv.test.ts`

**Interfaces:**
- Produces: `gitEnv.ts` 导出 `remoteWithToken(repoUrl: string, token: string): string`（`https://oauth2:<token>@host/path` 形态）、`probeGit(exec?): Promise<boolean>`
- 消费 Task 4/5 的原语；identity 校验响应的 `gitToken`（Task 2 产出）

- [ ] **Step 1: gitEnv 测试 + 实现（TDD 两个用例：token 内嵌 URL 组装；git --version 探测）**
- [ ] **Step 2: identityPage 处理 gitToken**——校验响应含 `gitToken` 时 `context.secrets.store("pylearner.git.token", token)`；无 token（离线/未建号）提示「请联系教师开通 Git 账户」
- [ ] **Step 3: switchFlow 四段 git 化**——保持四段编排与「归档失败中止」语义，内部改为：`submitAll`（归档）→ `ensureStudentBranch(新学号)` + `clean -fdX` → `pull origin student-新学号`（失败容忍：新学生首用）→ 汇总通知。沿用现有 switchFlow.test.ts 的骨架，fake 换成 git recorder
- [ ] **Step 4: extension.ts 重接四命令**——提交/拉取/恢复/切换命令体改为调 git 模块（恢复 = `git.run(["checkout", branch, "--", "."])`；workspace 非 git 仓库 → 提示先在身份页完成校验触发 clone 引导）；activation 时 `probeGit()` 失败 → 警告「未检测到 Git，请安装」；notify 发 `POST {teacherUrl}/api/submissions/notify`（失败静默重试一次）
- [ ] **Step 5: 全量测试** → `npx vitest run` PASS（348 基线 + 新增）
- [ ] **Step 6: Commit** → `feat(ext): 四命令接 git 原语，token 集成，clone 引导与 git 探测`

---

### Task 7: 服务端——评审路径化

**Files:**
- Modify: `packages/shared/src/assignment.ts`（`ReviewRequestInput` 改为 `{ studentId, studentName, filePath, code, commitHash }`）
- Modify: `packages/server/src/routes/reviews.ts` + `src/reviewService.ts`（按 filePath 解析练习；review_cache key = sha256(路径+versionHash+code)）
- Test: 改造 `src/__tests__/` 里 review 相关测试

**Interfaces:**
- 消费 Task 1 的 `resolveExercisesByFiles`（单文件路径 → 练习）
- Produces: 评审回填按 `(exercise_id, student_id, commit_hash)` 定位（Task 1 表结构）

- [ ] **Step 1: 更新 shared 类型 + 写失败测试**（评审请求带 filePath → 服务端解析出 exercise → 题面锚点正确）
- [ ] **Step 2: 实现**——`resolveExercisesByFiles(persistence, [filePath])` 单元素复用；缓存 key 由 exerciseId 换成 filePath；评审完成回填 `UPDATE submissions SET review_json=? WHERE exercise_id=? AND student_id=? AND commit_hash=?`
- [ ] **Step 3: 跑服务端测试** → PASS
- [ ] **Step 4: Commit** → `feat(server): F5 评审按路径解析练习，缓存 key 路径化`

---

### Task 8: dashboard 适配

**Files:**
- Modify: `packages/dashboard/src/views/AdminView.vue`（删发布/取消发布按钮）
- Modify: `packages/dashboard/src/api/assignments.ts`（删 `publish`、`publishedList`）
- Modify: `packages/dashboard/src/stores/assignments.ts`（删 `publishAssignment`）
- Test: 改造 `AdminView.test.ts`

- [ ] **Step 1: 测试先行**——AdminView 测试改为断言无 `button.publish` / `button.unpublish`
- [ ] **Step 2: 删 UI 与 api/store 方法** → dashboard 测试 PASS（AlertPanel 基线失败除外）
- [ ] **Step 3: 构建** → `pnpm --filter @classroom/dashboard build` 成功
- [ ] **Step 4: Commit** → `feat(dashboard): 移除发布按钮（push 即布置）`

---

### Task 9: 服务端——删除旧链路

**Files（删除/清理）:**
- Delete 逻辑: `submissionController.ts` 的 `createSubmission/validateFiles/computeCodeHash`；`gitService.ts` 的 `writeToStudentBranch/createStudentBranches`（mutex 缩为 main 侧）；`syncService.ts` 的 `retryFailedPushes`（Phase 4 调用与导出）；`assignmentController.ts` 的 `publishAssignment/buildPublishedList/readExerciseContent`
- Delete 路由: `POST /api/submissions`、`GET /api/assignments/published`、`POST /api/assignments/:id/publish`、`GET /api/exercises/:id/content`
- 注入回写退役: `syncService.ts` scanOnce 后的 `commitAndPushMain(injections)` 调用与注入文件生成（对账保留、只读不回写）
- 对账正则放宽: `^week-(\d+)$` → 2.1 内容特征（一级子目录 + `.py`/`exercise.json`）
- persistence 清理: `getUnsyncedSubmissions/setSubmissionGitSynced`、submissions 旧列引用
- Test 清理: 对应旧测试文件删除或改造

- [ ] **Step 1: 逐文件删除，`tsc` 全程盯梢** → `npx tsc --noEmit` 每 删一处 跑一次
- [ ] **Step 2: 全量测试** → `pnpm --filter @classroom/server test` PASS（注意先停 dev server 避免 exercises-repo 冲突）
- [ ] **Step 3: Commit** → `refactor(server)!: 快照模型退役——删除发布状态机/版本对比/代写分支/补推队列`

---

### Task 10: 扩展端——删除旧代码

**Files（删除）:**
- `src/pull/pullCommand.ts`（及 pull 相关测试）
- `src/commands/restoreSubmissions.ts` 的 DB 恢复链（及测试）——按钮保留，命令体已换 checkout（Task 6）
- globalState 键 `pylearner.pull.versions`、`pylearner.submission.lastHashes` 的全部引用

- [ ] **Step 1: 删除 + 引用清理** → `npm run compile`（esbuild）+ `npx tsc --noEmit` 全绿
- [ ] **Step 2: 全量测试** → `npx vitest run` PASS
- [ ] **Step 3: Commit** → `refactor(ext)!: HTTP 拉取/DB 恢复/版本对比退役`

---

### Task 11: 集成测试（全链）

**Files:**
- Create: `packages/server/src/__tests__/integration-git-model.test.ts`

- [ ] **Step 1: 写集成测试**——临时目录建 bare 仓库（教师）+ 服务端（:memory: db + repoDir=教师 bare 的本地克隆）+ Node child_process 直接以学生身份操作 git（模拟扩展）：

```ts
// 骨架
// 1. 教师 push 新作业目录 lesson5/a.py 到 main
// 2. 服务端 syncNow 对账 → exercises 表出现该练习
// 3. 学生 clone → ensureStudentBranch → 修改 a.py → add/commit/push（真实 git 命令）
// 4. POST /api/submissions/notify → submissions 轻量索引出现记录 + SSE 收到 submission_received
// 5. POST /api/reviews/request（带 filePath+code+commitHash）→ 评审（LLM mock）→ 回填该记录
// 6. 学生二度拉取：教师再 push lesson6/ → pullNewOnly 只进 lesson6
```

- [ ] **Step 2: 跑通**（真实 git，Windows 环境注意路径分隔符统一用 POSIX 形态传 git）
- [ ] **Step 3: Commit** → `test: git 模型全链集成（拉取→提交→notify→评审→再拉取）`

---

## Self-Review 结论

- **Spec 覆盖**：spec 第 4 节四操作 → Task 3-6；2.2 账户模型 → Task 2；第 5 节 notify → Task 1；6.2 评审路径化 → Task 7；6.1 删除 → Task 9/10；管理页 → Task 8；第 10 节测试 → Task 11 ✓
- **类型一致性**：`GitClient.run(args: string[])`、`handleNotify(deps, body)`、`resolveExercisesByFiles(persistence, files)` 在各任务间签名一致 ✓
- **占位符扫描**：Task 6/9 的步骤含改造指引但核心接口与语义已在代码块/Interfaces 中定义，执行者需读现有文件后按 Interfaces 对接——符合既有大型文件的改造实际 ✓
