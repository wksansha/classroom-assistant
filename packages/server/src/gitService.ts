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

/** 服务端仅保留 main 侧操作（spec §6.3：注入回写退役，对教师仓库只读；学生分支由学生机直推 Gitea） */
export interface GitService {
  ensureClone(): Promise<void>;
  alignToRemote(): Promise<void>;
  hasUnpushedMainCommits(): Promise<boolean>;
  pushMain(): Promise<GitPushResult>;
  commitAndPushMain(files: { path: string; content: string }[], message: string): Promise<GitPushResult>;
  /** 从本地 main ref 读取文件内容（relPath 用 POSIX 分隔符） */
  readFileFromMain(relPath: string): Promise<string>;
  /** 列出 main ref 下某目录的全部文件（只读 ref 不入 mutex） */
  listFilesFromMain(dirRel: string): Promise<string[]>;
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

    async readFileFromMain(relPath) {
      // 只读 ref 操作，不入 mutex：git 引用读取原子，与写操作并发安全
      return git(["show", `main:${relPath}`]);
    },
    async listFilesFromMain(dirRel) {
      // 只读 ref 操作，不入 mutex（与 readFileFromMain 同理）
      const out = await git(["ls-tree", "-r", "--name-only", `main:${dirRel}`]);
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    },
  };
}
