# 花名册管理与名册感知身份切换 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 服务端花名册单条 CRUD + 两级删除、validate 接口名册裁决扩展、扩展端三分叉切换（修复学期更替死锁）、教师端 RosterPanel 行内优先交互。

**Architecture:** 服务端新增 4 条路由 + persistence 四函数 + `purgeStudent` Gitea 联动（provision 逻辑抽公共函数复用）；validate 请求加 `previousStudentId?`、响应加 `previousIdInRoster?`（一次 roster 查询，零新增接口）；扩展端身份页按 `previousIdInRoster` 三分叉——false 时走「确认 → git 清空 → 保存新身份 → ensureStudentBranch + pullNewOnly」，不再触碰归档链路；RosterPanel 移除常驻导入文本框，日常操作全部在数据行上完成。

**Tech Stack:** Express 5 + better-sqlite3 + vitest + supertest（server）；Vue 3 + @vue/test-utils（dashboard）；VS Code 扩展 + vitest recorder 模式 fake git（vscode-pylearner）。

**Spec:** docs/superpowers/specs/2026-10-16-roster-management-design.md（本计划从该 spec 出发，执行者需同时阅读）

## Global Constraints

- **两个仓库**：服务端/仪表盘在 `d:/ruan/classroom-assistant`（分支 `feat/student-git-branch-model`）；扩展在 `d:/ruan/vscode-pylearner`（同分支）。
- **前置检查（Task 0）**：扩展仓库工作区有未提交改动（`src/extension.ts`、`src/test/identity/identityPage.test.ts`、`.vscodeignore` 及若干 `*-report*.md`）。执行任何任务前必须先请用户确认处置（提交或 stash），**严禁**把这些混进任务提交。
- 提交信息用中文 conventional commits（`feat:` / `fix:` / `test:` / `docs:`），与两仓库现有风格一致。
- 环境为 Windows PowerShell 5：**不支持 heredoc，不支持 `&&` 链**——commit 用 `git commit -m "单行"`；链式命令用 `;`。
- 提交只 `git add` 明确列出的文件，**禁止 `git add -A` / `git add .`**。
- 运行 server 测试前必须停掉 dev server（dev:server 与测试共享 git/数据目录会 index.lock 冲突）；杀进程要连 tsx watch 父进程一起杀。
- 学号是 roster 主键、不可改（改学号=删+加，UI 与 API 都不提供）。
- 错误码与文案逐字：`roster_empty` / `student_id_not_found` / `name_mismatch` 及对应中文文案（rosterController.ts 现状，本计划不得改动）。
- VS Code 模态弹窗 `modal: true` 会自动追加隐式取消按钮，**不得**显式再加取消按钮。
- `RosterEntry` 类型来自 `@classroom/shared`（packages/shared/src/assignment.ts L14：`{ studentId: string; studentName: string }`）。
- 测试命令：server/dashboard 在主仓库 `cd packages/<pkg>; npx vitest run src/__tests__/<file>.test.ts`；扩展在 `d:/ruan/vscode-pylearner` 下 `npx vitest run src/test/<path>.test.ts`。
- Spec §6 范围外（**不做**）：批量导入 `purgeRemoved` 参数、改学号、Gitea full_name 同步、学期重置 AdminView 按钮、events 学期维度。
- **执行每个任务前先读目标文件**：本计划的测试代码引用了现有测试基建的 helper（server 的 `makeApp` / `fakeGitea` / `baseDeps` / `until`，扩展的 `makeRecorder` / `cmd` / `joined` / `makeStore` / `submit` / `getHooks` 等）。这些名字以文件实际定义为准——若签名或命名与计划有出入，把计划的测试代码**适配到现有 helper**（保持断言语义不变），不要新造一套基建。
- 现有路由/控制器逻辑（validate 错误码、gitSecret 下发、F4 幂等注释语义）只做本计划明确要求的扩展，不重写、不改文案。

---

### Task 0: 前置检查与测试基线

**Files:** 无代码改动（环境检查）。

**Interfaces:**
- Consumes: 无
- Produces: 干净的基线（后续任务可安全提交）

- [ ] **Step 1: 确认两仓库分支**

Run（主仓库）: `git branch --show-current`
Expected: `feat/student-git-branch-model`

Run（扩展仓库 `d:/ruan/vscode-pylearner`）: `git branch --show-current`
Expected: `feat/student-git-branch-model`

- [ ] **Step 2: 处置扩展仓库未提交改动**

Run: `git -C d:/ruan/vscode-pylearner status --short`
Expected: 存在 `M src/extension.ts`、`M src/test/identity/identityPage.test.ts`、`M .vscodeignore` 及 untracked 报告 md。

询问用户：这些改动是否仍需保留？保留则先在扩展仓库提交（或 stash），确保后续任务提交不混入无关 diff。

- [ ] **Step 3: 确认 dev server 已停止**

Run: `netstat -ano | findstr :3000`
Expected: 无输出（有输出则先停 dev server 及其 tsx watch 父进程）。

---

### Task 1: persistence 花名册 CRUD 四函数

**Files:**
- Modify: `packages/server/src/persistence.ts`（接口区 L24-42、实现区花名册段 L158-172）
- Test: `packages/server/src/__tests__/persistence.test.ts`（追加 describe）

**Interfaces:**
- Consumes: 现有 `roster` 表（student_id 主键 / student_name / created_at）与 `student_tokens` 表。
- Produces（Task 3 路由依赖，签名逐字）:
  - `upsertRosterEntry(studentId: string, studentName: string): void`
  - `updateRosterEntry(studentId: string, studentName: string): boolean` — false=学号不存在
  - `deleteRosterEntry(studentId: string): boolean` — 软删仅移出名册；false=学号不存在
  - `purgeRosterEntry(studentId: string): void` — 硬删：名册行 + student_tokens 一并清除，幂等

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/__tests__/persistence.test.ts` 末尾追加（imports 与该文件现有风格保持一致，若文件顶部未引入则补 `import { describe, it, expect } from "vitest"` 与 `import { createPersistence } from "../persistence"`）：

```ts
describe("花名册单条 CRUD（spec roster §1.2）", () => {
  it("upsertRosterEntry：新增插入；已存在则仅改姓名（主键不变）", () => {
    const p = createPersistence(":memory:");
    p.upsertRosterEntry("0001", "张三");
    expect(p.getRosterEntry("0001")).toEqual({ studentId: "0001", studentName: "张三" });
    p.upsertRosterEntry("0001", "张叁");
    expect(p.getRosterEntry("0001")).toEqual({ studentId: "0001", studentName: "张叁" });
    expect(p.getRoster()).toHaveLength(1);
  });
  it("updateRosterEntry：改姓名；学号不存在返回 false", () => {
    const p = createPersistence(":memory:");
    p.upsertRosterEntry("0001", "张三");
    expect(p.updateRosterEntry("0001", "李四")).toBe(true);
    expect(p.getRosterEntry("0001")).toEqual({ studentId: "0001", studentName: "李四" });
    expect(p.updateRosterEntry("9999", "王五")).toBe(false);
  });
  it("deleteRosterEntry：软删仅移出名册，student_tokens 保留（spec §1.1 关键语义）", () => {
    const p = createPersistence(":memory:");
    p.upsertRosterEntry("0001", "张三");
    p.saveStudentToken("0001", "tok-1");
    expect(p.deleteRosterEntry("0001")).toBe(true);
    expect(p.getRosterEntry("0001")).toBeNull();
    expect(p.getStudentToken("0001")).toBe("tok-1");   // 凭证保留：重新导入时 F4 幂等跳过建号
    expect(p.deleteRosterEntry("0001")).toBe(false);
  });
  it("purgeRosterEntry：名册行 + student_tokens 一并清除，幂等可重复", () => {
    const p = createPersistence(":memory:");
    p.upsertRosterEntry("0001", "张三");
    p.saveStudentToken("0001", "tok-1");
    p.purgeRosterEntry("0001");
    expect(p.getRosterEntry("0001")).toBeNull();
    expect(p.getStudentToken("0001")).toBeNull();
    expect(() => p.purgeRosterEntry("0001")).not.toThrow();   // 幂等
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/server; npx vitest run src/__tests__/persistence.test.ts`
Expected: FAIL —— `p.upsertRosterEntry is not a function` 等四函数缺失。

- [ ] **Step 3: 实现**

`packages/server/src/persistence.ts` —— Persistence 接口（花名册段 `getRosterEntry` 之后）追加：

```ts
  upsertRosterEntry(studentId: string, studentName: string): void;
  updateRosterEntry(studentId: string, studentName: string): boolean;
  deleteRosterEntry(studentId: string): boolean;
  purgeRosterEntry(studentId: string): void;
```

实现区（`getRosterEntry` 之后）追加：

```ts
    upsertRosterEntry(studentId, studentName) {
      db.prepare(`INSERT INTO roster (student_id, student_name, created_at) VALUES (?, ?, ?)
        ON CONFLICT(student_id) DO UPDATE SET student_name = excluded.student_name`)
        .run(studentId, studentName, Date.now());
    },
    updateRosterEntry(studentId, studentName) {
      return db.prepare("UPDATE roster SET student_name = ? WHERE student_id = ?").run(studentName, studentId).changes > 0;
    },
    deleteRosterEntry(studentId) {
      return db.prepare("DELETE FROM roster WHERE student_id = ?").run(studentId).changes > 0;
    },
    purgeRosterEntry(studentId) {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM roster WHERE student_id = ?").run(studentId);
        db.prepare("DELETE FROM student_tokens WHERE student_id = ?").run(studentId);
      });
      tx();
    },
```

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/server; npx vitest run src/__tests__/persistence.test.ts`
Expected: PASS（含既有用例）。

- [ ] **Step 5: 提交**

```powershell
git add packages/server/src/persistence.ts packages/server/src/__tests__/persistence.test.ts
git commit -m "feat: 花名册单条 CRUD 持久层——upsert/update/软删（token 保留）/purge（名册+token 事务清除）"
```

---

### Task 2: Gitea purgeStudent（删保护→删分支→删账户，404 容错）

**Files:**
- Modify: `packages/server/src/gitea/adminApi.ts`
- Test: `packages/server/src/__tests__/gitea-admin.test.ts`（扩展 fakeGitea + 追加用例）

**Interfaces:**
- Consumes: 现有 `api(path, method, body)` 私有 fetch 封装、`deps.repo`（如 `classroom/exercises`）。
- Produces（Task 3 purge 路由依赖）: `GiteaAdmin` 接口新增 `purgeStudent(studentId: string): Promise<void>` —— 顺序：删分支保护规则 → 删 `student-<id>` 分支 → 删 Gitea 账户；任一步 404 视为已完成继续；非 404 失败抛错。

- [ ] **Step 1: 写失败测试**

`packages/server/src/__tests__/gitea-admin.test.ts`：

① 扩展 `fakeGitea` 的 opts 类型与路由（保持既有用例行为不变）：

```ts
function fakeGitea(opts?: {
  userCreateStatus?: number; patchStatus?: number; collabStatus?: number;
  protections?: Array<{ id: number; rule_name: string }>;   // purge 用：GET branch_protections 返回
  deleteStatus?: number;                                     // purge 用：注入 DELETE 各步失败状态码
}) {
  const calls: FakeCall[] = [];
  const f: typeof fetch = async (url, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const u = String(url);
    if (u.includes("/admin/users")) {
      if ((init?.method ?? "GET") === "DELETE") return new Response(null, { status: opts?.deleteStatus ?? 204 });
      if ((init?.method ?? "GET") === "PATCH") return new Response("{}", { status: opts?.patchStatus ?? 200 });
      return new Response("{}", { status: opts?.userCreateStatus ?? 201 });
    }
    if (u.includes("/collaborators/")) return new Response(null, { status: opts?.collabStatus ?? 204 });
    if (u.includes("branch_protections")) {
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify(opts?.protections ?? []), { status: 200 });
      if ((init?.method ?? "GET") === "DELETE") return new Response(null, { status: opts?.deleteStatus ?? 204 });
      return new Response("{}", { status: 201 });
    }
    if ((init?.method ?? "GET") === "DELETE" && u.includes("/branches/")) return new Response(null, { status: opts?.deleteStatus ?? 204 });
    return new Response("{}", { status: 200 });
  };
  return { calls, f };
}
```

② 文件末尾追加 describe：

```ts
describe("purgeStudent（spec roster §1.1 硬删除联动）", () => {
  it("调用顺序：删分支保护(带 rule id) → 删 student-<id> 分支 → 删 Gitea 账户", async () => {
    const { calls, f } = fakeGitea({ protections: [{ id: 7, rule_name: "student-0001" }] });
    const admin = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    await admin.purgeStudent("0001");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET http://gitea.test/api/v1/repos/classroom/exercises/branch_protections",
      "DELETE http://gitea.test/api/v1/repos/classroom/exercises/branch_protections/7",
      "DELETE http://gitea.test/api/v1/repos/classroom/exercises/branches/student-0001",
      "DELETE http://gitea.test/api/v1/admin/users/0001",
    ]);
  });
  it("无分支保护规则 → 跳过 DELETE 保护步骤，继续删分支与账户", async () => {
    const { calls, f } = fakeGitea({ protections: [] });
    const admin = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    await expect(admin.purgeStudent("0001")).resolves.toBeUndefined();
    expect(calls.filter((c) => c.method === "DELETE" && c.url.includes("branch_protections"))).toHaveLength(0);
    expect(calls.filter((c) => c.method === "DELETE" && c.url.includes("/branches/"))).toHaveLength(1);
    expect(calls.filter((c) => c.method === "DELETE" && c.url.includes("/admin/users/"))).toHaveLength(1);
  });
  it("各步 404 容错（已删过/幂等重试）→ 不抛错", async () => {
    const { f } = fakeGitea({ protections: [{ id: 7, rule_name: "student-0001" }], deleteStatus: 404 });
    const admin = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    await expect(admin.purgeStudent("0001")).resolves.toBeUndefined();
  });
  it("非 404 失败（如 500）→ 抛错（路由层负责 502 + 名册不动）", async () => {
    const { f } = fakeGitea({ protections: [{ id: 7, rule_name: "student-0001" }], deleteStatus: 500 });
    const admin = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    await expect(admin.purgeStudent("0001")).rejects.toThrow("gitea branch protection delete failed: 500");
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/server; npx vitest run src/__tests__/gitea-admin.test.ts`
Expected: FAIL —— `admin.purgeStudent is not a function`。

- [ ] **Step 3: 实现**

`packages/server/src/gitea/adminApi.ts` —— `GiteaAdmin` 接口追加（`addCollaborator` 之后）：

```ts
  /** 硬删除联动（spec roster §1.1）：删分支保护规则 → 删 student-<id> 分支 → 删 Gitea 账户；任一步 404 视为已完成继续 */
  purgeStudent(studentId: string): Promise<void>;
```

`createGiteaAdmin` 返回对象内追加：

```ts
    async purgeStudent(studentId: string): Promise<void> {
      // 1. 找到该生分支保护规则并删除（Gitea 28 按规则 id 删；无规则则跳过）
      const list = await api(`/api/v1/repos/${deps.repo}/branch_protections`, "GET");
      if (list.ok) {
        const rules = (await list.json()) as Array<{ id: number; rule_name: string }>;
        const rule = rules.find((r) => r.rule_name === `student-${studentId}`);
        if (rule) {
          const del = await api(`/api/v1/repos/${deps.repo}/branch_protections/${rule.id}`, "DELETE");
          if (!del.ok && del.status !== 404) throw new Error(`gitea branch protection delete failed: ${del.status}`);
        }
      }
      // 2. 删学生分支（404=已无分支，视为已完成）
      const delBranch = await api(`/api/v1/repos/${deps.repo}/branches/student-${studentId}`, "DELETE");
      if (!delBranch.ok && delBranch.status !== 404) throw new Error(`gitea branch delete failed: ${delBranch.status}`);
      // 3. 删 Gitea 账户（404=已删，视为已完成）
      const delUser = await api(`/api/v1/admin/users/${studentId}`, "DELETE");
      if (!delUser.ok && delUser.status !== 404) throw new Error(`gitea user delete failed: ${delUser.status}`);
    },
```

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/server; npx vitest run src/__tests__/gitea-admin.test.ts`
Expected: PASS（既有 fakeGitea 用例不受扩展影响）。

- [ ] **Step 5: 提交**

```powershell
git add packages/server/src/gitea/adminApi.ts packages/server/src/__tests__/gitea-admin.test.ts
git commit -m "feat: Gitea purgeStudent——删分支保护/删学生分支/删账户，404 容错幂等"
```

---

### Task 3: 花名册 CRUD 四条路由 + provision 公共函数

**Files:**
- Modify: `packages/server/src/routes/roster.ts`（追加式：imports、provisionEntries 函数、4 条新路由；**现有三条路由逻辑不动**，仅把导入路径的内联 provision 循环替换为公共函数调用）
- Test: `packages/server/src/__tests__/routes.test.ts`（追加无 Gitea 用例）、`packages/server/src/__tests__/gitea-admin.test.ts`（追加联动用例）

**Interfaces:**
- Consumes: Task 1 的 `upsertRosterEntry/updateRosterEntry/deleteRosterEntry/purgeRosterEntry`；Task 2 的 `purgeStudent`；现有 `parseRosterText`、`ensureStudentAccount/addCollaborator/protectBranch`、`persistence.getStudentToken/saveStudentToken`。
- Produces（Task 6 dashboard 依赖的 HTTP 契约）:
  - `POST /api/roster/entry` body `{studentId, studentName}` → `200 {ok:true}`；空字段 `400 {error}`；已存在 `409 {error:"该学号已在名册中"}`；成功后异步 provision（建号→协作者→分支保护）
  - `PATCH /api/roster/entry/:studentId` body `{studentName}` → `200 {ok:true,studentId,studentName}`；姓名空 `400`；学号不存在 `404 {error:"该学号不在名册中"}`
  - `DELETE /api/roster/entry/:studentId`（软删）→ `200 {ok:true}`；不存在 `404`；token 保留
  - `POST /api/roster/entry/:studentId/purge` → `200 {ok:true}`（幂等）；Gitea 联动失败 `502 {error:"Gitea 清除失败，名册未变动，可重试"}` 且名册不动

- [ ] **Step 1: 写失败测试**

`packages/server/src/__tests__/routes.test.ts` 末尾追加：

```ts
describe("花名册单条 CRUD 路由（spec roster §1.1，无 Gitea 环境）", () => {
  it("POST /api/roster/entry：空字段 400；成功 200 且 GET 可见；重复 409", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster/entry").send({ studentId: "", studentName: "张三" }).expect(400);
    await request(app).post("/api/roster/entry").send({ studentId: "0001", studentName: "" }).expect(400);
    await request(app).post("/api/roster/entry").send({ studentId: " 0001 ", studentName: " 张三 " }).expect(200, { ok: true });
    await request(app).get("/api/roster").expect(200, [{ studentId: "0001", studentName: "张三" }]);
    await request(app).post("/api/roster/entry").send({ studentId: "0001", studentName: "李四" }).expect(409, { error: "该学号已在名册中" });
  });
  it("PATCH /api/roster/entry/:id：仅改姓名；不存在 404；空姓名 400", async () => {
    const { app } = makeApp();
    await request(app).patch("/api/roster/entry/0001").send({ studentName: "李四" }).expect(404);
    await request(app).post("/api/roster/entry").send({ studentId: "0001", studentName: "张三" }).expect(200);
    await request(app).patch("/api/roster/entry/0001").send({ studentName: "  " }).expect(400);
    await request(app).patch("/api/roster/entry/0001").send({ studentName: " 张三丰 " })
      .expect(200, { ok: true, studentId: "0001", studentName: "张三丰" });
    await request(app).get("/api/roster").expect(200, [{ studentId: "0001", studentName: "张三丰" }]);
  });
  it("DELETE /api/roster/entry/:id：软删出册；不存在 404", async () => {
    const { app, persistence } = makeApp();
    await request(app).delete("/api/roster/entry/0001").expect(404, { error: "该学号不在名册中" });
    await request(app).post("/api/roster/entry").send({ studentId: "0001", studentName: "张三" }).expect(200);
    await request(app).delete("/api/roster/entry/0001").expect(200, { ok: true });
    await request(app).get("/api/roster").expect(200, []);
    expect(persistence.getStudentToken("0001")).toBeNull();   // 无 Gitea 环境：本就无 token
  });
  it("POST /api/roster/entry/:id/purge：无 Gitea 时幂等清 token + 名册行", async () => {
    const { app, persistence } = makeApp();
    await request(app).post("/api/roster/entry").send({ studentId: "0001", studentName: "张三" }).expect(200);
    persistence.saveStudentToken("0001", "tok-1");
    await request(app).post("/api/roster/entry/0001/purge").expect(200, { ok: true });
    expect(persistence.getStudentToken("0001")).toBeNull();
    await request(app).get("/api/roster").expect(200, []);
    await request(app).post("/api/roster/entry/0001/purge").expect(200, { ok: true });   // 幂等
  });
});
```

`packages/server/src/__tests__/gitea-admin.test.ts` 末尾追加（联动：provision + purge 顺序与失败隔离）：

```ts
describe("花名册 CRUD 路由（Gitea 联动，spec roster §1.1）", () => {
  it("POST /api/roster/entry：异步 provision 逐生建号+保护（与导入共用逻辑）", async () => {
    const persistence = createPersistence(":memory:");
    const { calls, f } = fakeGitea();
    const gitea = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    const app = express();
    app.use(express.json());
    registerRosterRoutes(app, { persistence, gitea });
    await request(app).post("/api/roster/entry").send({ studentId: "0001", studentName: "张三" }).expect(200, { ok: true });
    await until(() => persistence.getStudentToken("0001") !== null);
    expect(calls.filter((c) => c.url.includes("branch_protections"))).toHaveLength(1);
    expect(calls.filter((c) => c.method === "PUT" && c.url.includes("/collaborators/"))).toHaveLength(1);
  });
  it("POST /api/roster/entry/:id/purge：Gitea 联动失败 → 502 且名册/token 均不动", async () => {
    const persistence = createPersistence(":memory:");
    const { f } = fakeGitea({ protections: [{ id: 7, rule_name: "student-0001" }], deleteStatus: 500 });
    const gitea = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    const app = express();
    app.use(express.json());
    registerRosterRoutes(app, { persistence, gitea });
    await request(app).post("/api/roster/entry").send({ studentId: "0001", studentName: "张三" }).expect(200);
    await request(app).post("/api/roster/entry/0001/purge").expect(502, { error: "Gitea 清除失败，名册未变动，可重试" });
    await request(app).get("/api/roster").expect(200, [{ studentId: "0001", studentName: "张三" }]);
  });
  it("DELETE /api/roster/entry/:id 软删后 token 保留；purge 后 token 清除", async () => {
    const persistence = createPersistence(":memory:");
    const { f } = fakeGitea();
    const gitea = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    const app = express();
    app.use(express.json());
    registerRosterRoutes(app, { persistence, gitea });
    await request(app).post("/api/roster/entry").send({ studentId: "0001", studentName: "张三" }).expect(200);
    await until(() => persistence.getStudentToken("0001") !== null);
    const secret = persistence.getStudentToken("0001");
    await request(app).delete("/api/roster/entry/0001").expect(200);
    expect(persistence.getStudentToken("0001")).toBe(secret);   // 软删：凭证无缝复用
    await request(app).post("/api/roster/entry/0001/purge").expect(200);
    expect(persistence.getStudentToken("0001")).toBeNull();     // 硬删：token 清除
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/server; npx vitest run src/__tests__/routes.test.ts src/__tests__/gitea-admin.test.ts`
Expected: FAIL —— 新路由 404（`POST /api/roster/entry` 等）。

- [ ] **Step 3: 实现（追加式，现有三条路由不动）**

① 顶部 imports 补充（已存在的跳过；`RosterEntry` 为新增）：

```ts
import type { RosterEntry } from "@classroom/shared";
import type { GiteaAdmin } from "../gitea/adminApi";
```

② 在 `registerRosterRoutes` **之前**新增公共函数（把现有导入路径的内联 provision 循环逐行搬入，语义不变）：

```ts
/** 逐生建号+协作者+分支保护（异步不阻塞响应；单生失败仅告警，幂等重试）——整体导入与单条新增共用（spec roster §1.2） */
function provisionEntries(persistence: Persistence, gitea: GiteaAdmin, entries: RosterEntry[]): void {
  void (async () => {
    for (const e of entries) {
      try {
        // F4 防重复轮换：已有 gitSecret 的学生跳过建号/改密；gitSecret 生成即入库；协作者授权与分支保护幂等照常执行
        if (persistence.getStudentToken(e.studentId) === null) {
          persistence.saveStudentToken(e.studentId, await gitea.ensureStudentAccount(e.studentId));
        }
        await gitea.addCollaborator(e.studentId);   // write 协作者权限：学生 push 自己分支的前提
        await gitea.protectBranch(e.studentId);
      } catch (err) {
        logEvent({ event: "gitea.provision_failed", level: "warn", data: {
          studentId: e.studentId, error: err instanceof Error ? err.message : String(err),
        } });
      }
    }
  })();
}
```

③ 现有 `POST /api/roster` handler 内的内联 provision 异步循环整段替换为一行（其余 handler 代码不动；若局部 `const gitea = deps.gitea ?? null` 无其他引用则一并删除）：

```ts
    if (deps.gitea) provisionEntries(deps.persistence, deps.gitea, entries);
```

④ 在 `GET /api/roster` 路由之后、`POST /api/identity/validate` 之前插入 4 条新路由（直接用 `deps.gitea` 判空，不改动 registerRosterRoutes 签名；**validate 路由本任务不改动**，其 spread 由 Task 4 完成）：

```ts
  // —— 单条新增（补录转学生，spec roster §1.1）——
  app.post("/api/roster/entry", (req, res) => {
    const studentId = typeof req.body?.studentId === "string" ? req.body.studentId.trim() : "";
    const studentName = typeof req.body?.studentName === "string" ? req.body.studentName.trim() : "";
    if (!studentId || !studentName) return res.status(400).json({ error: "学号和姓名不能为空" });
    if (deps.persistence.getRosterEntry(studentId)) return res.status(409).json({ error: "该学号已在名册中" });
    deps.persistence.upsertRosterEntry(studentId, studentName);
    logEvent({ event: "api.roster_entry_added", level: "info", data: { studentId } });
    if (deps.gitea) provisionEntries(deps.persistence, deps.gitea, [{ studentId, studentName }]);
    res.json({ ok: true });
  });
  // —— 改姓名（学号是主键不可改，spec roster §1.1）——
  app.patch("/api/roster/entry/:studentId", (req, res) => {
    const studentId = (req.params.studentId ?? "").trim();
    const studentName = typeof req.body?.studentName === "string" ? req.body.studentName.trim() : "";
    if (!studentName) return res.status(400).json({ error: "姓名不能为空" });
    if (!deps.persistence.updateRosterEntry(studentId, studentName)) return res.status(404).json({ error: "该学号不在名册中" });
    logEvent({ event: "api.roster_entry_renamed", level: "info", data: { studentId } });
    res.json({ ok: true, studentId, studentName });
  });
  // —— 软删除：仅移出名册，student_tokens 保留（重新导入无缝复用凭证）——
  app.delete("/api/roster/entry/:studentId", (req, res) => {
    const studentId = (req.params.studentId ?? "").trim();
    if (!deps.persistence.deleteRosterEntry(studentId)) return res.status(404).json({ error: "该学号不在名册中" });
    logEvent({ event: "api.roster_entry_removed", level: "info", data: { studentId } });
    res.json({ ok: true });
  });
  // —— 硬删除：Gitea 联动彻底清除（删保护→删分支→删账户）+ 名册/token 清除；Gitea 失败则名册不动可重试 ——
  app.post("/api/roster/entry/:studentId/purge", async (req, res) => {
    const studentId = (req.params.studentId ?? "").trim();
    if (!studentId) return res.status(400).json({ error: "缺少学号" });
    if (deps.gitea) {
      try {
        await deps.gitea.purgeStudent(studentId);
      } catch (err) {
        logEvent({ event: "gitea.purge_failed", level: "warn", data: {
          studentId, error: err instanceof Error ? err.message : String(err),
        } });
        return res.status(502).json({ error: "Gitea 清除失败，名册未变动，可重试" });
      }
    }
    deps.persistence.purgeRosterEntry(studentId);
    logEvent({ event: "api.roster_purged", level: "info", data: { studentId } });
    res.json({ ok: true });
  });
```

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/server; npx vitest run src/__tests__/routes.test.ts src/__tests__/gitea-admin.test.ts`
Expected: PASS（既有用例不回归——`/api/roster`、validate 行为不变）。

- [ ] **Step 5: 类型检查 + 提交**

Run: `cd packages/server; npx tsc --noEmit`
Expected: 无错误。

```powershell
git add packages/server/src/routes/roster.ts packages/server/src/__tests__/routes.test.ts packages/server/src/__tests__/gitea-admin.test.ts
git commit -m "feat: 花名册单条 CRUD 四路由（entry 增/改名/软删/purge）+ provision 抽公共函数复用"
```

---

### Task 4: validate 接口 previousIdInRoster 裁决字段

**Files:**
- Modify: `packages/server/src/controllers/rosterController.ts`（L16-34）
- Modify: `packages/server/src/routes/roster.ts`（validate 路由响应追加 spread 一行）
- Test: `packages/server/src/__tests__/routes.test.ts`（追加 describe）

**Interfaces:**
- Consumes: 现有 `validateIdentity`、`persistence.getRosterEntry`。
- Produces（Task 9 扩展端依赖）:
  - `IdentityValidateBody` 增加 `previousStudentId?: string`
  - `IdentityValidateResult` 的 ok 分支变为 `{ ok: true; studentName: string; previousIdInRoster?: boolean }`
  - `previousIdInRoster` 仅当 `previousStudentId` 非空且 ≠ 新学号时返回；值 = 旧学号是否仍在名册

- [ ] **Step 1: 写失败测试**

`packages/server/src/__tests__/routes.test.ts` 末尾追加：

```ts
describe("validate 名册裁决扩展（spec roster §2）", () => {
  it("带 previousStudentId：旧学号在名册 → previousIdInRoster=true（正常换机，走归档链路）", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "0001 张三\n0002 李四" }).expect(200);
    const v = await request(app).post("/api/identity/validate")
      .send({ studentId: "0002", studentName: "李四", previousStudentId: "0001" }).expect(200);
    expect(v.body).toEqual({ ok: true, studentName: "李四", gitSecret: null, previousIdInRoster: true });
  });
  it("带 previousStudentId：旧学号已不在名册 → false（学期更替，扩展端走清空三分叉）", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "0002 李四" }).expect(200);
    const v = await request(app).post("/api/identity/validate")
      .send({ studentId: "0002", studentName: "李四", previousStudentId: "0001" }).expect(200);
    expect(v.body).toEqual({ ok: true, studentName: "李四", gitSecret: null, previousIdInRoster: false });
  });
  it("不带 previousStudentId / 同学号重存 → 响应不含 previousIdInRoster 字段（向后兼容）", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "0002 李四" }).expect(200);
    const v1 = await request(app).post("/api/identity/validate")
      .send({ studentId: "0002", studentName: "李四" }).expect(200);
    expect(v1.body).toEqual({ ok: true, studentName: "李四", gitSecret: null });
    const v2 = await request(app).post("/api/identity/validate")
      .send({ studentId: "0002", studentName: "李四", previousStudentId: "0002" }).expect(200);
    expect(v2.body).toEqual({ ok: true, studentName: "李四", gitSecret: null });
  });
  it("校验失败（姓名不匹配）→ 400 不含裁决字段", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "0002 李四" }).expect(200);
    await request(app).post("/api/identity/validate")
      .send({ studentId: "0002", studentName: "王五", previousStudentId: "0001" })
      .expect(400, { code: "name_mismatch", message: "姓名与该学号不匹配，请检查或联系教员" });
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/server; npx vitest run src/__tests__/routes.test.ts`
Expected: FAIL —— 响应缺少 `previousIdInRoster`。

- [ ] **Step 3: 实现**

`packages/server/src/controllers/rosterController.ts`：

```ts
export interface IdentityValidateBody { studentId?: string; studentName?: string; previousStudentId?: string; }

export type IdentityValidateResult =
  | { ok: true; studentName: string; previousIdInRoster?: boolean }
  | { ok: false; code: "roster_empty" | "student_id_not_found" | "name_mismatch"; message: string };
```

`validateIdentity` 函数末尾的 `return { ok: true, studentName: entry.studentName };` 替换为：

```ts
  // 名册裁决（spec roster §2）：previousStudentId 存在且 ≠ 新学号时返回旧学号是否仍在册；
  // 服务端只回 boolean，不暴露名册其他信息
  const prev = (body.previousStudentId ?? "").trim();
  if (prev && prev !== (body.studentId ?? "").trim()) {
    return { ok: true, studentName: entry.studentName, previousIdInRoster: p.getRosterEntry(prev) !== null };
  }
  return { ok: true, studentName: entry.studentName };
```

② `packages/server/src/routes/roster.ts` 的 `POST /api/identity/validate` 路由：`res.json` 响应对象追加一行 spread（其余不动）：

```ts
    res.json({
      ok: true, studentName: r.studentName,
      gitSecret: deps.persistence.getStudentToken(studentId),
      ...(r.previousIdInRoster !== undefined ? { previousIdInRoster: r.previousIdInRoster } : {}),
    });
```

注：现状该路由可能已有等价结构——以「在 ok 响应中追加 `...(r.previousIdInRoster !== undefined ? { previousIdInRoster: r.previousIdInRoster } : {})`」为目标 diff，不重排既有字段。

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/server; npx vitest run src/__tests__/routes.test.ts src/__tests__/gitea-admin.test.ts`
Expected: PASS（gitea-admin.test 的 validate 用例不带 previousStudentId，响应不含新字段，不回归）。

- [ ] **Step 5: 提交**

```powershell
git add packages/server/src/controllers/rosterController.ts packages/server/src/routes/roster.ts packages/server/src/__tests__/routes.test.ts
git commit -m "feat: validate 接口名册裁决——previousStudentId 请求字段 + previousIdInRoster 响应字段"
```

---

### Task 5: dashboard admin API 扩展（4 调用 + 整表替换改名）

**Files:**
- Modify: `packages/dashboard/src/api/admin.ts`（整文件重写）

**Interfaces:**
- Consumes: Task 3 的四条路由 + 现有 `POST /api/roster`。
- Produces（Task 6 RosterPanel 依赖，函数名逐字）:
  - `adminApi.roster(): Promise<RosterEntry[]>`（不变）
  - `adminApi.addRosterEntry(studentId: string, studentName: string): Promise<{ ok: true }>`
  - `adminApi.renameRosterEntry(studentId: string, studentName: string): Promise<{ ok: true; studentId: string; studentName: string }>`
  - `adminApi.removeRosterEntry(studentId: string): Promise<{ ok: true }>`
  - `adminApi.purgeRosterEntry(studentId: string): Promise<{ ok: true }>`
  - `adminApi.replaceRoster(text: string): Promise<{ ok: true; count: number }>`（原 `importRoster` 改名，语义=整表替换）

- [ ] **Step 1: 实现（纯封装，由 Task 6 组件测试覆盖调用契约）**

`packages/dashboard/src/api/admin.ts` 整文件重写：

```ts
import type { RosterEntry } from "@classroom/shared";

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return (await r.json()) as T;
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return (await r.json()) as T;
}

/** 管理页 API（花名册行内优先交互，spec roster §4） */
export const adminApi = {
  roster: () => get<RosterEntry[]>("/api/roster"),
  /** 单条新增（补录转学生） */
  addRosterEntry: (studentId: string, studentName: string) =>
    send<{ ok: true }>("/api/roster/entry", "POST", { studentId, studentName }),
  /** 仅改姓名（学号不可改） */
  renameRosterEntry: (studentId: string, studentName: string) =>
    send<{ ok: true; studentId: string; studentName: string }>(`/api/roster/entry/${encodeURIComponent(studentId)}`, "PATCH", { studentName }),
  /** 软删除：仅移出名册，Gitea 凭证保留 */
  removeRosterEntry: (studentId: string) =>
    send<{ ok: true }>(`/api/roster/entry/${encodeURIComponent(studentId)}`, "DELETE"),
  /** 硬删除：删 Gitea 账户与学生分支（前端已二次确认） */
  purgeRosterEntry: (studentId: string) =>
    send<{ ok: true }>(`/api/roster/entry/${encodeURIComponent(studentId)}/purge`, "POST"),
  /** 学期换血：整表替换（覆盖式导入，每行「学号 姓名」） */
  replaceRoster: (text: string) => send<{ ok: true; count: number }>("/api/roster", "POST", { text }),
};
```

- [ ] **Step 2: 类型检查**

Run: `cd packages/dashboard; npx vue-tsc -b`
Expected: 类型检查无错误（即 build 脚本的类型阶段；如报既有的无关错误，以 Task 6 Step 4 全量测试为准）。

- [ ] **Step 3: 提交**

```powershell
git add packages/dashboard/src/api/admin.ts
git commit -m "feat: 管理 API 花名册行内操作封装——add/rename/remove/purge + replaceRoster 整表替换"
```

---

### Task 6: RosterPanel 行内优先交互重写

**Files:**
- Modify: `packages/dashboard/src/components/RosterPanel.vue`（整文件重写）
- Create: `packages/dashboard/src/__tests__/RosterPanel.test.ts`
- Modify: `packages/dashboard/src/__tests__/AdminView.test.ts`（移除导入文本框断言）

**Interfaces:**
- Consumes: Task 5 的全部 `adminApi` 函数。
- Produces: RosterPanel 组件（props `roster: RosterEntry[]`、emit `refreshed` 不变，AdminView 零改动）；测试选择器 `.edit-name/.save-edit/.add-id/.add-name/.add-entry/.batch-text/.add-batch/.replace-text/.replace-roster/.remove-entry/.purge-entry`。

- [ ] **Step 1: 写失败测试**

`packages/dashboard/src/__tests__/RosterPanel.test.ts`（新建）：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("../api/admin", () => ({
  adminApi: {
    roster: vi.fn(async () => []),
    addRosterEntry: vi.fn(async () => ({ ok: true })),
    renameRosterEntry: vi.fn(async () => ({ ok: true, studentId: "0001", studentName: "张三丰" })),
    removeRosterEntry: vi.fn(async () => ({ ok: true })),
    purgeRosterEntry: vi.fn(async () => ({ ok: true })),
    replaceRoster: vi.fn(async () => ({ ok: true, count: 2 })),
  },
}));

import RosterPanel from "../components/RosterPanel.vue";
import { adminApi } from "../api/admin";

const roster = [
  { studentId: "0001", studentName: "张三" },
  { studentId: "0002", studentName: "李四" },
];

beforeEach(() => vi.clearAllMocks());

describe("RosterPanel 行内优先交互（spec roster §4）", () => {
  it("无常驻导入文本框（旧两段式导入已移除）", () => {
    const w = mount(RosterPanel, { props: { roster } });
    expect(w.find("button.import-roster").exists()).toBe(false);
    expect(w.find("textarea.import-text").exists()).toBe(false);
  });
  it("行内改名：点姓名 → 输入 → 保存 → renameRosterEntry(id, 新名) + refreshed", async () => {
    const w = mount(RosterPanel, { props: { roster } });
    await w.findAll(".name-text")[0].trigger("click");
    await w.find("input.edit-name").setValue("张三丰");
    await w.find("button.save-edit").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.renameRosterEntry).toHaveBeenCalledWith("0001", "张三丰");
    expect(w.emitted("refreshed")).toBeTruthy();
  });
  it("添加行：填学号姓名 → + 添加学生 → addRosterEntry + 输入清空 + refreshed", async () => {
    const w = mount(RosterPanel, { props: { roster } });
    await w.find("input.add-id").setValue("0003");
    await w.find("input.add-name").setValue("王五");
    await w.find("button.add-entry").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.addRosterEntry).toHaveBeenCalledWith("0003", "王五");
    expect((w.find("input.add-id").element as HTMLInputElement).value).toBe("");
    expect(w.emitted("refreshed")).toBeTruthy();
  });
  it("批量添加：两行文本 → 拆行逐条 POST entry → refreshed；失败行留在批量区", async () => {
    (adminApi.addRosterEntry as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id === "0002") throw new Error("409");
      return { ok: true };
    });
    const w = mount(RosterPanel, { props: { roster } });
    await w.find("textarea.batch-text").setValue("0003 王五\n0002 张三丰\n坏行");
    await w.find("button.add-batch").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.addRosterEntry).toHaveBeenCalledTimes(2);   // 坏行不发请求
    expect(adminApi.addRosterEntry).toHaveBeenCalledWith("0003", "王五");
    expect(adminApi.addRosterEntry).toHaveBeenCalledWith("0002", "张三丰");
    expect((w.find("textarea.batch-text").element as HTMLTextAreaElement).value).toBe("0002 张三丰\n坏行");
    expect(w.text()).toContain("成功 1 条");
    expect(w.emitted("refreshed")).toBeTruthy();
  });
  it("移出（软删除）：一键执行无确认弹窗", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const w = mount(RosterPanel, { props: { roster } });
    await w.findAll("button.remove-entry")[0].trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.removeRosterEntry).toHaveBeenCalledWith("0001");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(w.emitted("refreshed")).toBeTruthy();
  });
  it("彻底清除：confirm 确认 → purge；confirm 取消 → 不调用", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const w = mount(RosterPanel, { props: { roster } });
    await w.findAll("button.purge-entry")[1].trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(confirmSpy.mock.calls[0][0]).toContain("student-0002");   // 文案明确后果
    expect(adminApi.purgeRosterEntry).toHaveBeenCalledWith("0002");

    (adminApi.purgeRosterEntry as ReturnType<typeof vi.fn>).mockClear();
    confirmSpy.mockReturnValue(false);
    await w.findAll("button.purge-entry")[1].trigger("click");
    expect(adminApi.purgeRosterEntry).not.toHaveBeenCalled();
  });
  it("整表替换：粘贴新名单 → replaceRoster（走覆盖导入）→ refreshed", async () => {
    const w = mount(RosterPanel, { props: { roster } });
    await w.find("textarea.replace-text").setValue("1001 新一\n1002 新二");
    await w.find("button.replace-roster").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.replaceRoster).toHaveBeenCalledWith("1001 新一\n1002 新二");
    expect(w.emitted("refreshed")).toBeTruthy();
  });
});
```

`packages/dashboard/src/__tests__/AdminView.test.ts`：

① mock 的 adminApi 补全 Task 5 的 5 个新函数（否则组件内调用 undefined 会炸）：

```ts
vi.mock("../api/admin", () => ({
  adminApi: {
    roster: vi.fn(async () => [{ studentId: "0001", studentName: "张三" }]),
    addRosterEntry: vi.fn(async () => ({ ok: true })),
    renameRosterEntry: vi.fn(async () => ({ ok: true, studentId: "0001", studentName: "张三" })),
    removeRosterEntry: vi.fn(async () => ({ ok: true })),
    purgeRosterEntry: vi.fn(async () => ({ ok: true })),
    replaceRoster: vi.fn(async () => ({ ok: true, count: 2 })),
  },
}));
```

② 删除原第二个测试「名册面板导入调用 importRoster 并刷新」（importRoster 已改名且 UI 移入 RosterPanel.test），替换为：

```ts
  it("无常驻导入文本框残留（行内交互取代两段式导入，spec roster §4）", () => {
    const w = mount(AdminView);
    expect(w.find("button.import-roster").exists()).toBe(false);
    expect(adminApi.roster).toHaveBeenCalled();
  });
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/dashboard; npx vitest run src/__tests__/RosterPanel.test.ts src/__tests__/AdminView.test.ts`
Expected: FAIL —— RosterPanel.test 找不到 `.import-roster` 存在性断言（现组件仍有旧文本框）/选择器缺失。

- [ ] **Step 3: 重写 RosterPanel.vue**

`packages/dashboard/src/components/RosterPanel.vue` 整文件替换：

```vue
<script setup lang="ts">
import { ref } from "vue";
import type { RosterEntry } from "@classroom/shared";
import { adminApi } from "../api/admin";

const props = defineProps<{ roster: RosterEntry[] }>();
const emit = defineEmits<{ refreshed: [] }>();
const message = ref("");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// —— 行内改名（spec roster §4：姓名直接改；学号不可改）——
const editingId = ref<string | null>(null);
const editName = ref("");
function startEdit(r: RosterEntry) { editingId.value = r.studentId; editName.value = r.studentName; }
async function saveEdit(r: RosterEntry) {
  const name = editName.value.trim();
  editingId.value = null;
  if (!name || name === r.studentName) return;
  try {
    await adminApi.renameRosterEntry(r.studentId, name);
    message.value = `已改名：${r.studentId} → ${name}`;
    emit("refreshed");
  } catch (e) { message.value = `改名失败：${errMsg(e)}`; }
}

// —— 单条添加（底部固定添加行）——
const addId = ref("");
const addName = ref("");
async function addEntry() {
  const id = addId.value.trim(), name = addName.value.trim();
  if (!id || !name) { message.value = "请填写学号和姓名"; return; }
  try {
    await adminApi.addRosterEntry(id, name);
    message.value = `已添加 ${id} ${name}`;
    addId.value = ""; addName.value = "";
    emit("refreshed");
  } catch (e) { message.value = `添加失败：${errMsg(e)}`; }
}

// —— 批量添加：前端拆行逐条 POST entry（内网毫秒级，无需批量接口）——
const batchText = ref("");
const batchRunning = ref(false);
async function addBatch() {
  const lines = batchText.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) { message.value = "批量区为空"; return; }
  batchRunning.value = true;
  let ok = 0;
  const failed: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(\S+)\s+(\S.*)$/);
    if (!m) { failed.push(line); continue; }
    try { await adminApi.addRosterEntry(m[1], m[2].trim()); ok++; }
    catch { failed.push(line); }
  }
  batchRunning.value = false;
  batchText.value = failed.join("\n");   // 失败行留在批量区供修正重试
  message.value = `批量添加完成：成功 ${ok} 条${failed.length ? `，失败 ${failed.length} 条已留在批量区` : ""}`;
  if (ok > 0) emit("refreshed");
}

// —— 行操作：移出（软删除，无确认——凭证保留，重新导入可无缝复用）——
async function removeEntry(r: RosterEntry) {
  try {
    await adminApi.removeRosterEntry(r.studentId);
    message.value = `已移出 ${r.studentId}（Git 凭证保留，重新导入可无缝复用）`;
    emit("refreshed");
  } catch (e) { message.value = `移出失败：${errMsg(e)}`; }
}

// —— 行操作：彻底清除（purge，二次确认；文案明确删除 Gitea 账户与学生分支）——
async function purgeEntry(r: RosterEntry) {
  const ok = window.confirm(`彻底清除 ${r.studentId} ${r.studentName}？\n将删除其 Gitea 账户与 student-${r.studentId} 分支，提交历史不可恢复！`);
  if (!ok) return;
  try {
    await adminApi.purgeRosterEntry(r.studentId);
    message.value = `已彻底清除 ${r.studentId}`;
    emit("refreshed");
  } catch (e) { message.value = `清除失败：${errMsg(e)}`; }
}

// —— 学期换血：整表替换（走现有覆盖导入），弱化入口 + 红字警示 ——
const replaceText = ref("");
async function replaceAll() {
  try {
    const r = await adminApi.replaceRoster(replaceText.value);
    message.value = `已整表替换：${r.count} 人`;
    replaceText.value = "";
    emit("refreshed");
  } catch (e) { message.value = `整表替换失败：${errMsg(e)}`; }
}
</script>

<template>
  <section class="roster-panel">
    <h3>名册管理</h3>
    <div class="roster-table-wrap">
      <table class="roster-table">
        <thead><tr><th>学号</th><th>姓名</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="r in props.roster" :key="r.studentId">
            <td>{{ r.studentId }}</td>
            <td>
              <template v-if="editingId === r.studentId">
                <input class="edit-name" v-model="editName" @keyup.enter="saveEdit(r)" />
                <button class="save-edit" @click="saveEdit(r)">保存</button>
              </template>
              <template v-else><span class="name-text" @click="startEdit(r)">{{ r.studentName }}</span></template>
            </td>
            <td>
              <button class="remove-entry" @click="removeEntry(r)">移出</button>
              <button class="purge-entry" @click="purgeEntry(r)">彻底清除</button>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr class="add-row">
            <td><input class="add-id" v-model="addId" placeholder="学号" /></td>
            <td><input class="add-name" v-model="addName" placeholder="姓名" @keyup.enter="addEntry" /></td>
            <td><button class="add-entry" @click="addEntry">+ 添加学生</button></td>
          </tr>
        </tfoot>
      </table>
    </div>
    <span class="msg">{{ message }}</span>
    <details class="batch-add">
      <summary>批量添加（每行「学号 姓名」，逐条入册）</summary>
      <textarea class="batch-text" v-model="batchText" rows="4" placeholder="0001 张三&#10;0002 李四"></textarea>
      <button class="add-batch" :disabled="batchRunning" @click="addBatch">逐条添加</button>
    </details>
    <details class="replace-all">
      <summary>整表替换（学期换血）</summary>
      <p class="danger-text">⚠️ 覆盖式导入：现有名册整体删除替换；旧学号的 Gitea 账户与学生分支保留为档案。</p>
      <textarea class="replace-text" v-model="replaceText" rows="4" placeholder="0001 张三&#10;0002 李四"></textarea>
      <button class="replace-roster" @click="replaceAll">整表替换</button>
    </details>
  </section>
</template>
```

注：旧组件无 `<style>` 块（样式在全局 CSS），本次不新增样式；`.name-text` 默认可加 `cursor: pointer` 由执行者视全局 CSS 情况决定，非必需。

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/dashboard; npx vitest run src/__tests__/RosterPanel.test.ts src/__tests__/AdminView.test.ts`
Expected: PASS。再跑全套确认无回归：`cd packages/dashboard; npx vitest run`（AlertPanel.test.ts 为已知基线失败，与本计划无关，忽略）。

- [ ] **Step 5: 提交**

```powershell
git add packages/dashboard/src/components/RosterPanel.vue packages/dashboard/src/__tests__/RosterPanel.test.ts packages/dashboard/src/__tests__/AdminView.test.ts
git commit -m "feat: RosterPanel 行内优先交互——行内改名/添加行/批量逐条/移出/彻底清除二次确认/弱化整表替换；移除常驻导入文本框"
```

---

### Task 7: 扩展端 git 原语 resetToMainBaseline

**Files:**
- Modify: `d:/ruan/vscode-pylearner/src/git/branchOps.ts`
- Test: `d:/ruan/vscode-pylearner/src/test/git/branchOps.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `GitClient.run(args)`。
- Produces（Task 8 依赖，签名逐字）: `resetToMainBaseline(git: GitClient): Promise<void>` —— `fetch origin` → `reset --hard origin/main` → `clean -fdx -e .vscode`；任一步失败上抛（调用方负责中止）。

- [ ] **Step 1: 写失败测试**

`d:/ruan/vscode-pylearner/src/test/git/branchOps.test.ts` —— 顶部 import 行改为：

```ts
import { ensureStudentBranch, assertCurrentBranch, cleanIgnored, remoteStudentBranchExists, resetToMainBaseline } from "../../git/branchOps";
```

文件末尾追加：

```ts
describe("resetToMainBaseline（学期更替清空，spec roster §3.1）", () => {
  it("fetch → reset --hard origin/main → clean -fdx -e .vscode（比换机 -fdX 更彻底，排除 .vscode 保留运行配置）", async () => {
    const { calls, git } = makeRecorder([
      { match: cmd("fetch origin") },
      { match: cmd("reset --hard origin/main") },
      { match: cmd("clean -fdx -e .vscode") },
    ]);
    await resetToMainBaseline(git);
    expect(joined(calls)).toEqual(["fetch origin", "reset --hard origin/main", "clean -fdx -e .vscode"]);
  });
  it("reset 失败 → 上抛（调用方中止切换，不保存新身份，可重跑）", async () => {
    const { git } = makeRecorder([
      { match: cmd("fetch origin") },
      { match: cmd("reset --hard origin/main"), fail: { stderr: "error: cannot reset" } },
    ]);
    await expect(resetToMainBaseline(git)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run（`d:/ruan/vscode-pylearner` 下）: `npx vitest run src/test/git/branchOps.test.ts`
Expected: FAIL —— `resetToMainBaseline` 未导出。

- [ ] **Step 3: 实现**

`d:/ruan/vscode-pylearner/src/git/branchOps.ts` 末尾追加：

```ts
/** 学期更替清空（spec roster §3.1）：工作区回到 origin/main 全新基线。
 * clean -fdx 含 ignored 缓存（比换机路径的 -fdX 更彻底，学期更替语义=全新电脑）；-e .vscode 排除保留运行配置。
 * 未跟踪的学生自建文件将被清除——旧代码已在服务器分支归档，此语义已在确认弹窗向学生明示。 */
export async function resetToMainBaseline(git: GitClient): Promise<void> {
  await git.run(["fetch", "origin"]);
  await git.run(["reset", "--hard", "origin/main"]);
  await git.run(["clean", "-fdx", "-e", ".vscode"]);
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run src/test/git/branchOps.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交（扩展仓库）**

```powershell
git add src/git/branchOps.ts src/test/git/branchOps.test.ts
git commit -m "feat: 学期更替清空原语 resetToMainBaseline——reset --hard origin/main + clean -fdx -e .vscode"
```

---

### Task 8: switchFlow 学期更替编排 semesterResetBeforeSwitch

**Files:**
- Modify: `d:/ruan/vscode-pylearner/src/identity/switchFlow.ts`
- Test: `d:/ruan/vscode-pylearner/src/test/identity/switchFlow.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 7 的 `resetToMainBaseline`；现有 `NotifyFn`。
- Produces（Task 9/10 依赖，签名逐字）:

```ts
export interface SemesterResetDeps {
  git: GitClient;
  confirm: (info: { oldId: string; newId: string }) => Promise<boolean>;
  notify: NotifyFn;
}
export async function semesterResetBeforeSwitch(deps: SemesterResetDeps, oldId: string, newId: string): Promise<boolean>
```

返回 true = 工作区已清空到 main 基线，调用方可保存新身份；false = 用户取消或清空失败，调用方不得保存新身份。

- [ ] **Step 1: 写失败测试**

`d:/ruan/vscode-pylearner/src/test/identity/switchFlow.test.ts` —— 顶部 imports 补充（保留该文件既有 import）：

```ts
import { createGitClient, type ExecFn } from "../../git/gitClient";
import { semesterResetBeforeSwitch } from "../../identity/switchFlow";
```

文件末尾追加：

```ts
describe("semesterResetBeforeSwitch（学期更替三分叉，spec roster §3）", () => {
  function makeDeps(confirmResult: boolean, failOn?: string) {
    const calls: string[][] = [];
    const exec: ExecFn = async (_f, args) => {
      calls.push([...args]);
      if (failOn && args.join(" ") === failOn) throw new Error("git failed");
      return { stdout: "", stderr: "" };
    };
    const confirmed: Array<{ oldId: string; newId: string }> = [];
    const notes: string[] = [];
    return {
      calls, confirmed, notes,
      deps: {
        git: createGitClient("C:/ws", exec),
        confirm: async (info) => { confirmed.push(info); return confirmResult; },
        notify: (m: string, _warn: boolean) => { notes.push(m); },
      } as Parameters<typeof semesterResetBeforeSwitch>[0],
    };
  }

  it("确认 → 清空三连（fetch/reset/clean）→ true（调用方可保存新身份）", async () => {
    const { calls, confirmed, deps } = makeDeps(true);
    await expect(semesterResetBeforeSwitch(deps, "2025001", "2026001")).resolves.toBe(true);
    expect(confirmed).toEqual([{ oldId: "2025001", newId: "2026001" }]);
    expect(calls.map((c) => c.join(" "))).toEqual(["fetch origin", "reset --hard origin/main", "clean -fdx -e .vscode"]);
  });
  it("用户取消 → false，不执行任何 git 命令", async () => {
    const { calls, deps } = makeDeps(false);
    await expect(semesterResetBeforeSwitch(deps, "2025001", "2026001")).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
  it("reset 失败 → false + 告警提示可重试（中止，不保存新身份）", async () => {
    const { calls, notes, deps } = makeDeps(true, "reset --hard origin/main");
    await expect(semesterResetBeforeSwitch(deps, "2025001", "2026001")).resolves.toBe(false);
    expect(calls.map((c) => c.join(" "))).toEqual(["fetch origin", "reset --hard origin/main"]);   // clean 未执行
    expect(notes[0]).toContain("重置失败");
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run src/test/identity/switchFlow.test.ts`
Expected: FAIL —— `semesterResetBeforeSwitch` 未导出。

- [ ] **Step 3: 实现**

`d:/ruan/vscode-pylearner/src/identity/switchFlow.ts` —— 顶部 import 补 `resetToMainBaseline`：

```ts
import { ensureStudentBranch, cleanIgnored, remoteStudentBranchExists, resetToMainBaseline } from "../git/branchOps";
```

文件末尾（`refillAfterSwitch` 之后）追加：

```ts
export interface SemesterResetDeps {
  git: GitClient;
  confirm: (info: { oldId: string; newId: string }) => Promise<boolean>;
  notify: NotifyFn;
}

/** 学期更替切换（spec roster §3 三分叉之一）：旧学号已不在名册 → 不走归档（旧身份无凭证可归档），
 * 确认后清空工作区回 origin/main 基线。返回 false = 中止（用户取消或清空失败），调用方不得保存新身份。 */
export async function semesterResetBeforeSwitch(deps: SemesterResetDeps, oldId: string, newId: string): Promise<boolean> {
  if (!(await deps.confirm({ oldId, newId }))) return false;
  try {
    await resetToMainBaseline(deps.git);
  } catch (e) {
    deps.notify(`重置失败：${errMsg(e)}，身份未切换，可重试`, true);
    return false;
  }
  return true;
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run src/test/identity/switchFlow.test.ts`
Expected: PASS（既有 archiveBeforeSwitch/refillAfterSwitch 用例不回归）。

- [ ] **Step 5: 提交（扩展仓库）**

```powershell
git add src/identity/switchFlow.ts src/test/identity/switchFlow.test.ts
git commit -m "feat: 学期更替编排 semesterResetBeforeSwitch——确认+清空工作区，失败中止不保存新身份"
```

---

### Task 9: identityPage 三分叉切换 + previousStudentId 上送

**Files:**
- Modify: `d:/ruan/vscode-pylearner/src/identity/identityPage.ts`（IdentityPageDeps 类型 + onDidReceiveMessage 处理段 L51-91）
- Test: `d:/ruan/vscode-pylearner/src/test/identity/identityPage.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 4 的响应字段 `previousIdInRoster?`；Task 8 的 `semesterResetBeforeSwitch`（经 deps 注入，本文件不直接 import）。
- Produces:
  - `IdentityPageDeps.switchFlow` 类型增加可选 `semesterReset?: (oldId: string, newId: string) => Promise<boolean>`（true=已清空可继续；false/未接线=中止）
  - validate 请求体在旧身份存在时附带 `previousStudentId`
  - 三分叉：`oldId=null` → F1（现状）；`previousIdInRoster===false` → semesterReset → 保存 → afterSwitch；其余（true 或缺省=旧服务端兼容）→ beforeSwitch 归档（现状）

- [ ] **Step 1: 写失败测试**

`d:/ruan/vscode-pylearner/src/test/identity/identityPage.test.ts` 末尾追加：

```ts
describe("三分叉切换（spec roster §3：名册感知）", () => {
  it("旧身份存在时 validate 请求体携带 previousStudentId", async () => {
    const store = makeStore();
    await store.update("pylearner.identity.studentId", "2025001");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, gitSecret: "tok-A" }), { status: 200 }));
    await submit(makeDeps(fetchImpl), store, "2025001", "张三");   // 同学号重存也带
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].body).toBe(
      JSON.stringify({ studentId: "2025001", studentName: "张三", previousStudentId: "2025001" }));
  });

  it("previousIdInRoster=false → semesterReset → 保存新身份 → afterSwitch（不触碰 beforeSwitch 归档）", async () => {
    const order: string[] = [];
    const store = makeStore();
    await store.update("pylearner.identity.studentId", "2025001");   // 旧学号（已不在名册）
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, gitSecret: "tok-B", previousIdInRoster: false }), { status: 200 }));
    const deps: IdentityPageDeps = {
      ...makeDeps(fetchImpl),
      switchFlow: {
        beforeSwitch: async () => { order.push("beforeSwitch"); return true; },
        afterSwitch: async () => { order.push("afterSwitch"); },
        semesterReset: async () => { order.push("semesterReset"); return true; },
      },
    };
    const { secrets } = await submit(deps, store, "2026001", "李四");

    expect(order).toEqual(["semesterReset", "afterSwitch"]);   // 死锁修复：不再走 beforeSwitch 归档
    expect(secrets.stored.get("pylearner.git.secret")).toBe("tok-B");
    expect(store.data.get("pylearner.identity.studentId")).toBe("2026001");
    const h = await getHooks();
    const last = h.postMessage.mock.calls.at(-1)![0] as { ok: boolean; message: string };
    expect(last.ok).toBe(true);
  });

  it("previousIdInRoster=false + semesterReset 返回 false → 中止：身份不保存、不走 afterSwitch", async () => {
    const order: string[] = [];
    const store = makeStore();
    await store.update("pylearner.identity.studentId", "2025001");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, gitSecret: "tok-B", previousIdInRoster: false }), { status: 200 }));
    const deps: IdentityPageDeps = {
      ...makeDeps(fetchImpl),
      switchFlow: {
        beforeSwitch: async () => { order.push("beforeSwitch"); return true; },
        afterSwitch: async () => { order.push("afterSwitch"); },
        semesterReset: async () => { order.push("semesterReset"); return false; },
      },
    };
    const { secrets } = await submit(deps, store, "2026001", "李四");

    expect(order).toEqual(["semesterReset"]);
    expect(secrets.stored.size).toBe(0);
    expect(store.data.get("pylearner.identity.studentId")).toBe("2025001");   // 旧身份保留
  });

  it("previousIdInRoster=false 但 semesterReset 未接线 → 安全中止（不误入归档死锁）", async () => {
    const order: string[] = [];
    const store = makeStore();
    await store.update("pylearner.identity.studentId", "2025001");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, gitSecret: "tok-B", previousIdInRoster: false }), { status: 200 }));
    const deps: IdentityPageDeps = {
      ...makeDeps(fetchImpl),
      switchFlow: {
        beforeSwitch: async () => { order.push("beforeSwitch"); return true; },
        afterSwitch: async () => { order.push("afterSwitch"); },
      },
    };
    await submit(deps, store, "2026001", "李四");
    expect(order).toEqual([]);   // 中止，未保存
    expect(store.data.get("pylearner.identity.studentId")).toBe("2025001");
  });

  it("previousIdInRoster=true → 现有一键换机（beforeSwitch 归档链路不变）", async () => {
    const order: string[] = [];
    const store = makeStore();
    await store.update("pylearner.identity.studentId", "2025001");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, gitSecret: "tok-B", previousIdInRoster: true }), { status: 200 }));
    const deps: IdentityPageDeps = {
      ...makeDeps(fetchImpl),
      switchFlow: {
        beforeSwitch: async () => { order.push("beforeSwitch"); return true; },
        afterSwitch: async () => { order.push("afterSwitch"); },
        semesterReset: async () => { order.push("semesterReset"); return true; },
      },
    };
    await submit(deps, store, "2025002", "李四");
    expect(order).toEqual(["beforeSwitch", "afterSwitch"]);   // 正常换机不走清空
  });

  it("previousIdInRoster 缺省（旧服务端）→ 降级走 beforeSwitch（向后兼容）", async () => {
    const order: string[] = [];
    const store = makeStore();
    await store.update("pylearner.identity.studentId", "2025001");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, gitSecret: "tok-B" }), { status: 200 }));   // 无该字段
    const deps: IdentityPageDeps = {
      ...makeDeps(fetchImpl),
      switchFlow: {
        beforeSwitch: async () => { order.push("beforeSwitch"); return true; },
        afterSwitch: async () => { order.push("afterSwitch"); },
        semesterReset: async () => { order.push("semesterReset"); return true; },
      },
    };
    await submit(deps, store, "2025002", "李四");
    expect(order).toEqual(["beforeSwitch", "afterSwitch"]);
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run src/test/identity/identityPage.test.ts`
Expected: FAIL —— 请求体缺 `previousStudentId`；`previousIdInRoster=false` 用例走不到 semesterReset。

- [ ] **Step 3: 实现**

`d:/ruan/vscode-pylearner/src/identity/identityPage.ts`：

① `IdentityPageDeps.switchFlow` 类型改为：

```ts
  switchFlow?: {
    beforeSwitch: (oldId: string, newId: string) => Promise<boolean>;
    afterSwitch: (newId: string) => Promise<void>;
    /** 学期更替（spec roster §3）：previousIdInRoster=false 时触发；确认+清空工作区。
     * true=已清空可继续；false=中止。未接线时该分叉安全降级为中止（不误入归档死锁）。 */
    semesterReset?: (oldId: string, newId: string) => Promise<boolean>;
  };
```

② `onDidReceiveMessage` 处理段：把 `const doFetch = deps.fetchImpl ?? fetch;` 到 `if (isSwitch && flow) { ... }` 的整段（现 L61-91）替换为：

```ts
    const doFetch = deps.fetchImpl ?? fetch;
    // 先读旧身份：validate 请求携带 previousStudentId，服务端据此裁决 previousIdInRoster（spec roster §2）
    const oldId = loadStudentIdentity(context.globalState).studentId;
    try {
      const res = await doFetch(`${deps.teacherUrl()}/api/identity/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, studentName, ...(oldId ? { previousStudentId: oldId } : {}) }),
      });
      const body = await res.json() as { ok?: boolean; studentName?: string; code?: string; gitSecret?: string | null; previousIdInRoster?: boolean };
      if (res.ok && body.ok) {
        const identity = { studentId, studentName: body.studentName ?? studentName };
        const flow = deps.switchFlow;
        const isSwitch = flow !== undefined && oldId !== identity.studentId;
        if (isSwitch && flow) {
          if (oldId !== null) {
            if (body.previousIdInRoster === false) {
              // 学期更替（spec roster §3）：旧学号已不在名册 → 不归档（无凭证可归档），确认后清空工作区
              const ok = flow.semesterReset ? await flow.semesterReset(oldId, identity.studentId) : false;
              if (!ok) {
                currentPanel?.webview.postMessage({ type: "result", ok: false, message: "已取消或重置未完成，身份未切换，工作区已保留" });
                return;
              }
            } else {
              // 现有一键换机：previousIdInRoster=true，或字段缺省（旧服务端向后兼容）
              const ok = await flow.beforeSwitch(oldId, identity.studentId);
              if (!ok) {
                currentPanel?.webview.postMessage({ type: "result", ok: false, message: "已取消或归档未完成，身份未切换，工作区已保留" });
                return;
              }
            }
          }
          // 归档/清空成功后才存新 gitSecret（beforeSwitch 推旧分支必须用旧凭证）
          await storeGitSecret(context, body.gitSecret);
          await saveStudentIdentity(context.globalState, identity);
          await flow.afterSwitch(identity.studentId);
        } else {
          await storeGitSecret(context, body.gitSecret);   // 同学号重存 = 补领/刷新凭证
          await saveStudentIdentity(context.globalState, identity);   // A25：校验通过才保存（名册规范姓名）
        }
```

③ 其余部分（保存成功 postMessage、gitSecret 缺失提示、离线兜底 catch、HTML）**保持不变**。

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run src/test/identity/identityPage.test.ts`
Expected: PASS（既有离线兜底/gitSecret/换机用例全部不回归——它们不带 previousIdInRoster，走 beforeSwitch 分支）。

- [ ] **Step 5: 提交（扩展仓库）**

```powershell
git add src/identity/identityPage.ts src/test/identity/identityPage.test.ts
git commit -m "feat: 身份页名册感知三分叉——previousStudentId 上送，学期更替走清空而非归档（死锁修复）"
```

---

### Task 10: extension.ts 装配 semesterReset

**Files:**
- Modify: `d:/ruan/vscode-pylearner/src/extension.ts`（L50 import、L302-333 identityDeps.switchFlow）

**Interfaces:**
- Consumes: Task 8 的 `semesterResetBeforeSwitch`；现有 `resolveGitEnv` / `switchNotify` / `loadStudentIdentity`。
- Produces: identityDeps.switchFlow 完整接线（beforeSwitch/afterSwitch/semesterReset 三入口齐备）。

- [ ] **Step 1: 修改 import（L50）**

```ts
import { archiveBeforeSwitch, refillAfterSwitch, semesterResetBeforeSwitch } from "./identity/switchFlow";
```

- [ ] **Step 2: identityDeps.switchFlow 增加 semesterReset（`afterSwitch` 之后）**

```ts
      // 学期更替（spec roster §3）：旧学号已不在名册 → 确认后清空工作区（不归档，修复无凭证死锁）
      semesterReset: async (oldId: string, newId: string) => {
        const env = await resolveGitEnv();
        if (!env) return false;
        return semesterResetBeforeSwitch(
          {
            git: env.git,
            confirm: async ({ oldId: o, newId: n }) => {
              const pick = await vscode.window.showWarningMessage(
                `检测到学期更替：${o} 已不在当前名册。\n` +
                `将把工作区清空重置为全新状态（未提交的本地修改将丢失，旧代码已在服务器分支归档），然后初始化 ${n} 的学习环境。`,
                { modal: true },
                "确认清空并切换"   // 隐式取消由 VS Code 模态框自动追加，不得显式再加取消按钮
              );
              return pick === "确认清空并切换";
            },
            notify: switchNotify,
          },
          oldId,
          newId,
        );
      },
```

- [ ] **Step 3: 验证**

Run（`d:/ruan/vscode-pylearner` 下）: `npx tsc --noEmit`
Expected: 无类型错误（若项目引用报错，改用 `npx tsc -b --noEmit`）。

Run: `npx vitest run`
Expected: 全部 PASS（无回归）。

- [ ] **Step 4: 提交（扩展仓库）**

```powershell
git add src/extension.ts
git commit -m "feat: 扩展装配学期更替 semesterReset——模态确认+清空编排接入身份页三分叉"
```

---

### Task 11: 全量回归 + 手动验证

**Files:** 无代码改动（回归与验收）。

**Interfaces:**
- Consumes: Task 1-10 全部产出。
- Produces: 回归结论 + 手动验收记录。

- [ ] **Step 1: 服务端全量测试（确认 dev server 已停）**

Run: `cd packages/server; npx vitest run`
Expected: 全部 PASS。

- [ ] **Step 2: 仪表盘全量测试**

Run: `cd packages/dashboard; npx vitest run`
Expected: 除已知基线失败 `AlertPanel.test.ts`（classroom snapshot，与本计划无关）外全部 PASS。

- [ ] **Step 3: 类型检查**

Run: `cd packages/server; npx tsc --noEmit; cd ../../packages/dashboard; npx vue-tsc -b`
Expected: 无错误。

- [ ] **Step 4: 扩展端全量测试**

Run（`d:/ruan/vscode-pylearner` 下）: `npx vitest run`
Expected: 全部 PASS。

- [ ] **Step 5: 手动回归（需打包重装扩展：`npm run compile` 后 VSIX 重装，窗口热重载不生效）**

按 spec §5 清单：
1. **死锁场景正向化**：名册只含新学号 → 学生机残留旧学期身份 → 身份页输入新学号+姓名 → 应弹「学期更替」模态 → 确认后工作区清空（.vscode 保留）→ 身份保存 → 分支保障+拉取作业一次通过。此前该场景必然卡死（"已取消或归档未完成"）。
2. **正常换机**：新旧学号都在名册 → 走现有归档链路（beforeSwitch），代码不丢。
3. **同学号重存**：无切换、无清空，补领凭证。
4. **RosterPanel**：行内改名、添加行、批量粘贴（含坏行留区）、移出后重新导入（token 无缝复用）、彻底清除（二次确认、Gitea 账户+分支消失）、整表替换。

- [ ] **Step 6: 如有修复，补充提交**

```powershell
git add <修复的文件>
git commit -m "fix: <回归发现的问题>"
```

---

## 任务依赖图

```
Task 0（前置）
  └─ Task 1 (persistence) ─┐
  └─ Task 2 (purgeStudent) ─┴─→ Task 3 (路由) → Task 4 (validate)   [server]
                                     │
                                     ↓
                               Task 5 (admin API) → Task 6 (RosterPanel)   [dashboard]
  └─ Task 7 (resetToMainBaseline) → Task 8 (semesterReset) → Task 9 (identityPage) → Task 10 (装配)   [extension]
                                     └────────── Task 11（全量回归）←────────┘
```

server 链与扩展链相互独立，可并行推进；dashboard 依赖 server 路由契约（Task 3）定稿。
