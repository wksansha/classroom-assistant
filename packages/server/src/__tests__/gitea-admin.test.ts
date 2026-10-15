import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createGiteaAdmin } from "../gitea/adminApi";
import { createPersistence } from "../persistence";
import { registerRosterRoutes } from "../routes/roster";

type FakeCall = { method: string; url: string; body?: any };

/**
 * fake Gitea（按真实联动语义模拟）：
 * - POST /admin/users 建号 → 201（userCreateStatus 可注入异常/已存在状态码）
 * - PATCH /admin/users/<id> 改密 → 200（patchStatus 可注入）
 * - 建号 / 分支保护默认 201
 * - token API 已弃用（Gitea 不允许 token 认证建 token，401 死路）：fake 不再提供该端点，测试断言全程零 token 调用
 */
function fakeGitea(opts?: { userCreateStatus?: number; patchStatus?: number; collabStatus?: number }) {
  const calls: FakeCall[] = [];
  const f: typeof fetch = async (url, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const u = String(url);
    if (u.includes("/admin/users")) {
      if ((init?.method ?? "GET") === "PATCH") return new Response("{}", { status: opts?.patchStatus ?? 200 });
      return new Response("{}", { status: opts?.userCreateStatus ?? 201 });
    }
    if (u.includes("/collaborators/")) return new Response(null, { status: opts?.collabStatus ?? 204 });   // 协作者授权成功（204 无 body：Response 构造要求 null）
    if (u.includes("branch_protections")) return new Response("{}", { status: 201 });
    return new Response("{}", { status: 200 });
  };
  return { calls, f };
}

const baseDeps = { baseUrl: "http://gitea.test", adminToken: "admin-tok", repo: "classroom/exercises" };

/** 建号异步执行（void promise，不阻塞响应）→ 轮询等待条件成立 */
async function until(cond: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("Gitea 管理联动", () => {
  it("ensureStudentAccount：建号携带密码 + 无条件 PATCH 收敛 → 返回 gitSecret；不再调用 token API", async () => {
    const { calls, f } = fakeGitea();
    const admin = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    const gitSecret = await admin.ensureStudentAccount("0001");

    // 密码格式：base64url（字母数字+-_），不含 URL 特殊字符 :/@?#
    expect(gitSecret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(gitSecret).not.toMatch(/[:/@?#]/);

    // 建号：POST /api/v1/admin/users，用户名=学号，body.password=返回值
    const create = calls.find((c) => c.method === "POST" && c.url === "http://gitea.test/api/v1/admin/users");
    expect(create).toBeDefined();
    expect(create!.body.username).toBe("0001");
    expect(create!.body.email).toBe("0001@classroom.local");
    expect(create!.body.full_name).toBe("0001");
    expect(create!.body.must_change_password).toBe(false);
    expect(create!.body.password).toBe(gitSecret);

    // 无条件 PATCH：/api/v1/admin/users/0001，body={password: 生成值}（已存在用户也收敛）
    const patch = calls.find((c) => c.method === "PATCH" && c.url === "http://gitea.test/api/v1/admin/users/0001");
    expect(patch).toBeDefined();
    expect(patch!.body).toEqual({ password: gitSecret });

    // token API 死路已弃用：全程无任何 token 调用
    expect(calls.filter((c) => c.url.includes("/tokens"))).toHaveLength(0);
  });

  it("ensureStudentAccount：建号 409/422（已存在）容忍，PATCH 照常收敛返回密码", async () => {
    for (const status of [409, 422]) {
      const { calls, f } = fakeGitea({ userCreateStatus: status });
      const admin = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
      const gitSecret = await admin.ensureStudentAccount("0001");
      expect(gitSecret).toMatch(/^[A-Za-z0-9_-]+$/);
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "http://gitea.test/api/v1/admin/users/0001");
      expect(patch!.body).toEqual({ password: gitSecret });
    }
  });

  it("ensureStudentAccount：PATCH 404 容忍（建号后用户异常缺失不炸联动），仍返回密码", async () => {
    const { f } = fakeGitea({ patchStatus: 404 });
    const admin = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    await expect(admin.ensureStudentAccount("0001")).resolves.toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("protectBranch：POST branch_protections，rule_name=student-0001 即分支匹配模式（Gitea 28），不含 branch_name", async () => {
    const { calls, f } = fakeGitea();
    const admin = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    await admin.protectBranch("0001");
    const c = calls.find((x) => x.url.includes("branch_protections"));
    expect(c).toBeDefined();
    expect(c!.method).toBe("POST");
    expect(c!.url).toBe("http://gitea.test/api/v1/repos/classroom/exercises/branch_protections");
    expect(c!.body).toEqual({
      rule_name: "student-0001",   // rule_name 即分支模式（字面分支名 student-XXXX）
      enable_push: true,
      enable_push_whitelist: true,
      push_whitelist_usernames: ["0001"],
    });
    expect(c!.body.branch_name).toBeUndefined();   // branch_name 已废弃，不得出现
  });

  it("addCollaborator：PUT collaborators/0001 body.permission=write；409（已是协作者）容忍", async () => {
    for (const status of [204, 409]) {
      const { calls, f } = fakeGitea({ collabStatus: status });
      const admin = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
      await expect(admin.addCollaborator("0001")).resolves.toBeUndefined();
      const c = calls.find((x) => x.url.includes("/collaborators/"));
      expect(c).toBeDefined();
      expect(c!.method).toBe("PUT");
      expect(c!.url).toBe("http://gitea.test/api/v1/repos/classroom/exercises/collaborators/0001");
      expect(c!.body).toEqual({ permission: "write" });
    }
  });

  it("addCollaborator：500 → 抛错（仅 204/200/409 容忍）", async () => {
    const { f } = fakeGitea({ collabStatus: 500 });
    const admin = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    await expect(admin.addCollaborator("0001")).rejects.toThrow("gitea collaborator add failed: 500");
  });

  it("用户创建 500 → 抛错（非 409/422 不容忍）", async () => {
    const { f } = fakeGitea({ userCreateStatus: 500 });
    const admin = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    await expect(admin.ensureStudentAccount("0001")).rejects.toThrow("gitea user create failed: 500");
  });

  it("roster 导入联动：逐生建号+保护+gitSecret 入库（student_tokens 两行）；validate 响应含 gitSecret", async () => {
    const persistence = createPersistence(":memory:");
    const { calls, f } = fakeGitea();
    const gitea = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    const app = express();
    app.use(express.json());
    registerRosterRoutes(app, { persistence, gitea });

    await request(app).post("/api/roster").send({ text: "0001 张三\n0002 李四" }).expect(200, { ok: true, count: 2 });

    // 建号异步执行 → 轮询到两生 gitSecret 全部入库（student_tokens 出现两行）
    await until(() => persistence.getStudentToken("0001") !== null && persistence.getStudentToken("0002") !== null);
    // 入库值 = 该生 PATCH 收敛的密码（student_tokens 表沿用，值语义=gitSecret）
    for (const sid of ["0001", "0002"]) {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === `http://gitea.test/api/v1/admin/users/${sid}`);
      expect(patch).toBeDefined();
      expect(persistence.getStudentToken(sid)).toBe(patch!.body.password);
    }
    expect(calls.filter((c) => c.url.includes("branch_protections"))).toHaveLength(2);   // 每生一条分支保护
    expect(calls.filter((c) => c.method === "PUT" && c.url.includes("/collaborators/"))).toHaveLength(2);   // 每生一条协作者授权
    expect(calls.filter((c) => c.url.includes("/tokens"))).toHaveLength(0);              // 全程零 token API 调用

    // validate 响应下发 gitSecret
    const v = await request(app).post("/api/identity/validate").send({ studentId: "0001", studentName: "张三" }).expect(200);
    expect(v.body).toEqual({ ok: true, studentName: "张三", gitSecret: persistence.getStudentToken("0001") });
  });

  it("validate：未建号/离线场景 → gitSecret 为 null；未注入 gitea 时导入照常成功（不报错）", async () => {
    const persistence = createPersistence(":memory:");
    const app = express();
    app.use(express.json());
    registerRosterRoutes(app, { persistence });   // 等价环境变量未配置：跳过联动
    await request(app).post("/api/roster").send({ text: "0001 张三" }).expect(200, { ok: true, count: 1 });
    const v = await request(app).post("/api/identity/validate").send({ studentId: "0001", studentName: "张三" }).expect(200);
    expect(v.body).toEqual({ ok: true, studentName: "张三", gitSecret: null });
  });

  it("F4 重复导入：已有 gitSecret 的学生跳过 ensureStudentAccount（密码不轮换），分支保护仍幂等执行", async () => {
    const persistence = createPersistence(":memory:");
    const { calls, f } = fakeGitea();
    const gitea = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    const app = express();
    app.use(express.json());
    registerRosterRoutes(app, { persistence, gitea });

    // 首次导入：逐生建号 + gitSecret 入库
    await request(app).post("/api/roster").send({ text: "0001 张三\n0002 李四" }).expect(200);
    await until(() => persistence.getStudentToken("0001") !== null && persistence.getStudentToken("0002") !== null);
    const creates1 = calls.filter((c) => c.method === "POST" && c.url === "http://gitea.test/api/v1/admin/users").length;
    const patches1 = calls.filter((c) => c.method === "PATCH").length;
    const secret1 = persistence.getStudentToken("0001");
    expect(creates1).toBe(2);
    expect(patches1).toBe(2);

    // 重复导入同一名册
    await request(app).post("/api/roster").send({ text: "0001 张三\n0002 李四" }).expect(200);
    await until(() => calls.filter((c) => c.url.includes("branch_protections")).length >= 4);

    // 密码不轮换：无新建号/无新 PATCH，库中 gitSecret 保持原值
    expect(calls.filter((c) => c.method === "POST" && c.url === "http://gitea.test/api/v1/admin/users")).toHaveLength(creates1);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(patches1);
    expect(persistence.getStudentToken("0001")).toBe(secret1);
    expect(calls.filter((c) => c.url.includes("/tokens"))).toHaveLength(0);   // 全程零 token API 调用
    // 分支保护幂等照常执行（每生再各一条）
    expect(calls.filter((c) => c.url.includes("branch_protections")).length).toBe(4);
  });
});
