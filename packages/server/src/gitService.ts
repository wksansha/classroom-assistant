import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface GitServiceDeps {
  repoDir: string;
  remoteUrl: string;
  authorEmailDomain?: string;   // 默认 classroom
}

/** 服务端仅保留只读对齐（spec §6.3：注入回写退役，对教师仓库只读；学生分支由学生机直推 Gitea） */
export interface GitService {
  ensureClone(): Promise<void>;
  alignToRemote(): Promise<void>;
}

export function createGitService(deps: GitServiceDeps): GitService {
  const domain = deps.authorEmailDomain ?? process.env.GIT_AUTHOR_EMAIL_DOMAIN ?? "classroom";

  // —— git 操作串行化（A13：模块实例级 promise chain mutex）——
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
  };
}
