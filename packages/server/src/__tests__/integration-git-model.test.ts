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

// —— 真实 git 全链集成（spec §10 + §0：本地 bare 仓库模拟 Gitea，Node child_process 以学生身份执行真实 git 命令）——
// 作业域 + notify 均已退役：服务端无对账、无提交通道（提交事实以学生分支 git 历史为准），
// 评审按 filePath 直达 LLM，结果经 HTTP 响应回执 + 注入教师端状态（fail 等同报错 / pass 置绿）
// 目录布局：<tmp>/remote.git（bare）+ teacher/（教师工作副本）+ pc1/ pc2/（学生工作区）

const lesson5Exercise = `# 题目：两数之和
# 描述：实现 add(a, b)，返回两数之和。
# ===== 代码区 =====
def add(a, b):
    return a + b
`;

const lesson6Exercise = `# 题目：打招呼
# 描述：实现 say_hi()，返回问候语。
# ===== 代码区 =====
def say_hi():
    pass
`;

async function run(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
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

/** submitAll 等价（ext git/commitOps.ts）：add → commit → fetch+rebase → push（notify 已退役，无上报步骤） */
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

/**
 * 新机器首用路径（F1/F2/F3 修复锁定）：扩展端 bootstrapClone 等价序列替代真实 clone——
 * init → config core.quotepath → remote add → fetch → checkout -B main（停 main）→
 * ensureStudentBranch（F1 分支保障）→ config user.name/email（F2 committer 身份）→ 写 .gitignore（F3）。
 * 本机全局 core.autocrlf=true → init 后关掉，保证题面/学生代码内容断言逐字节稳定。
 */
async function bootstrapStudentWorkspace(target: string, studentId = "0001"): Promise<void> {
  fs.mkdirSync(target, { recursive: true });
  await run(["init"], target);
  await run(["config", "core.autocrlf", "false"], target);
  await run(["config", "core.quotepath", "false"], target);
  await run(["remote", "add", "origin", remoteUrl], target);
  await run(["fetch", "origin"], target);
  await run(["checkout", "-B", "main", "origin/main"], target);
  await ensureStudentBranch(target, studentId);   // F1：bootstrap 停在 main → 立即分支保障
  await run(["config", "user.name", studentId], target);   // F2：committer 身份（机房 git 无全局身份）
  await run(["config", "user.email", `${studentId}@classroom`], target);
  fs.writeFileSync(path.join(target, ".gitignore"), "__pycache__/\n*.pyc\n.venv/\n", "utf8");   // F3
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

async function untilFirstSnapshot(): Promise<void> {
  const start = Date.now();
  while (!sseSink.some((m) => m.type === "snapshot")) {
    if (Date.now() - start > 5000) throw new Error("timeout waiting for snapshot");
    await new Promise((r) => setTimeout(r, 25));
  }
}

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

  // 教师布置 lesson5/a.py（含题面分隔线）并推 main（push 即布置，无服务端对账）
  fs.mkdirSync(path.join(teacherDir, "lesson5"), { recursive: true });
  fs.writeFileSync(path.join(teacherDir, "lesson5", "a.py"), lesson5Exercise, "utf8");
  await run(["add", "-A"], teacherDir);
  await run(["commit", "-m", "lesson5"], teacherDir);
  await run(["push", "origin", "main"], teacherDir);

  // 服务端实例：:memory: db + LLM mock；无 git 装配、无提交通道（作业域 + notify 均退役）
  const created = createApp({
    dbPath: ":memory:",
    staticDir: null,
    llmConfig: null,
    reviewConfig: { apiKey: "test-key", fetchImpl: passFetch },
  });
  app = created.app;
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  port = (server!.address() as AddressInfo).port;
  sse = connectSse(port, sseSink);
  await untilFirstSnapshot();   // SSE 连接建立（首帧 snapshot）
}, 30_000);

// Windows 下 SQLite / git 句柄可能延迟释放 → 尽力清理，失败留给系统临时目录
afterAll(async () => {
  try { sse?.stop(); await Promise.race([sse?.done, new Promise((r) => setTimeout(r, 1000))]); } catch { /* ignore */ }
  await new Promise<void>((resolve) => { server ? server.close(() => resolve()) : resolve(); });
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** 真实 git 进程在 Windows 上启动开销大（单测最多 40+ 次 git 调用），统一放宽超时 */
const GIT_TEST_TIMEOUT = 60_000;

describe("git 学生分支直连模型全链集成（作业域 + notify 退役：git 即事实源，评审结果驱动状态）", () => {
  it("1. 服务端退役断言：assignments/sync/submissions 路由全部 404（服务端不 clone 仓库、无提交通道）", async () => {
    await request(app).get("/api/assignments").expect(404);
    await request(app).post("/api/sync").expect(404);
    await request(app).post("/api/submissions/notify").send({ studentId: "0001", commitHash: "c", files: [] }).expect(404);
    await request(app).get("/api/submissions/student/0001").expect(404);
  }, GIT_TEST_TIMEOUT);

  it("2. 学生首用：bootstrap 等价 clone + ensureStudentBranch（自 main 建）→ 改 a.py 提交推送（服务端零参与）", async () => {
    // 名册导入（评审依赖花名册校验）
    await request(app).post("/api/roster").send({ text: "0001 张三" }).expect(200, { ok: true, count: 1 });

    await bootstrapStudentWorkspace(pc1);
    await ensureStudentBranch(pc1, "0001");   // 命令体入口幂等重入（F1）：本地分支已存在 → 直接 checkout
    expect((await run(["rev-parse", "--abbrev-ref", "HEAD"], pc1)).trim()).toBe("student-0001");

    // 学生改 a.py：保留题面头部（题面锚点 = 文件内注释），代码区写入自己的实现
    studentCode5 = lesson5Exercise.replace(
      "def add(a, b):\n    return a + b",
      "def add(a, b):\n    return a + b\n\nprint(add(1, 2))",
    );
    fs.writeFileSync(path.join(pc1, "lesson5", "a.py"), studentCode5, "utf8");

    const s1 = await submitAll(pc1, "0001", "张三");
    commitHash1 = s1.commitHash;
    expect(s1.files).toEqual([".gitignore", "lesson5/a.py"]);   // 首推 → ls-files 全量清单（含 F3 引导写入的 .gitignore）

    // 远端学生分支可见；提交事实只存在于 git，服务端无任何记录
    const heads = await run(["ls-remote", "--heads", remoteUrl], base);
    expect(heads).toContain("refs/heads/student-0001");
  }, GIT_TEST_TIMEOUT);

  it("3. F5 评审路径化：filePath+code（含题面注释全文）直达 LLM → mock pass → 结果经 HTTP 回执 + 注入教师端状态置绿", async () => {
    const llmBefore = llmState.calls;
    const sseBefore = sseSink.length;
    const rr = await request(app).post("/api/reviews/request")
      .send({ studentId: "0001", studentName: "张三", filePath: "lesson5/a.py", code: studentCode5, commitHash: commitHash1 })
      .expect(200);
    expect(rr.body.review).toMatchObject({ status: "pass", reason: "代码通过所有测试用例", source: "llm" });
    expect(rr.body.submissionId).toBeUndefined();   // notify 已退役
    expect(llmState.calls).toBe(llmBefore + 1);

    // pass 注入教师端状态：学生转绿（告警面板刷新）
    await until(() => sseSink.slice(sseBefore).some((m) => m.type === "snapshot" || m.type === "update"));
  }, GIT_TEST_TIMEOUT);

  it("4. 教师再布置 lesson6（push main 即布置）→ 电脑 1 pullNewOnly 只进 lesson6（已有学生代码不动）", async () => {
    fs.mkdirSync(path.join(teacherDir, "lesson6"), { recursive: true });
    fs.writeFileSync(path.join(teacherDir, "lesson6", "b.py"), lesson6Exercise, "utf8");
    await run(["add", "-A"], teacherDir);
    await run(["commit", "-m", "lesson6"], teacherDir);
    await run(["push", "origin", "main"], teacherDir);

    // 电脑 1 拉取：只新增策略（服务端零参与）
    const pulled = await pullNewOnly(pc1, "0001");
    expect(pulled).toEqual(["lesson6/b.py"]);
    // S1..HEAD 仅新增 lesson6/b.py
    const changed = (await run(["diff", "--name-only", commitHash1, "HEAD"], pc1)).split("\n").filter(Boolean);
    expect(changed).toEqual(["lesson6/b.py"]);
    // 新题面进入工作区；已有学生代码不动
    expect(fs.readFileSync(path.join(pc1, "lesson6", "b.py"), "utf8")).toBe(lesson6Exercise);
    expect(fs.readFileSync(path.join(pc1, "lesson5", "a.py"), "utf8")).toBe(studentCode5);
  }, GIT_TEST_TIMEOUT);

  it("5. 多电脑防覆盖：电脑 2 提交 lesson6 学生版 → 落后的电脑 1 pullNewOnly 不覆盖他机学生代码", async () => {
    // 电脑 1 的拉取提交上远端（真实流程中由后续 submitAll 携带；此后电脑 1 为纯落后状态、无本地独有提交）
    const p1Tip = (await run(["rev-parse", "HEAD"], pc1)).trim();
    await run(["push", "origin", "student-0001"], pc1);

    // —— 电脑 2：换机首用（同样走新机器首用路径）→ 基于远端学生分支建（保住历史）——
    await bootstrapStudentWorkspace(pc2);
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

    // —— 回电脑 1（分支落后）→ pullNewOnly：先 rebase 收敛自己再只新增（此时 main 无新题 → 无新增）——
    expect(await pullNewOnly(pc1, "0001")).toEqual([]);

    // ★ 防覆盖断言：lesson6/b.py 仍是电脑 2 的学生版（未被 main 原始题面覆盖）
    expect(fs.readFileSync(path.join(pc1, "lesson6", "b.py"), "utf8")).toBe(studentCode6);
    expect(fs.readFileSync(path.join(pc1, "lesson5", "a.py"), "utf8")).toBe(studentCode5);
  }, GIT_TEST_TIMEOUT);

  it("6. 存量库迁移（notify 退役形状）：assignments/exercises/submissions 全 DROP，review_cache（旧形状）重建，roster 保留", () => {
    const dbPath = path.join(base, "legacy2.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE assignments (id TEXT PRIMARY KEY, title TEXT NOT NULL, week INTEGER NOT NULL UNIQUE, due_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE exercises (id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, order_no INTEGER NOT NULL, filename TEXT NOT NULL, problem_statement TEXT NOT NULL, starter_code TEXT, test_cases_json TEXT, version_hash TEXT NOT NULL, is_active INTEGER DEFAULT 1, created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'file', dir TEXT, entry TEXT);
      CREATE TABLE submissions (id TEXT PRIMARY KEY, exercise_id TEXT NOT NULL, student_id TEXT NOT NULL, student_name TEXT NOT NULL, commit_hash TEXT NOT NULL, files_json TEXT NOT NULL, submitted_at INTEGER NOT NULL, review_json TEXT, UNIQUE(exercise_id, student_id, commit_hash));
      INSERT INTO submissions (id, exercise_id, student_id, student_name, commit_hash, files_json, submitted_at) VALUES ('keep-1', 'ex-old', '0009', '轻量行', 'c9', '["lesson1/x.py"]', 42);
      CREATE TABLE review_cache (cache_key TEXT PRIMARY KEY, exercise_id TEXT NOT NULL, version_hash TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL, model TEXT, hit_count INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE roster (student_id TEXT PRIMARY KEY, student_name TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO roster (student_id, student_name, created_at) VALUES ('0001', '张三', 1);
    `);
    legacy.close();

    const p = createPersistence(dbPath);
    const check = new Database(dbPath);
    const names = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(names).not.toContain("assignments");
    expect(names).not.toContain("exercises");
    expect(names).not.toContain("submissions");
    const rcCols = (check.prepare("PRAGMA table_info(review_cache)").all() as { name: string }[]).map((c) => c.name);
    expect(rcCols).not.toContain("exercise_id");
    check.close();
    // roster 无损保留
    expect(p.getRosterEntry("0001")).toEqual({ studentId: "0001", studentName: "张三" });
    p.close();
  }, GIT_TEST_TIMEOUT);
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}
