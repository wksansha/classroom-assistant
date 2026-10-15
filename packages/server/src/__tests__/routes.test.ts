import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { createPersistence } from "../persistence";
import { createTeacherHub } from "../teacherHub";
import { registerRosterRoutes } from "../routes/roster";
import { registerSubmissionRoutes } from "../routes/submissions";

function makeApp() {
  const persistence = createPersistence(":memory:");
  const app: Express = express();
  app.use(express.json({ limit: "2mb" }));
  registerRosterRoutes(app, { persistence });
  registerSubmissionRoutes(app, { persistence });
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
});

describe("作业域退役后路由（spec §0）", () => {
  it("GET /api/assignments 与 POST /api/sync 已退役（404）", async () => {
    const { app } = makeApp();
    await request(app).get("/api/assignments").expect(404);
    await request(app).post("/api/sync").expect(404);
  });

  it("notify 路由：直存一行 + 幂等；student 查询；exercise 查询与快照入库链已退役（404）", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "0001 张三" }).expect(200);
    await request(app).post("/api/submissions/notify")
      .send({ studentId: "0001", studentName: "张三", commitHash: "c1", files: ["lesson5/a.py"], pushedAt: 1 })
      .expect(200, { ok: true, inserted: true });
    await request(app).post("/api/submissions/notify")
      .send({ studentId: "0001", studentName: "张三", commitHash: "c1", files: ["lesson5/a.py"], pushedAt: 1 })
      .expect(200, { ok: true, inserted: false });
    const subs = (await request(app).get("/api/submissions/student/0001").expect(200)).body;
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ studentId: "0001", studentName: "张三", commitHash: "c1", files: ["lesson5/a.py"], review: null });
    await request(app).get("/api/submissions/exercise/e1").expect(404);
    await request(app).post("/api/submissions")
      .send({ exerciseId: "e1", studentId: "0001", studentName: "张三", code: "print(1)", source: "auto" })
      .expect(404);                                                                   // 快照入库链退役
  });

  it("notify 校验链：学号不在名册 400；缺字段 400", async () => {
    const { app } = makeApp();
    await request(app).post("/api/submissions/notify")
      .send({ studentId: "9999", studentName: "路人", commitHash: "c1", files: ["a.py"], pushedAt: 1 })
      .expect(400);
    await request(app).post("/api/submissions/notify")
      .send({ studentId: "0001", studentName: "张三", pushedAt: 1 })
      .expect(400);
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
