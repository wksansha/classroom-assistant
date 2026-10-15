import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createGiteaAdmin } from "../gitea/adminApi";
import { createPersistence } from "../persistence";
import { registerRosterRoutes } from "../routes/roster";

type FakeCall = { method: string; url: string; body?: any };

/**
 * fake Gitea（按真实联动语义模拟）：
 * - token URL 首次 POST → 422（同名 token 已存在）；同 URL 第二次 POST（删旧重建）→ 201 + sha1
 * - 建号 / 分支保护默认 201；userCreateStatus 可注入异常状态码
 */
function fakeGitea(opts?: { userCreateStatus?: number }) {
  const calls: FakeCall[] = [];
  const f: typeof fetch = async (url, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const u = String(url);
    if (u.includes("/tokens")) {
      const priorPosts = calls.filter((c) => c.url === u && c.method === "POST").length;
      if (priorPosts > 1) return new Response(JSON.stringify({ sha1: "tok-new" }), { status: 201 });   // 重建成功
      return new Response("{}", { status: 422 });   // 首建：同名 token 已存在
    }
    if (u.includes("/admin/users")) return new Response("{}", { status: opts?.userCreateStatus ?? 201 });
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
  it("ensureStudentAccount：用户 422（已存在）容忍；token 首建 422 → 删旧重建 → 返回 sha1", async () => {
    const { calls, f } = fakeGitea();
    const admin = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    const token = await admin.ensureStudentAccount("0001");
    expect(token).toBe("tok-new");

    // 建号：POST /api/v1/admin/users，用户名=学号
    const create = calls.find((c) => c.method === "POST" && c.url === "http://gitea.test/api/v1/admin/users");
    expect(create).toBeDefined();
    expect(create!.body.username).toBe("0001");
    expect(create!.body.email).toBe("0001@classroom.local");
    expect(create!.body.full_name).toBe("0001");
    expect(create!.body.must_change_password).toBe(false);
    expect(typeof create!.body.password).toBe("string");

    // token 首建 + 重建共两次 POST，body 含 name/scopes
    const tokenPosts = calls.filter((c) => c.method === "POST" && c.url === "http://gitea.test/api/v1/users/0001/tokens");
    expect(tokenPosts).toHaveLength(2);
    expect(tokenPosts[0].body).toEqual({ name: "classroom-0001", scopes: ["write:repository", "read:repository"] });
    expect(tokenPosts[1].body).toEqual({ name: "classroom-0001", scopes: ["write:repository", "read:repository"] });

    // 删旧 token：DELETE /api/v1/users/0001/tokens/classroom-0001
    const del = calls.find((c) => c.method === "DELETE");
    expect(del).toBeDefined();
    expect(del!.url).toBe("http://gitea.test/api/v1/users/0001/tokens/classroom-0001");
  });

  it("protectBranch：POST branch_protections，body 含 branch_name=student-0001 且 push_whitelist_usernames=[0001]", async () => {
    const { calls, f } = fakeGitea();
    const admin = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    await admin.protectBranch("0001");
    const c = calls.find((x) => x.url.includes("branch_protections"));
    expect(c).toBeDefined();
    expect(c!.method).toBe("POST");
    expect(c!.url).toBe("http://gitea.test/api/v1/repos/classroom/exercises/branch_protections");
    expect(c!.body).toEqual({
      branch_name: "student-0001",
      rule_name: "only-0001",
      enable_push: true,
      enable_push_whitelist: true,
      push_whitelist_usernames: ["0001"],
    });
  });

  it("用户创建 500 → 抛错（非 422 不容忍）", async () => {
    const { f } = fakeGitea({ userCreateStatus: 500 });
    const admin = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    await expect(admin.ensureStudentAccount("0001")).rejects.toThrow("gitea user create failed: 500");
  });

  it("roster 导入联动：逐生建号+保护+token 入库（student_tokens 两行）；validate 响应含 gitToken", async () => {
    const persistence = createPersistence(":memory:");
    const { calls, f } = fakeGitea();
    const gitea = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    const app = express();
    app.use(express.json());
    registerRosterRoutes(app, { persistence, gitea });

    await request(app).post("/api/roster").send({ text: "0001 张三\n0002 李四" }).expect(200, { ok: true, count: 2 });

    // 建号异步执行 → 轮询到两生 token 全部入库（student_tokens 出现两行）
    await until(() => persistence.getStudentToken("0001") !== null && persistence.getStudentToken("0002") !== null);
    expect(persistence.getStudentToken("0001")).toBe("tok-new");
    expect(persistence.getStudentToken("0002")).toBe("tok-new");
    expect(calls.filter((c) => c.url.includes("branch_protections"))).toHaveLength(2);   // 每生一条分支保护

    // validate 响应追加 gitToken（下发该生专属 token）
    const v = await request(app).post("/api/identity/validate").send({ studentId: "0001", studentName: "张三" }).expect(200);
    expect(v.body).toEqual({ ok: true, studentName: "张三", gitToken: "tok-new" });
  });

  it("validate：未建号/离线场景 → gitToken 为 null；未注入 gitea 时导入照常成功（不报错）", async () => {
    const persistence = createPersistence(":memory:");
    const app = express();
    app.use(express.json());
    registerRosterRoutes(app, { persistence });   // 等价环境变量未配置：跳过联动
    await request(app).post("/api/roster").send({ text: "0001 张三" }).expect(200, { ok: true, count: 1 });
    const v = await request(app).post("/api/identity/validate").send({ studentId: "0001", studentName: "张三" }).expect(200);
    expect(v.body).toEqual({ ok: true, studentName: "张三", gitToken: null });
  });

  it("F4 重复导入：已有 token 的学生跳过 ensureStudentAccount（token 不轮换），分支保护仍幂等执行", async () => {
    const persistence = createPersistence(":memory:");
    const { calls, f } = fakeGitea();
    const gitea = createGiteaAdmin({ ...baseDeps, fetchImpl: f });
    const app = express();
    app.use(express.json());
    registerRosterRoutes(app, { persistence, gitea });

    // 首次导入：逐生建号 + token 入库
    await request(app).post("/api/roster").send({ text: "0001 张三\n0002 李四" }).expect(200);
    await until(() => persistence.getStudentToken("0001") !== null && persistence.getStudentToken("0002") !== null);
    const tokenPosts1 = calls.filter((c) => c.method === "POST" && c.url.includes("/tokens")).length;
    const protects1 = calls.filter((c) => c.url.includes("branch_protections")).length;
    expect(tokenPosts1).toBeGreaterThan(0);

    // 重复导入同一名册
    await request(app).post("/api/roster").send({ text: "0001 张三\n0002 李四" }).expect(200);
    await until(() => calls.filter((c) => c.url.includes("branch_protections")).length >= protects1 + 2);

    // token 未轮换：无任何新 token API 调用，库中 token 保持原值
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/tokens")).length).toBe(tokenPosts1);
    expect(calls.filter((c) => c.method === "DELETE" && c.url.includes("/tokens"))).toHaveLength(2);   // 仅首建的删旧重建
    expect(persistence.getStudentToken("0001")).toBe("tok-new");
    expect(persistence.getStudentToken("0002")).toBe("tok-new");
    // 分支保护幂等照常执行（每生再各一条）
    expect(calls.filter((c) => c.url.includes("branch_protections")).length).toBe(protects1 + 2);
  });
});
