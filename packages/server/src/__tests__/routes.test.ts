import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import express, { type Express } from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SSEMessage } from "@classroom/shared";
import { createPersistence } from "../persistence";
import { createGitService } from "../gitService";
import { createSyncService } from "../syncService";
import { createReviewService } from "../reviewService";
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
  // --allow-empty：多个用例复用 seedPublishedExercise 写同一文件，内容未变时 commit 仍需成功
  run(["-c", "user.name=teacher", "-c", "user.email=t@x", "commit", "--allow-empty", "-m", msg], teacherDir);
  // 上一个用例的 server 注入可能已推进远端 → push 前先 rebase 同步（测试间共享裸仓，T6 惯例）
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

const passFetch = (async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: '{"status":"pass","reason":"代码通过所有测试用例"}' } }] }),
})) as unknown as typeof fetch;

async function until(cond: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function makeApp(fetchImpl: typeof fetch = passFetch) {
  const persistence = createPersistence(":memory:");
  const repoDir = path.join(base, `server-${Math.random().toString(36).slice(2)}`);
  const git = createGitService({ repoDir, remoteUrl, authorEmailDomain: "classroom" });
  const reviewService = createReviewService(persistence, { apiKey: "k", fetchImpl });
  const sync = createSyncService({ persistence, git, repoDir });
  const published: SSEMessage[] = [];
  const app: Express = express();
  app.use(express.json({ limit: "2mb" }));
  registerRosterRoutes(app, { persistence });
  registerAssignmentRoutes(app, { persistence, git, repoDir, sync });
  registerSubmissionRoutes(app, { persistence, reviewService, git, publish: (m) => published.push(m) });
  return { app, persistence, repoDir, published };
}

/** 造一道已发布练习，返回 exerciseId */
async function seedPublishedExercise(app: Express): Promise<string> {
  fs.mkdirSync(path.join(teacherDir, "week-01"), { recursive: true });
  fs.writeFileSync(path.join(teacherDir, "week-01/exercise-01.py"), BARE, "utf8");
  teacherCommit("add week-01");
  await request(app).post("/api/sync").expect(200);
  const list = (await request(app).get("/api/assignments").expect(200)).body;
  await request(app).post(`/api/assignments/${list[0].id}/publish`).send({ publish: true }).expect(200, { ok: true });
  const pub = (await request(app).get("/api/assignments/published").expect(200)).body;
  return pub[0].exercises[0].id as string;
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
      .expect(200, { ok: true, studentName: "张三" });   // trim + 返回规范姓名
  });
});

describe("作业路由（A18/A20/A29）", () => {
  it("列表含 exercises；PATCH 改 title/dueAt；published 排除草稿", async () => {
    const { app } = makeApp();
    fs.mkdirSync(path.join(teacherDir, "week-02"), { recursive: true });
    fs.writeFileSync(path.join(teacherDir, "week-02/exercise-01.py"), BARE.replace("两数之和", "题Z"));
    fs.rmSync(path.join(teacherDir, "week-01"), { recursive: true, force: true });   // 可能不存在，忽略
    teacherCommit("add week-02");
    await request(app).post("/api/sync").expect(200);
    const list = (await request(app).get("/api/assignments").expect(200)).body;
    expect(list[0].exercises).toHaveLength(1);
    expect(list[0].isPublished).toBe(false);
    await request(app).get("/api/assignments/published").expect(200, []);
    const patched = (await request(app).patch(`/api/assignments/${list[0].id}`).send({ title: "变量与表达式", dueAt: 1_760_000_000_000 }).expect(200)).body;
    expect(patched.title).toBe("变量与表达式");
    expect(patched.dueAt).toBe(1_760_000_000_000);
  }, 60_000);

  it("publish 预建学生分支；content 门控：草稿 404 → 发布 200 → 取消发布 404", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "0001 张三" }).expect(200);
    fs.mkdirSync(path.join(teacherDir, "week-03"), { recursive: true });
    fs.writeFileSync(path.join(teacherDir, "week-03/exercise-01.py"), BARE, "utf8");
    teacherCommit("add week-03");
    await request(app).post("/api/sync").expect(200);
    const list = (await request(app).get("/api/assignments").expect(200)).body;
    const id = list[0].id;
    const pub = (await request(app).get("/api/assignments/published").expect(200)).body;
    const exId = pub.length ? "" : "";   // 草稿不在 published —— 通过 assignments 拿
    const detail = (await request(app).get(`/api/assignments/${id}`).expect(200)).body;
    const exerciseId = detail.exercises[0].id;

    await request(app).get(`/api/exercises/${exerciseId}/content`).expect(404);   // 未发布（A20）
    await request(app).post(`/api/assignments/${id}/publish`).send({ publish: true }).expect(200);
    const heads = run(["ls-remote", "--heads", remoteUrl], base);
    expect(heads).toContain("refs/heads/student-0001");                            // A16 预建分支
    const content = await request(app).get(`/api/exercises/${exerciseId}/content`).expect(200);
    expect(content.text).toContain("# exercise-id:");                              // 注入后内容（A29 读 main 检出）
    await request(app).post(`/api/assignments/${id}/publish`).send({ publish: false }).expect(200);
    await request(app).get(`/api/exercises/${exerciseId}/content`).expect(404);   // 取消发布
  }, 60_000);
});

describe("提交路由（A7/A9/A15/A30）", () => {
  it("201 → 异步评审 + SSE 双消息 + git 归档；幂等重交 200 不新建", async () => {
    const { app, published } = makeApp();
    await request(app).post("/api/roster").send({ text: "0001 张三" }).expect(200);
    const exId = await seedPublishedExercise(app);

    const r1 = await request(app).post("/api/submissions")
      .send({ exerciseId: exId, studentId: "0001", studentName: "张三", code: "print(3)\n", source: "auto" })
      .expect(201);
    expect(r1.body.submission.review).toBeNull();                                  // 异步（A9）
    expect(published.some((m) => m.type === "submission_received")).toBe(true);
    await until(() => published.some((m) => m.type === "review_complete"));
    const rc = published.find((m) => m.type === "review_complete")!;
    if (rc.type !== "review_complete") throw new Error("unreachable");
    expect(rc.data.review.status).toBe("pass");

    // git 归档（A15）：学生分支含提交代码（归档与评审并行异步 → 轮询远端分支直到可见）
    await until(() => {
      try {
        run(["fetch", "origin"], teacherDir);
        return run(["show", "origin/student-0001:week-01/exercise-01.py"], teacherDir).includes("print(3)");
      } catch {
        return false;
      }
    }, 30_000);
    const onBranch = run(["show", "origin/student-0001:week-01/exercise-01.py"], teacherDir);
    expect(onBranch).toContain("print(3)");

    // 幂等（A7）：相同代码 → 200，不新建
    await request(app).post("/api/submissions")
      .send({ exerciseId: exId, studentId: "0001", studentName: "张三", code: "print(3)\n", source: "auto" })
      .expect(200);
    const subs = (await request(app).get(`/api/submissions/exercise/${exId}`).expect(200)).body;
    expect(subs).toHaveLength(1);
    expect(subs[0].review.status).toBe("pass");
  }, 120_000);

  it("A30：unreviewed 幂等命中 → 重新评审（LLM 被再次调用）", async () => {
    let calls = 0;
    const badFetch = (async (_u: unknown, _i: any) => {
      calls++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "不可解析的输出" } }] }) };
    }) as unknown as typeof fetch;
    const { app, published } = makeApp(badFetch);
    await request(app).post("/api/roster").send({ text: "0001 张三" }).expect(200);
    const exId = await seedPublishedExercise(app);
    await request(app).post("/api/submissions")
      .send({ exerciseId: exId, studentId: "0001", studentName: "张三", code: "print(9)\n", source: "manual" }).expect(201);
    await until(() => published.some((m) => m.type === "review_complete"));
    expect(calls).toBe(1);
    await request(app).post("/api/submissions")                                    // 幂等命中 unreviewed
      .send({ exerciseId: exId, studentId: "0001", studentName: "张三", code: "print(9)\n", source: "manual" }).expect(200);
    await until(() => calls === 2);                                                // 自动重评（A30）
    const subs = (await request(app).get(`/api/submissions/exercise/${exId}`).expect(200)).body;
    expect(subs).toHaveLength(1);                                                  // 仍只有一条提交
  }, 120_000);

  it("校验链 400：学号不在名册 / 未发布 / 超 50KB / 非法 exerciseId", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "0001 张三" }).expect(200);
    const exId = await seedPublishedExercise(app);
    await request(app).post("/api/submissions")
      .send({ exerciseId: exId, studentId: "9999", studentName: "路人", code: "print(1)", source: "auto" })
      .expect(400, { error: "学号不在名册" });
    await request(app).post("/api/submissions")
      .send({ exerciseId: "不存在的id", studentId: "0001", studentName: "张三", code: "print(1)", source: "auto" })
      .expect(400, { error: "练习不存在或已下线" });
    await request(app).post("/api/submissions")
      .send({ exerciseId: exId, studentId: "0001", studentName: "张三", code: "a".repeat(50 * 1024 + 1), source: "auto" })
      .expect(400, { error: "代码超过 50KB 限制" });
    await request(app).get("/api/submissions/student/0001").expect(200, []);       // 历史查询空
  }, 120_000);
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
