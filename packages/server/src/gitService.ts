import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { logEvent } from "./logger";

const execFileAsync = promisify(execFile);

export interface GitServiceDeps {
  repoDir: string;
  remoteUrl: string;
  authorEmailDomain?: string;   // 默认 classroom
}

export type GitPushResult = "ok" | "rejected" | "error";

export interface GitService {
  ensureClone(): Promise<void>;
  alignToRemote(): Promise<void>;
  hasUnpushedMainCommits(): Promise<boolean>;
  pushMain(): Promise<GitPushResult>;
  commitAndPushMain(files: { path: string; content: string }[], message: string): Promise<GitPushResult>;
  createStudentBranches(studentIds: string[]): Promise<void>;
  writeToStudentBranch(args: { studentId: string; studentName: string; week: number; filename: string; content: string }): Promise<GitPushResult>;
}

export function createGitService(deps: GitServiceDeps): GitService {
  const domain = deps.authorEmailDomain ?? process.env.GIT_AUTHOR_EMAIL_DOMAIN ?? "classroom";

  // —— 全部 git 写操作串行化（A13：模块实例级 promise chain mutex）——
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  }

  async function git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: deps.repoDir, timeout: 30_000 });
    return stdout;
  }

  async function pushMainWithRetry(): Promise<GitPushResult> {
    try {
      await git(["push", "origin", "main"]);
      return "ok";
    } catch {
      logEvent({ event: "git.push_rejected", level: "warn", data: { branch: "main" } });
    }
    try {
      await git(["fetch", "origin"]);
      try {
        await git(["rebase", "origin/main"]);
      } catch {
        await git(["rebase", "--abort"]);
        return "rejected";   // 冲突：调用方丢弃重生成（注入幂等，A28）
      }
      await git(["push", "origin", "main"]);
      return "ok";
    } catch (err) {
      logEvent({ event: "git.push_failed", level: "error", data: { error: err instanceof Error ? err.message : String(err) } });
      return "error";
    }
  }

  function writeFiles(files: { path: string; content: string }[]) {
    for (const f of files) {
      const abs = path.join(deps.repoDir, f.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content, "utf8");
    }
  }

  return {
    async ensureClone() {
      return enqueue(async () => {
        if (fs.existsSync(path.join(deps.repoDir, ".git"))) return;
        fs.mkdirSync(path.dirname(deps.repoDir), { recursive: true });
        await execFileAsync("git", ["clone", deps.remoteUrl, deps.repoDir]);
        await git(["config", "user.name", "classroom-server"]);
        await git(["config", "user.email", `server@${domain}`]);
      });
    },

    async alignToRemote() {
      return enqueue(async () => {
        await git(["fetch", "origin"]);
        await git(["checkout", "-B", "main", "origin/main"]);
        await git(["reset", "--hard", "origin/main"]);
        await git(["clean", "-fd"]);
      });
    },

    async hasUnpushedMainCommits() {
      return enqueue(async () => {
        await git(["fetch", "origin"]);
        const count = (await git(["rev-list", "--count", "origin/main..main"])).trim();
        return parseInt(count, 10) > 0;
      });
    },

    async pushMain() {
      return enqueue(() => pushMainWithRetry());
    },

    async commitAndPushMain(files, message) {
      return enqueue(async () => {
        await git(["checkout", "main"]);
        writeFiles(files);
        await git(["add", "-A"]);
        try {
          await git(["commit", "-m", message]);
        } catch {
          return "ok";   // nothing to commit（内容未变，幂等）
        }
        return pushMainWithRetry();
      });
    },

    async createStudentBranches(studentIds) {
      return enqueue(async () => {
        await git(["fetch", "origin"]);
        for (const id of studentIds) {
          const branch = `student-${id}`;
          const heads = await git(["ls-remote", "--heads", "origin", branch]);
          if (heads.trim()) continue;   // 已存在跳过
          await git(["push", "origin", `origin/main:refs/heads/${branch}`]);
        }
      });
    },

    async writeToStudentBranch(args) {
      return enqueue(async () => {
        const branch = `student-${args.studentId}`;
        await git(["fetch", "origin"]);
        const local = await git(["branch", "--list", branch]);
        if (!local.trim()) await git(["branch", branch, "origin/main"]);
        await git(["checkout", branch]);
        try {
          await git(["pull", "--ff-only", "origin", branch]);
        } catch {
          /* 远端尚无此分支（首提）→ 忽略 */
        }
        const rel = `week-${String(args.week).padStart(2, "0")}/${args.filename}`;
        writeFiles([{ path: rel, content: args.content }]);
        await git(["add", "-A"]);
        await git(["commit",
          "-m", `submit: ${rel} by ${args.studentId} ${args.studentName}`,
          `--author=${args.studentId} ${args.studentName} <${args.studentId}@${domain}>`,
        ]);
        try {
          await git(["push", "origin", branch]);
          return "ok";
        } catch {
          // 单写者分支，理论不发生；兜底同 main：fetch+rebase+重试
          await git(["fetch", "origin"]);
          try {
            await git(["rebase", `origin/${branch}`]);
          } catch {
            await git(["rebase", "--abort"]);
            return "rejected";
          }
          await git(["push", "origin", branch]);
          return "ok";
        }
      });
    },
  };
}
