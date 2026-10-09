import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../index";
import { createPersistence } from "../persistence";
import { createReviewService } from "../reviewService";
import { computeCodeHash, rescanPendingReviews } from "../controllers/submissionController";

let base: string;
let remoteUrl: string;
let teacherDir: string;
const run = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "ca-e2e-"));
  remoteUrl = path.join(base, "remote.git");
  teacherDir = path.join(base, "teacher");
  run(["init", "--bare", "-b", "main", remoteUrl], base);
  run(["clone", remoteUrl, teacherDir], base);
  run(["-c", "user.name=teacher", "-c", "user.email=t@x", "commit", "--allow-empty", "-m", "init"], teacherDir);
  run(["push", "origin", "main"], teacherDir);
});
// rescan.db 的 SQLite 句柄在进程内未显式 close，Windows 下目录删除会 EPERM → 尽力清理
afterAll(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 留给系统临时目录清理 */ } });

const passFetch = (async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: '{"status":"pass","reason":"代码通过所有测试用例"}' } }] }),
})) as unknown as typeof fetch;

// 修正 1（计划笔误）：cond 是 async 函数，必须 await 后再判断
async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function makeApp() {
  return createApp({
    dbPath: ":memory:", staticDir: null,
    git: { repoDir: path.join(base, "server-clone"), remoteUrl, authorEmailDomain: "classroom" },
    reviewConfig: { apiKey: "k", fetchImpl: passFetch },
    syncAutoStart: false,        // 测试手动控制同步时序
  });
}

describe("作业闭环端到端（spec §12 验收 1-9）", () => {
  it("名册→建题→同步→发布→拉取→提交→评审→归档→幂等→监控回归", async () => {
    const { app, sync, git } = makeApp();
    // 教师推 3 道裸题
    fs.mkdirSync(path.join(teacherDir, "week-01"), { recursive: true });
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(teacherDir, `week-01/exercise-0${i}.py`),
        `# 题目：题${i}\n# 描述：第 ${i} 题\n# ===== 代码区 =====\nprint(${i})\n`, "utf8");
    }
    run(["add", "-A"], teacherDir);
    run(["-c", "user.name=teacher", "-c", "user.email=t@x", "commit", "-m", "week-01"], teacherDir);
    run(["push", "origin", "main"], teacherDir);

    await git!.ensureClone();
    await sync!.syncNow();

    // 名册（验收 1）
    await request(app).post("/api/roster").send({ text: "0001 张三\n0002 李四" }).expect(200, { ok: true, count: 2 });
    // 草稿导入（验收 3）
    const list = (await request(app).get("/api/assignments").expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0].exercises).toHaveLength(3);
    expect(list[0].isPublished).toBe(false);
    // 注入回写：教师 pull 可见 exercise-id（验收 3 后半）
    run(["pull", "--rebase"], teacherDir);
    expect(fs.readFileSync(path.join(teacherDir, "week-01/exercise-01.py"), "utf8")).toContain("# exercise-id:");
    // 发布 → 预建分支（验收 4）
    await request(app).post(`/api/assignments/${list[0].id}/publish`).send({ publish: true }).expect(200);
    const heads = run(["ls-remote", "--heads", remoteUrl], base);   // 修正 2（计划笔误）：对 remoteUrl 而非 base 执行
    expect(heads).toContain("refs/heads/student-0001");
    expect(heads).toContain("refs/heads/student-0002");
    // 学生拉取清单 + 内容（验收 5 拉取侧）
    const pub = (await request(app).get("/api/assignments/published").expect(200)).body;
    expect(pub[0].exercises).toHaveLength(3);
    expect(pub[0].exercises[0].versionHash).toHaveLength(16);
    const exId = pub[0].exercises[0].id as string;
    const content = (await request(app).get(`/api/exercises/${exId}/content`).expect(200)).text;
    // 学生提交（验收 6）：保留头部 + 学生代码
    const studentCode = content.replace(/# ===== 代码区 =====[\s\S]*$/, "# ===== 代码区 =====\nprint(100)\n");
    const r1 = await request(app).post("/api/submissions")
      .send({ exerciseId: exId, studentId: "0001", studentName: "张三", code: studentCode, source: "auto" })
      .expect(201);
    expect(r1.body.submission.review).toBeNull();
    // 评审完成（验收 7）
    await until(async () => {
      const subs = (await request(app).get(`/api/submissions/exercise/${exId}`)).body;
      return subs[0]?.review?.status === "pass";
    });
    // git 归档（验收 6 后半）：归档与评审并行异步 → 轮询远端分支直到可见（T7 先例）
    await until(() => {
      try {
        run(["fetch", "origin"], teacherDir);
        return run(["show", "origin/student-0001:week-01/exercise-01.py"], teacherDir).includes("print(100)");
      } catch {
        return false;
      }
    }, 30_000);
    const onBranch = run(["show", "origin/student-0001:week-01/exercise-01.py"], teacherDir);
    expect(onBranch).toContain("print(100)");
    // ★ T7-2 回归断言：提交后取 content 仍返回题目而非学生代码
    const contentAgain = (await request(app).get(`/api/exercises/${exId}/content`).expect(200)).text;
    expect(contentAgain).toContain("第 1 题");
    expect(contentAgain).not.toContain("print(100)");
    // 幂等（验收 9）
    await request(app).post("/api/submissions")
      .send({ exerciseId: exId, studentId: "0001", studentName: "张三", code: studentCode, source: "auto" })
      .expect(200);
    const subs = (await request(app).get(`/api/submissions/exercise/${exId}`).expect(200)).body;
    expect(subs).toHaveLength(1);
    expect(subs[0].review.status).toBe("pass");
    // 监控零侵入回归（验收 13）
    await request(app).post("/api/events").send({
      student_id: "0001", student_name: "张三", class_id: "3A",
      timestamp: new Date().toISOString(), event_type: "run",
      raw_message: "division by zero", error_type: "ZeroDivisionError",
      error_message: "division by zero", exit_code: 1,
    }).expect(200, { ok: true });
    const summary = (await request(app).get("/api/summary").expect(200)).body;
    expect(summary.students).toHaveLength(1);
  }, 120_000);
});

describe("启动补扫（A29，验收 16）", () => {
  it("review=null 的提交经 rescanPendingReviews 被补扫为 pass", async () => {
    // :memory: 无法跨实例复用 → 文件 DB 双连接：createApp 装配一把、测试句柄一把
    const dbPath = path.join(base, "rescan.db");
    const { app } = createApp({
      dbPath, staticDir: null, git: null,
      reviewConfig: { apiKey: "k", fetchImpl: passFetch },
    });
    const p = createPersistence(dbPath);
    p.upsertAssignment({ id: "a-rescan", title: "第 1 周作业", week: 1, isPublished: true, createdAt: Date.now() });
    p.upsertExercise({
      id: "e-rescan", assignmentId: "a-rescan", order: 1, filename: "exercise-01.py",
      problemStatement: "题目：补扫", starterCode: "", testCases: [],
      versionHash: "0123456789abcdef", isActive: true, createdAt: Date.now(),
    });
    p.insertSubmission({
      id: "s-rescan", exerciseId: "e-rescan", studentId: "0001", studentName: "张三",
      code: "print(1)", source: "auto", submittedAt: Date.now(), review: null,
      codeHash: computeCodeHash("print(1)"), gitSynced: false,
    });
    expect(p.getPendingReviewSubmissions()).toHaveLength(1);

    const n = await rescanPendingReviews({
      persistence: p,
      reviewService: createReviewService(p, { apiKey: "k", fetchImpl: passFetch }),
      git: null,
      publish: () => {},
    });
    expect(n).toBe(1);
    expect(p.getPendingReviewSubmissions()).toHaveLength(0);
    const subs = p.getSubmissionsByExercise("e-rescan");
    expect(subs[0].review?.status).toBe("pass");
    // app 侧（同一文件 DB）也能查到补扫结果
    const viaApp = (await request(app).get("/api/submissions/exercise/e-rescan").expect(200)).body;
    expect(viaApp[0].review.status).toBe("pass");
  });
});
