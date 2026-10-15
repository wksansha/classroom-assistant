import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";
import request from "supertest";
import Database from "better-sqlite3";
import type { SSEMessage } from "@classroom/shared";
import { createApp } from "../index";
import { createPersistence } from "../persistence";

const execFileAsync = promisify(execFile);

// —— 真实 git 全链集成（spec §10：本地 bare 仓库模拟 Gitea，Node child_process 以学生身份执行真实 git 命令）——
// 目录布局：<tmp>/remote.git（bare）+ teacher/（教师工作副本）+ server-clone/（服务端克隆）+ pc1/ pc2/（学生工作区）

const EX_L5 = "a5000000-0000-4000-8000-000000000005";
const EX_L6 = "a6000000-0000-4000-8000-000000000006";
const EX_L7 = "a7000000-0000-4000-8000-000000000007";

const lesson5Exercise = `# ===== classroom-assistant =====
# exercise-id: ${EX_L5}
# ===============================
# 题目：两数之和
# 描述：实现 add(a, b)，返回两数之和。
# ===== 代码区 =====
def add(a, b):
    return a + b
`;

const lesson6Exercise = `# ===== classroom-assistant =====
# exercise-id: ${EX_L6}
# ===============================
# 题目：打招呼
# 描述：实现 say_hi()，返回问候语。
# ===== 代码区 =====
def say_hi():
    pass
`;

const lesson7Exercise = `# ===== classroom-assistant =====
# exercise-id: ${EX_L7}
# ===============================
# 题目：循环求和
# 描述：实现 total(n)，返回 1..n 之和。
# ===== 代码区 =====
def total(n):
    pass
`;

async function run(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

// —— 学生 git 原语模拟（忠实于 vscode-pylearner src/git/*，分支/删除确认等分支由扩展单测覆盖）——

/** ensureStudentBranch 等价（ext git/branchOps.ts）：fetch → 本地无分支时自 origin/main 或 origin/student-X 建 → checkout */
async function ensureStudentBranch(cwd: string, studentId: string): Promise<void> {
  const branch = `student-${studentId}`;
  await run(["fetch", "origin"], cwd);
  const local = (await run(["branch", "--list", branch], cwd)).trim();
  if (!local) {
    let remoteRef = "";
    try { remoteRef = (await run(["rev-parse", "--verify", `origin/${branch}`], cwd)).trim(); } catch { /* 首用无远端分支 */ }
    await run(["branch", branch, remoteRef ? `origin/${branch}` : "origin/main"], cwd);
  }
  await run(["checkout", branch], cwd);
}

/** pullNewOnly 等价（ext git/pullOps.ts）：先同步自己（多电脑防覆盖）再只新增 */
async function pullNewOnly(cwd: string, studentId: string): Promise<string[]> {
  const branch = `student-${studentId}`;
  await run(["fetch", "origin"], cwd);
  // 首推守卫：远端学生分支尚不存在时跳过 rebase（真实 git 下 rebase 会报 invalid upstream）——与 ext git/pullOps.ts 保持一致
  let hasRemote = true;
  try { await run(["rev-parse", "--verify", `origin/${branch}`], cwd); } catch { hasRemote = false; }
  if (hasRemote) await run(["rebase", `origin/${branch}`], cwd);
  const out = await run(["diff", "--diff-filter=A", "--name-only", "HEAD", "origin/main"], cwd);
  const paths = out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (paths.length === 0) return [];
  await run(["checkout", "origin/main", "--", ...paths], cwd);
  await run(["commit", "-m", `pull: ${paths.length} new file(s) from main`], cwd);
  return paths;
}

/** submitAll 等价（ext git/commitOps.ts）：add → commit → fetch+rebase → 记 hash 与文件清单 → push；返回 notify payload */
async function submitAll(cwd: string, studentId: string, studentName: string): Promise<{ commitHash: string; files: string[] }> {
  const branch = `student-${studentId}`;
  await run(["add", "-A"], cwd);
  await run(["commit", "-m", `submit: workspace by ${studentId} ${studentName}`,
    `--author=${studentId} ${studentName} <${studentId}@classroom>`], cwd);
  await run(["fetch", "origin"], cwd);
  // 首推时远端学生分支尚不存在，无历史可收敛（真实 git 下 rebase 会报 invalid upstream）
  let hasRemote = true;
  try { await run(["rev-parse", "--verify", `origin/${branch}`], cwd); } catch { hasRemote = false; }
  if (hasRemote) await run(["rebase", `origin/${branch}`], cwd);
  const commitHash = (await run(["rev-parse", "HEAD"], cwd)).trim();
  let files: string[];
  try {
    const before = (await run(["rev-parse", `origin/${branch}`], cwd)).trim();
    files = (await run(["diff", "--name-only", before, "HEAD"], cwd)).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    files = (await run(["ls-files"], cwd)).split("\n").filter(Boolean);   // 首推 → 全量清单
  }
  await run(["push", "origin", `HEAD:refs/heads/${branch}`], cwd);
  return { commitHash, files };
}

async function cloneStudentWorkspace(target: string): Promise<void> {
  // 本机全局 core.autocrlf=true → clone 时关掉，保证题面/学生代码内容断言逐字节稳定
  await run(["-c", "core.autocrlf=false", "clone", remoteUrl, target], base);
  await run(["config", "core.autocrlf", "false"], target);
  await run(["config", "user.name", "student-0001"], target);
  await run(["config", "user.email", "0001@classroom"], target);
}

/** SSE 订阅：连接即收快照，之后逐帧 push 进 sink */
function connectSse(port: number, sink: SSEMessage[]) {
  const controller = new AbortController();
  const done = (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/stream/teacher`, { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) {
              try { sink.push(JSON.parse(line.slice(6)) as SSEMessage); } catch { /* 忽略坏帧 */ }
            }
          }
        }
      }
    } catch { /* afterAll abort 后正常退出 */ }
  })();
  return { stop: () => controller.abort(), done };
}

// —— 全局夹具状态 ——

let base = "";
let remoteUrl = "";
let teacherDir = "";
let pc1 = "";
let pc2 = "";
let app: Express;
let server: Server | null = null;
let port = 0;
const sseSink: SSEMessage[] = [];
let sse: { stop(): void; done: Promise<void> } | null = null;
const llmState = { calls: 0 };

// 评审链 LLM mock：pass（真 reviewService + 假上游，调用次数可观测）
const passFetch = (async () => {
  llmState.calls++;
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"status":"pass","reason":"代码通过所有测试用例"}' } }] }),
  };
}) as unknown as typeof fetch;

let commitHash1 = "";        // 电脑 1 首次提交（lesson5 学生版）
let studentCode5 = "";       // 电脑 1 的 lesson5/a.py 学生版全文
let studentCode6 = "";       // 电脑 2 的 lesson6/b.py 学生版全文
let notifyRowId1 = "";       // lesson5 首次提交的索引行 id

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "ca-gitmodel-"));
  remoteUrl = path.join(base, "remote.git");
  teacherDir = path.join(base, "teacher");
  pc1 = path.join(base, "pc1");
  pc2 = path.join(base, "pc2");

  // 教师 bare 仓库（模拟 Gitea）+ 教师工作副本首推
  await run(["init", "--bare", "-b", "main", remoteUrl], base);
  await run(["-c", "core.autocrlf=false", "clone", remoteUrl, teacherDir], base);
  await run(["config", "core.autocrlf", "false"], teacherDir);
  await run(["config", "user.name", "teacher"], teacherDir);
  await run(["config", "user.email", "teacher@classroom"], teacherDir);
  await run(["commit", "--allow-empty", "-m", "init"], teacherDir);
  await run(["push", "origin", "main"], teacherDir);

  // 教师布置 lesson5/a.py（含题面分隔线）并推 main
  fs.mkdirSync(path.join(teacherDir, "lesson5"), { recursive: true });
  fs.writeFileSync(path.join(teacherDir, "lesson5", "a.py"), lesson5Exercise, "utf8");
  await run(["add", "-A"], teacherDir);
  await run(["commit", "-m", "lesson5"], teacherDir);
  await run(["push", "origin", "main"], teacherDir);

  // 服务端实例：:memory: db + 真实 git（临时 bare）+ LLM mock；不自动启动同步（测试手动控制时序）
  const created = createApp({
    dbPath: ":memory:",
    staticDir: null,
    llmConfig: null,
    traceDir: path.join(base, "trace"),
    git: { repoDir: path.join(base, "server-clone"), remoteUrl },
    reviewConfig: { apiKey: "test-key", fetchImpl: passFetch },
    syncAutoStart: false,
  });
  app = created.app;
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  port = (server!.address() as AddressInfo).port;
  sse = connectSse(port, sseSink);
  await until(() => sseSink.length > 0);   // SSE 连接建立（首帧 snapshot）
}, 30_000);

// Windows 下 SQLite / git 句柄可能延迟释放 → 尽力清理，失败留给系统临时目录
afterAll(async () => {
  try { sse?.stop(); await Promise.race([sse?.done, new Promise((r) => setTimeout(r, 1000))]); } catch { /* ignore */ }
  await new Promise<void>((resolve) => { server ? server.close(() => resolve()) : resolve(); });
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** 真实 git 进程在 Windows 上启动开销大（单测最多 40+ 次 git 调用），统一放宽超时 */
const GIT_TEST_TIMEOUT = 60_000;

describe("git 学生分支直连模型全链集成（bare 模拟 Gitea + 真实 git 学生操作）", () => {
  it("1. 教师布置 lesson5 → POST /api/sync 对账 → exercises 出现 lesson5/a.py（题面/starterCode 解析正确）", async () => {
    const r = await request(app).post("/api/sync").expect(200);
    expect(r.body).toEqual({ importedNew: 1, updated: 0, deactivated: 0, warnings: [] });

    const list = (await request(app).get("/api/assignments").expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("lesson5");
    expect(list[0].weekDir).toBe("lesson5");
    expect(list[0].exercises).toHaveLength(1);
    const ex = list[0].exercises[0];
    expect(ex.id).toBe(EX_L5);   // 头部 exercise-id 优先
    expect(ex.filename).toBe("a.py");
    expect(ex.problemStatement).toBe("题目：两数之和\n描述：实现 add(a, b)，返回两数之和。");
    expect(ex.starterCode).toBe("def add(a, b):\n    return a + b");
    expect(ex.versionHash).toHaveLength(16);
    expect(ex.isActive).toBe(true);
  }, GIT_TEST_TIMEOUT);

  it("2. 学生首用：clone → ensureStudentBranch（自 main 建）→ 改 a.py 提交 → notify 轻量索引 + SSE submission_received", async () => {
    // 名册导入（notify/评审都依赖花名册校验）
    await request(app).post("/api/roster").send({ text: "0001 张三" }).expect(200, { ok: true, count: 1 });

    await cloneStudentWorkspace(pc1);
    await ensureStudentBranch(pc1, "0001");
    expect((await run(["rev-parse", "--abbrev-ref", "HEAD"], pc1)).trim()).toBe("student-0001");

    // 学生改 a.py：保留题面头部，代码区写入自己的实现
    studentCode5 = lesson5Exercise.replace(
      "def add(a, b):\n    return a + b",
      "def add(a, b):\n    return a + b\n\nprint(add(1, 2))",
    );
    fs.writeFileSync(path.join(pc1, "lesson5", "a.py"), studentCode5, "utf8");

    const s1 = await submitAll(pc1, "0001", "张三");
    commitHash1 = s1.commitHash;
    expect(s1.files).toEqual(["lesson5/a.py"]);   // 首推 → ls-files 全量清单

    // 远端学生分支可见
    const heads = await run(["ls-remote", "--heads", remoteUrl], base);
    expect(heads).toContain("refs/heads/student-0001");

    // 扩展提交成功后 notify 服务端
    const sseBefore = sseSink.length;
    await request(app).post("/api/submissions/notify")
      .send({ studentId: "0001", studentName: "张三", commitHash: s1.commitHash, files: s1.files, pushedAt: Date.now() })
      .expect(200, { ok: true, exercises: 1 });

    // 轻量索引：一行（不存代码全文，只有 commit_hash + files_json + review=null）
    const rows = (await request(app).get("/api/submissions/student/0001").expect(200)).body;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      exerciseId: EX_L5,
      studentId: "0001",
      studentName: "张三",
      commitHash: s1.commitHash,
      files: ["lesson5/a.py"],
      review: null,
    });
    notifyRowId1 = rows[0].id;

    // SSE 逐练习广播
    await until(() => sseSink.slice(sseBefore).some((m) => m.type === "submission_received"));
    const msg = sseSink.slice(sseBefore).find((m) => m.type === "submission_received")!;
    expect(msg.data).toMatchObject({
      submissionId: `${s1.commitHash}:${EX_L5}`,
      exerciseId: EX_L5,
      studentId: "0001",
    });
  }, GIT_TEST_TIMEOUT);

  it("7. 幂等：同 commit 重复 notify → 不重复入库、不重复广播", async () => {
    const rowsBefore = (await request(app).get("/api/submissions/student/0001").expect(200)).body.length;
    const sseBefore = sseSink.length;
    const r = await request(app).post("/api/submissions/notify")
      .send({ studentId: "0001", studentName: "张三", commitHash: commitHash1, files: ["lesson5/a.py"], pushedAt: Date.now() })
      .expect(200);
    expect(r.body).toEqual({ ok: true, exercises: 0 });   // UNIQUE 冲突忽略
    expect((await request(app).get("/api/submissions/student/0001").expect(200)).body).toHaveLength(rowsBefore);
    expect(sseSink.length).toBe(sseBefore);
  }, GIT_TEST_TIMEOUT);

  it("3. F5 评审路径化：filePath+commitHash 定位练习 → LLM mock pass → 索引回填 + SSE review_complete", async () => {
    const llmBefore = llmState.calls;
    const sseBefore = sseSink.length;
    const rr = await request(app).post("/api/reviews/request")
      .send({ studentId: "0001", studentName: "张三", filePath: "lesson5/a.py", code: studentCode5, commitHash: commitHash1 })
      .expect(200);
    expect(rr.body.review).toMatchObject({ status: "pass", reason: "代码通过所有测试用例", source: "llm" });
    expect(rr.body.submissionId).toBe(notifyRowId1);
    expect(llmState.calls).toBe(llmBefore + 1);

    // 按 (exercise_id, student_id, commit_hash) 定位回填
    const rows = (await request(app).get("/api/submissions/student/0001").expect(200)).body;
    expect(rows[0].review).toMatchObject({ status: "pass", reason: "代码通过所有测试用例" });

    await until(() => sseSink.slice(sseBefore).some((m) => m.type === "review_complete"));
    const msg = sseSink.slice(sseBefore).find((m) => m.type === "review_complete")!;
    expect(msg.data).toMatchObject({
      submissionId: notifyRowId1,
      exerciseId: EX_L5,
      studentId: "0001",
    });
    expect((msg.data as { review: { status: string } }).review.status).toBe("pass");
  }, GIT_TEST_TIMEOUT);

  it("4. 教师再布置 lesson6 → 对账 → 电脑 1 pullNewOnly 只进 lesson6（已有学生代码不动）", async () => {
    // 教师推 lesson6/b.py 到 main
    fs.mkdirSync(path.join(teacherDir, "lesson6"), { recursive: true });
    fs.writeFileSync(path.join(teacherDir, "lesson6", "b.py"), lesson6Exercise, "utf8");
    await run(["add", "-A"], teacherDir);
    await run(["commit", "-m", "lesson6"], teacherDir);
    await run(["push", "origin", "main"], teacherDir);

    const sr = await request(app).post("/api/sync").expect(200);
    expect(sr.body.importedNew).toBe(1);
    const a6 = (await request(app).get("/api/assignments").expect(200)).body
      .find((x: { weekDir?: string }) => x.weekDir === "lesson6");
    expect(a6.exercises[0].id).toBe(EX_L6);

    // 电脑 1 拉取：只新增策略
    const pulled = await pullNewOnly(pc1, "0001");
    expect(pulled).toEqual(["lesson6/b.py"]);
    // S1..HEAD 仅新增 lesson6/b.py
    const changed = (await run(["diff", "--name-only", commitHash1, "HEAD"], pc1)).split("\n").filter(Boolean);
    expect(changed).toEqual(["lesson6/b.py"]);
    // 新题面进入工作区；已有学生代码不动
    expect(fs.readFileSync(path.join(pc1, "lesson6", "b.py"), "utf8")).toBe(lesson6Exercise);
    expect(fs.readFileSync(path.join(pc1, "lesson5", "a.py"), "utf8")).toBe(studentCode5);
  }, GIT_TEST_TIMEOUT);

  it("5. 多电脑防覆盖：电脑 2 提交 lesson6 学生版 push → 落后的电脑 1 pullNewOnly 拉作业 3 不覆盖他机学生代码", async () => {
    // 电脑 1 的拉取提交上远端（真实流程中由后续 submitAll 携带；此后电脑 1 为纯落后状态、无本地独有提交）
    const p1Tip = (await run(["rev-parse", "HEAD"], pc1)).trim();
    await run(["push", "origin", "student-0001"], pc1);

    // —— 电脑 2：换机首用 → 基于远端学生分支建（保住历史）——
    await cloneStudentWorkspace(pc2);
    await ensureStudentBranch(pc2, "0001");
    expect((await run(["rev-parse", "--abbrev-ref", "HEAD"], pc2)).trim()).toBe("student-0001");
    expect((await run(["rev-parse", "HEAD"], pc2)).trim()).toBe(p1Tip);   // 基于 origin/student-0001 而非 origin/main

    // 电脑 2 拉取：lesson6 已在其分支历史 → 无新增
    expect(await pullNewOnly(pc2, "0001")).toEqual([]);

    // 电脑 2 学生写 lesson6/b.py 学生版并提交推送
    studentCode6 = lesson6Exercise.replace(
      "def say_hi():\n    pass",
      "def say_hi():\n    return 'pc2-0001'",
    );
    fs.writeFileSync(path.join(pc2, "lesson6", "b.py"), studentCode6, "utf8");
    const s2 = await submitAll(pc2, "0001", "张三");
    expect(s2.files).toEqual(["lesson6/b.py"]);

    // 电脑 2 notify → lesson6 索引行
    await request(app).post("/api/submissions/notify")
      .send({ studentId: "0001", studentName: "张三", commitHash: s2.commitHash, files: s2.files, pushedAt: Date.now() })
      .expect(200, { ok: true, exercises: 1 });
    const l6Rows = (await request(app).get(`/api/submissions/exercise/${EX_L6}`).expect(200)).body;
    expect(l6Rows).toHaveLength(1);
    expect(l6Rows[0].commitHash).toBe(s2.commitHash);

    // —— 教师再布置 lesson7 ——
    fs.mkdirSync(path.join(teacherDir, "lesson7"), { recursive: true });
    fs.writeFileSync(path.join(teacherDir, "lesson7", "c.py"), lesson7Exercise, "utf8");
    await run(["add", "-A"], teacherDir);
    await run(["commit", "-m", "lesson7"], teacherDir);
    await run(["push", "origin", "main"], teacherDir);
    expect((await request(app).post("/api/sync").expect(200)).body.importedNew).toBe(1);

    // —— 回电脑 1（分支落后）→ pullNewOnly：先 rebase 收敛自己再只新增 ——
    const pulled1 = await pullNewOnly(pc1, "0001");
    expect(pulled1).toEqual(["lesson7/c.py"]);   // lesson6/b.py 已在收敛后的 HEAD 中，不被视为新增

    // ★ 防覆盖断言：lesson6/b.py 仍是电脑 2 的学生版（未被 main 原始题面覆盖）
    expect(fs.readFileSync(path.join(pc1, "lesson6", "b.py"), "utf8")).toBe(studentCode6);
    // 电脑 1 自己的学生代码与新作业
    expect(fs.readFileSync(path.join(pc1, "lesson5", "a.py"), "utf8")).toBe(studentCode5);
    expect(fs.readFileSync(path.join(pc1, "lesson7", "c.py"), "utf8")).toBe(lesson7Exercise);
  }, GIT_TEST_TIMEOUT);

  it("6. 存量库迁移：旧形状 submissions（code 列无 commit_hash）DROP 重建 + submission_notify RENAME 保留数据", () => {
    const dbPath = path.join(base, "legacy.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE assignments (id TEXT PRIMARY KEY, title TEXT NOT NULL, week INTEGER NOT NULL UNIQUE, due_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE exercises (id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES assignments(id), order_no INTEGER NOT NULL, filename TEXT NOT NULL, problem_statement TEXT NOT NULL, starter_code TEXT, test_cases_json TEXT, version_hash TEXT NOT NULL, is_active INTEGER DEFAULT 1, created_at INTEGER NOT NULL);
      CREATE TABLE submissions (id TEXT PRIMARY KEY, exercise_id TEXT NOT NULL, student_id TEXT NOT NULL, student_name TEXT NOT NULL, code TEXT NOT NULL, submitted_at INTEGER NOT NULL, review_json TEXT);
      INSERT INTO submissions (id, exercise_id, student_id, student_name, code, submitted_at) VALUES ('old-1', 'ex-old', '0008', '旧快照', 'print(1)', 7);
      CREATE TABLE submission_notify (id TEXT PRIMARY KEY, exercise_id TEXT NOT NULL, student_id TEXT NOT NULL, student_name TEXT NOT NULL, commit_hash TEXT NOT NULL, files_json TEXT NOT NULL, submitted_at INTEGER NOT NULL, review_json TEXT, UNIQUE(exercise_id, student_id, commit_hash));
      INSERT INTO submission_notify (id, exercise_id, student_id, student_name, commit_hash, files_json, submitted_at) VALUES ('keep-1', 'ex-old', '0009', '轻量行', 'c9', '["lesson1/x.py"]', 42);
    `);
    legacy.close();

    const p = createPersistence(dbPath);

    // DROP：旧快照 submissions 重建为空；轻量索引新形状可用
    expect(p.getSubmissionsByStudent("0008")).toEqual([]);
    // RENAME：submission_notify（新形状）数据保留
    const kept = p.getSubmissionsByStudent("0009");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      id: "keep-1", exerciseId: "ex-old", studentId: "0009",
      commitHash: "c9", files: ["lesson1/x.py"], review: null,
    });
    // 新形状写入 + UNIQUE(exercise_id, student_id, commit_hash) 幂等生效
    expect(p.insertNotifyRow({ id: "n-1", exerciseId: "ex-old", studentId: "0009", studentName: "轻量行", commitHash: "c10", filesJson: "[]", submittedAt: 43 })).toBe(true);
    expect(p.insertNotifyRow({ id: "n-2", exerciseId: "ex-old", studentId: "0009", studentName: "轻量行", commitHash: "c10", filesJson: "[]", submittedAt: 44 })).toBe(false);
    expect(p.getSubmissionsByStudent("0009")).toHaveLength(2);
    // 共存的 V2 补列路径：exercises.kind/dir/entry 可用
    p.upsertAssignment({ id: "a-legacy", title: "t", week: 1, createdAt: 1 });
    p.upsertExercise({ id: "ex-old", assignmentId: "a-legacy", order: 1, filename: "proj", problemStatement: "s",
      testCases: [], versionHash: "v", isActive: true, createdAt: 1, kind: "project", dir: "proj", entry: "main.py" });
    expect(p.getExercise("ex-old")!.kind).toBe("project");
  }, GIT_TEST_TIMEOUT);
});
