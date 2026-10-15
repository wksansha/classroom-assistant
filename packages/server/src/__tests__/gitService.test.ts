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

describe("gitService 只读对齐（学生分支直连模型：服务端对教师仓库只读，注入回写已退役）", () => {
  it("ensureClone 克隆 + alignToRemote 对齐教师 main 内容到工作副本", async () => {
    const git = makeServer();
    await git.ensureClone();
    // 教师推题后 alignToRemote 将 main 内容同步进服务端工作副本（对账扫描数据源）
    write(teacherDir, "week-01/exercise-01.py", "# 题目：两数之和\nprint(1)\n");
    run(["add", "-A"], teacherDir);
    run(["-c", "user.name=teacher", "-c", "user.email=t@x", "commit", "-m", "add ex01"], teacherDir);
    run(["push", "origin", "main"], teacherDir);
    await git.alignToRemote();
    expect(
      fs.readFileSync(path.join(base, "server-clone", "week-01", "exercise-01.py"), "utf8"),
    ).toContain("两数之和");
  }, 60_000);
});
