import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { createPersistence } from "../persistence";
import { createTeacherHub } from "../teacherHub";
import { registerRosterRoutes } from "../routes/roster";
import { createGiteaAdmin } from "../gitea/adminApi";

function makeApp() {
  const persistence = createPersistence(":memory:");
  const app: Express = express();
  app.use(express.json({ limit: "2mb" }));
  registerRosterRoutes(app, { persistence });
  return { app, persistence };
}

describe("名册与身份校验（A16/A25）", () => {
  it("导入（覆盖式、跳过坏行）→ 列表；空文本 400", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "0001 张三\n0002 李四\n坏行没有姓名分隔\n\n0003 王五" }).expect(200, { ok: true, count: 3 });
    await request(app).get("/api/roster").expect(200, [
      { studentId: "0001", studentName: "张三" },
      { studentId: "0002", studentName: "李四" },
      { studentId: "0003", studentName: "王五" },
    ]);
    await request(app).post("/api/roster").send({ text: "" }).expect(400);
  });
  it("identity/validate 四分支", async () => {
    const { app } = makeApp();
    await request(app).post("/api/identity/validate").send({ studentId: "0001", studentName: "张三" })
      .expect(400, { code: "roster_empty", message: "教师尚未导入名册，请联系教员后再试" });
    await request(app).post("/api/roster").send({ text: "0001 张三" }).expect(200);
    await request(app).post("/api/identity/validate").send({ studentId: "9999", studentName: "张三" })
      .expect(400, { code: "student_id_not_found", message: "学号输入有误，请检查或联系教员" });
    await request(app).post("/api/identity/validate").send({ studentId: "0001", studentName: "李四" })
      .expect(400, { code: "name_mismatch", message: "姓名与该学号不匹配，请检查或联系教员" });
    await request(app).post("/api/identity/validate").send({ studentId: " 0001 ", studentName: " 张三 " })
      .expect(200, { ok: true, studentName: "张三", gitSecret: null });   // trim + 返回规范姓名 + gitSecret（学生分支直连模型）
  });
  it("identity/validate 下发 gitRepoUrl（GITEA_PUBLIC_BASE+GITEA_REPO，尾斜杠归一；未配置不下发）", async () => {
    process.env.GITEA_PUBLIC_BASE = "http://192.168.1.100:3001/";
    process.env.GITEA_REPO = "classroom/exercises";
    try {
      const { app } = makeApp();
      await request(app).post("/api/roster").send({ text: "0001 张三" }).expect(200);
      await request(app).post("/api/identity/validate").send({ studentId: "0001", studentName: "张三" })
        .expect(200, {
          ok: true, studentName: "张三", gitSecret: null,
          gitRepoUrl: "http://192.168.1.100:3001/classroom/exercises.git",
        });
    } finally {
      delete process.env.GITEA_PUBLIC_BASE;
      delete process.env.GITEA_REPO;
    }
  });
});

describe("作业域 + notify 全部退役后路由（spec §0）", () => {
  it("GET /api/assignments、POST /api/sync、/api/submissions/* 均 404（服务端无提交通道）", async () => {
    const { app } = makeApp();
    await request(app).get("/api/assignments").expect(404);
    await request(app).post("/api/sync").expect(404);
    await request(app).post("/api/submissions/notify")
      .send({ studentId: "0001", studentName: "张三", commitHash: "c1", files: ["a.py"], pushedAt: 1 })
      .expect(404);
    await request(app).get("/api/submissions/student/0001").expect(404);
    await request(app).post("/api/submissions")
      .send({ exerciseId: "e1", studentId: "0001", code: "print(1)" })
      .expect(404);   // 快照入库链退役
  });
});

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
    await request(app).post("/api/roster/entry/0001/purge").expect(404, { error: "该学号不存在或已彻底清除" });   // F3：名册+token 均已清 → 404
  });
});

describe("studentId 白名单与 purge 存在性（最终审查 F1/F3）", () => {
  function makeAppWithGitea() {
    const persistence = createPersistence(":memory:");
    const calls: { method: string; url: string }[] = [];
    const f: typeof fetch = async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url) });
      if (method === "GET" && String(url).includes("branch_protections")) return new Response("[]", { status: 200 });
      return new Response(null, { status: method === "DELETE" ? 204 : 200 });
    };
    const gitea = createGiteaAdmin({ baseUrl: "http://gitea.test", adminToken: "t", repo: "classroom/exercises", fetchImpl: f });
    const app: Express = express();
    app.use(express.json({ limit: "2mb" }));
    registerRosterRoutes(app, { persistence, gitea });
    return { app, persistence, calls };
  }
  it("F1 路径穿越：purge ..%2Fvictim → 400，Gitea 端点零调用", async () => {
    const { app, calls } = makeAppWithGitea();
    await request(app).post("/api/roster/entry/..%2Fvictim/purge").expect(400, { error: "invalid studentId" });
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(calls).toHaveLength(0);   // 校验前置：Gitea 完全不被触达
  });
  it("F1 非法字符：entry body 学号含 / → 400；PATCH/DELETE/purge URL param 含 %2F → 400", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster/entry").send({ studentId: "a/b", studentName: "张三" }).expect(400, { error: "invalid studentId" });
    await request(app).patch("/api/roster/entry/a%2Fb").send({ studentName: "张三" }).expect(400, { error: "invalid studentId" });
    await request(app).delete("/api/roster/entry/a%2Fb").expect(400, { error: "invalid studentId" });
    await request(app).post("/api/roster/entry/a%2Fb/purge").expect(400, { error: "invalid studentId" });
  });
  it("F3 存在性：名册与 token 均无 → 404；软删后仅剩 token 仍可 purge → 200", async () => {
    const { app, persistence } = makeApp();
    await request(app).post("/api/roster/entry/0099/purge").expect(404, { error: "该学号不存在或已彻底清除" });
    // 软删（token 保留）→ purge 可达（存在性=名册或 token 任一存在）
    await request(app).post("/api/roster/entry").send({ studentId: "0001", studentName: "张三" }).expect(200);
    persistence.saveStudentToken("0001", "tok-1");
    await request(app).delete("/api/roster/entry/0001").expect(200);
    expect(persistence.getRosterEntry("0001")).toBeNull();
    await request(app).post("/api/roster/entry/0001/purge").expect(200, { ok: true });
    expect(persistence.getStudentToken("0001")).toBeNull();
  });
});

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

describe("teacherHub.publishMessage（A9/A21）", () => {
  it("向已连接客户端写类型化消息；snapshot 流不受影响", () => {
    const hub = createTeacherHub(() => ({ ts: 0, classId: "c", students: [], alerts: [], alertSummary: "", aggregates: [], suggestions: [] }));
    const writes: string[] = [];
    const res = { writeHead: () => {}, write: (s: string) => writes.push(s), on: () => {} } as never;
    const req = { on: () => {} } as never;
    hub.handleStream(req, res);
    hub.publishMessage({ type: "update", data: { ts: 1, classId: "c", students: [], alerts: [], alertSummary: "", aggregates: [], suggestions: [] } });
    const sseMsg = writes.find((w) => w.includes('"update"'));
    expect(sseMsg).toContain("data: ");
  });
});
