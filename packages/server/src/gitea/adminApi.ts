import { randomUUID } from "node:crypto";

export interface GiteaAdminDeps {
  baseUrl: string;
  adminToken: string;
  /** 如 `classroom/exercises` */
  repo: string;
  fetchImpl?: typeof fetch;
}

export interface GiteaAdmin {
  /** 每生一 Gitea 账户（用户名=学号）+ 专属 token；返回该生 token sha1 */
  ensureStudentAccount(studentId: string): Promise<string>;
  /** student-<学号> 分支保护：仅该生可推 */
  protectBranch(studentId: string): Promise<void>;
}

export function createGiteaAdmin(deps: GiteaAdminDeps): GiteaAdmin {
  const doFetch = deps.fetchImpl ?? fetch;
  async function api(path: string, method: string, body?: unknown): Promise<Response> {
    return doFetch(`${deps.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `token ${deps.adminToken}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
  async function createToken(studentId: string): Promise<string> {
    const name = `classroom-${studentId}`;
    const created = await api(`/api/v1/users/${studentId}/tokens`, "POST", { name, scopes: ["write:repository", "read:repository"] });
    if (!created.ok) throw new Error(`gitea token create failed: ${created.status}`);
    return ((await created.json()) as { sha1: string }).sha1;
  }
  return {
    async ensureStudentAccount(studentId: string): Promise<string> {
      const create = await api("/api/v1/admin/users", "POST", {
        username: studentId, email: `${studentId}@classroom.local`,
        full_name: studentId, password: randomUUID(), must_change_password: false,
      });
      if (!create.ok && create.status !== 422) throw new Error(`gitea user create failed: ${create.status}`);   // 422=已存在
      try {
        return await createToken(studentId);                       // 已有同名 token → 422 → 删旧重建
      } catch {
        await api(`/api/v1/users/${studentId}/tokens/classroom-${studentId}`, "DELETE").catch(() => {});
        return createToken(studentId);
      }
    },
    async protectBranch(studentId: string): Promise<void> {
      const r = await api(`/api/v1/repos/${deps.repo}/branch_protections`, "POST", {
        branch_name: `student-${studentId}`, rule_name: `only-${studentId}`,
        enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: [studentId],
      });
      if (!r.ok && r.status !== 422) throw new Error(`gitea branch protect failed: ${r.status}`);
    },
  };
}
