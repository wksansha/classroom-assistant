import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import express, { type Express } from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPersistence } from "../persistence";
import { createGitService } from "../gitService";
import { createSyncService } from "../syncService";
import { createTeacherHub } from "../teacherHub";
import { registerRosterRoutes } from "../routes/roster";
import { registerAssignmentRoutes } from "../routes/assignments";
import { registerSubmissionRoutes } from "../routes/submissions";

let base: string;
let remoteUrl: string;
let teacherDir: string;
const run = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });
const teacherCommit = (msg: string) => {
  run(["add", "-A"], teacherDir);
  // --allow-empty：多个用例复用 seedExercise 写同一文件，内容未变时 commit 仍需成功
  run(["-c", "user.name=teacher", "-c", "user.email=t@x", "commit", "--allow-empty", "-m", msg], teacherDir);
  run(["pull", "--rebase"], teacherDir);
  run(["push", "origin", "main"], teacherDir);
};

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "ca-routes-"));
  remoteUrl = path.join(base, "remote.git");
  teacherDir = path.join(base, "teacher");
  run(["init", "--bare", "-b", "main", remoteUrl], base);
  run(["clone", remoteUrl, teacherDir], base);
  run(["-c", "user.name=teacher", "-c", "user.email=t@x", "commit", "--allow-empty", "-m", "init"], teacherDir);
  run(["push", "origin", "main"], teacherDir);
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const BARE = `# 题目：两数之和\n# 描述：读取两个整数，输出它们的和。\n# ===== 代码区 =====\nprint(1)\n`;

function makeApp() {
  const persistence = createPersistence(":memory:");
  const repoDir = path.join(base, `server-${Math.random().toString(36).slice(2)}`);
  const git = createGitService({ repoDir, remoteUrl, authorEmailDomain: "classroom" });
  const sync = createSyncService({ persistence, git, repoDir });
  const app: Express = express();
  app.use(express.json({ limit: "2mb" }));
  registerRosterRoutes(app, { persistence });
  registerAssignmentRoutes(app, { persistence, sync });
  registerSubmissionRoutes(app, { persistence, publish: () => {} });
  return { app, persistence, repoDir };
}

/** 造一道练习（push 即布置：同步入库即可评审），返回 exerciseId */
async function seedExercise(app: Express): Promise<string> {
  fs.mkdirSync(path.join(teacherDir, "week-01"), { recursive: true });
  fs.writeFileSync(path.join(teacherDir, "week-01/exercise-01.py"), BARE, "utf8");
  teacherCommit("add week-01");
  await request(app).post("/api/sync").expect(200);
  const list = (await request(app).get("/api/assignments").expect(200)).body;
  return list[0].exercises[0].id as string;
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
      .expect(200, { ok: true, studentName: "张三", gitToken: null });   // trim + 返回规范姓名 + gitToken（学生分支直连模型）
  });
});

describe("作业路由", () => {
  it("列表含 exercises；PATCH 改 title/dueAt；发布机制已退役（404）", async () => {
    const { app } = makeApp();
    fs.mkdirSync(path.join(teacherDir, "week-02"), { recursive: true });
    fs.writeFileSync(path.join(teacherDir, "week-02/exercise-01.py"), BARE.replace("两数之和", "题Z"));
    fs.rmSync(path.join(teacherDir, "week-01"), { recursive: true, force: true });   // 可能不存在，忽略
    teacherCommit("add week-02");
    await request(app).post("/api/sync").expect(200);
    const list = (await request(app).get("/api/assignments").expect(200)).body;
    expect(list[0].exercises).toHaveLength(1);
    expect(list[0].title).toBe("week-02");                                           // 标题默认 = 目录名
    await request(app).get("/api/assignments/published").expect(404);                 // 路由删除
    await request(app).post(`/api/assignments/${list[0].id}/publish`).send({ publish: true }).expect(404);
    await request(app).get(`/api/exercises/${list[0].exercises[0].id}/content`).expect(404);
    const patched = (await request(app).patch(`/api/assignments/${list[0].id}`).send({ title: "变量与表达式", dueAt: 1_760_000_000_000 }).expect(200)).body;
    expect(patched.title).toBe("变量与表达式");
    expect(patched.dueAt).toBe(1_760_000_000_000);
  }, 60_000);

  it("提交查询路由：notify 索引行可查；旧 POST /api/submissions 已删除（404）", async () => {
    const { app, persistence } = makeApp();
    await request(app).post("/api/roster").send({ text: "0001 张三" }).expect(200);
    const exId = await seedExercise(app);
    persistence.insertNotifyRow({
      id: "n1", exerciseId: exId, studentId: "0001", studentName: "张三",
      commitHash: "c1", filesJson: "[]", submittedAt: 1,
    });
    const subs = (await request(app).get(`/api/submissions/exercise/${exId}`).expect(200)).body;
    expect(subs).toHaveLength(1);
    expect(subs[0].commitHash).toBe("c1");
    expect(subs[0].review).toBeNull();
    await request(app).get("/api/submissions/student/0001").expect(200).then((r) => expect(r.body).toHaveLength(1));
    await request(app).post("/api/submissions")
      .send({ exerciseId: exId, studentId: "0001", studentName: "张三", code: "print(1)", source: "auto" })
      .expect(404);                                                                   // 快照入库链退役
  }, 60_000);
});

describe("teacherHub.publishMessage（A9/A21）", () => {
  it("向已连接客户端写类型化消息；snapshot 流不受影响", () => {
    const hub = createTeacherHub(() => ({ ts: 0, classId: "c", students: [], alerts: [], alertSummary: "", aggregates: [], suggestions: [] }));
    const writes: string[] = [];
    const res = { writeHead: () => {}, write: (s: string) => writes.push(s), on: () => {} } as never;
    const req = { on: () => {} } as never;
    hub.handleStream(req, res);
    hub.publishMessage({ type: "submission_received", data: {
      submissionId: "s1", exerciseId: "e1", studentId: "0001", assignmentId: "a1", submittedAt: 1 } });
    const sseMsg = writes.find((w) => w.includes("submission_received"));
    expect(sseMsg).toContain("data: ");
    expect(sseMsg).toContain("0001");
  });
});
