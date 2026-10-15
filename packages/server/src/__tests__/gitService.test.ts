import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGitService } from "../gitService";

let base: string;
let remoteUrl: string;
let teacherDir: string;

const run = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });
const write = (cwd: string, rel: string, content: string) => {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
};
const readRemote = (branch: string, file: string) =>
  run(["show", `origin/${branch}:${file}`], teacherDir);

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "ca-git-"));
  remoteUrl = path.join(base, "remote.git");
  teacherDir = path.join(base, "teacher");
  run(["init", "--bare", "-b", "main", remoteUrl], base);
  run(["clone", remoteUrl, teacherDir], base);
  run(["-c", "user.name=teacher", "-c", "user.email=t@x", "commit", "--allow-empty", "-m", "init"], teacherDir);
  run(["push", "origin", "main"], teacherDir);
}, 60_000);   // 默认 hook 超时 10s：全量并发下（git 密集测试文件并行）git 进程排队可超
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const makeServer = () => createGitService({
  repoDir: path.join(base, "server-clone"),
  remoteUrl,
  authorEmailDomain: "classroom",
});

describe("gitService main 侧（A13/A28；学生分支写路径已退役）", () => {
  it("ensureClone + alignToRemote + 注入回写推送成功", async () => {
    const git = makeServer();
    await git.ensureClone();
    // 教师先推题（A28 真实时序：教师推题在前，server Phase 1 对齐后 Phase 3 注入同一文件）
    write(teacherDir, "week-01/exercise-01.py", "# 题目：两数之和\nprint(1)\n");
    run(["add", "-A"], teacherDir);
    run(["-c", "user.name=teacher", "-c", "user.email=t@x", "commit", "-m", "add ex01"], teacherDir);
    run(["push", "origin", "main"], teacherDir);
    await git.alignToRemote();

    const r = await git.commitAndPushMain(
      [{ path: "week-01/exercise-01.py", content: "# exercise-id: aaaa\nprint(1)\n" }],
      "inject: exercise-id for 1 file(s)",
    );
    expect(r).toBe("ok");
    run(["pull", "--rebase"], teacherDir);
    expect(readRemote("main", "week-01/exercise-01.py")).toContain("# exercise-id: aaaa");
  }, 60_000);

  it("教师抢先推（写冲突）→ rebase 自动重试成功，双方提交都在（A28）", async () => {
    const git = makeServer();
    await git.ensureClone();
    await git.alignToRemote();                     // server 基于当前 main
    write(teacherDir, "week-01/exercise-02.py", "# 题目：新题\n");
    run(["add", "-A"], teacherDir);
    run(["-c", "user.name=teacher", "-c", "user.email=t@x", "commit", "-m", "teacher race"], teacherDir);
    run(["push", "origin", "main"], teacherDir);   // 教师抢先推 → server push 将被拒

    const r = await git.commitAndPushMain(
      [{ path: "week-01/exercise-03.py", content: "# exercise-id: bbbb\n" }],
      "inject: exercise-id for 1 file(s)",
    );
    expect(r).toBe("ok");                          // pushMainWithRetry：fetch+rebase+重试
    run(["pull", "--rebase"], teacherDir);
    expect(readRemote("main", "week-01/exercise-02.py")).toContain("新题");   // 教师提交在
    expect(readRemote("main", "week-01/exercise-03.py")).toContain("bbbb");   // server 注入也在
  }, 60_000);

  it("rebase 冲突（同文件对撞）→ rejected，本地 commit 保留，alignToRemote 可丢弃", async () => {
    const git = makeServer();
    await git.ensureClone();
    await git.alignToRemote();
    // 教师改同一文件并抢先推 → server 再改同文件必冲突
    write(teacherDir, "week-01/clash.py", "# 教师版本\n");
    run(["add", "-A"], teacherDir);
    run(["-c", "user.name=teacher", "-c", "user.email=t@x", "commit", "-m", "teacher edit"], teacherDir);
    run(["push", "origin", "main"], teacherDir);

    const r = await git.commitAndPushMain(
      [{ path: "week-01/clash.py", content: "# server 版本\n" }],
      "inject: clash",
    );
    expect(r).toBe("rejected");
    expect(await git.hasUnpushedMainCommits()).toBe(true);   // 遗留 commit 在
    await git.alignToRemote();                                // Phase 0/1 语义：丢弃安全（ID 在 DB）
    expect(await git.hasUnpushedMainCommits()).toBe(false);
  }, 60_000);
});
