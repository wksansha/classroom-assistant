import { randomBytes } from "node:crypto";
import { logEvent } from "../logger";

export interface GiteaAdminDeps {
  baseUrl: string;
  adminToken: string;
  /** 如 `classroom/exercises` */
  repo: string;
  fetchImpl?: typeof fetch;
}

export interface GiteaAdmin {
  /** 每生一 Gitea 账户（用户名=学号），密码收敛为服务端持有的 gitSecret；返回该生 gitSecret（学生 git 用「学号:密码」Basic 认证） */
  ensureStudentAccount(studentId: string): Promise<string>;
  /** student-<学号> 分支保护：仅该生可推 */
  protectBranch(studentId: string): Promise<void>;
  /** 学生加入教师仓库为协作者（write 权限——push 自己分支的前提，真实 Gitea 28 联调实测必需） */
  addCollaborator(studentId: string): Promise<void>;
  /** 硬删除联动（spec roster §1.1）：删分支保护规则 → 删 student-<id> 分支 → 删 Gitea 账户；任一步 404 视为已完成继续 */
  purgeStudent(studentId: string): Promise<void>;
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
  return {
    async ensureStudentAccount(studentId: string): Promise<string> {
      // Gitea 的 token 创建 API 不允许 token 认证（须用户密码 Basic），admin 代建 token 不可行；
      // 改为：服务端生成密码 → 建号携带 → 无条件 PATCH 收敛（已存在用户的旧密码也统一到服务端持有值）
      const gitSecret = randomBytes(12).toString("base64url");   // base64url 仅字母数字+-_，无 :/@?# 等 URL 特殊字符
      const create = await api("/api/v1/admin/users", "POST", {
        username: studentId, email: `${studentId}@classroom.local`,
        full_name: studentId, password: gitSecret, must_change_password: false,
      });
      if (!create.ok && create.status !== 409 && create.status !== 422) throw new Error(`gitea user create failed: ${create.status}`);   // 409/422=已存在
      const patch = await api(`/api/v1/admin/users/${studentId}`, "PATCH", { password: gitSecret });
      if (!patch.ok && patch.status !== 404) throw new Error(`gitea password patch failed: ${patch.status}`);
      return gitSecret;
    },
    async protectBranch(studentId: string): Promise<void> {
      const r = await api(`/api/v1/repos/${deps.repo}/branch_protections`, "POST", {
        rule_name: `student-${studentId}`,   // Gitea 28：rule_name 即分支匹配模式（字面分支名 student-XXXX），branch_name 已废弃
        enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: [studentId],
      });
      if (!r.ok && r.status !== 422) throw new Error(`gitea branch protect failed: ${r.status}`);
    },
    async addCollaborator(studentId: string): Promise<void> {
      const r = await api(`/api/v1/repos/${deps.repo}/collaborators/${studentId}`, "PUT", { permission: "write" });
      // 204/200=成功；409=已是协作者（幂等重试容忍）；其余状态抛错
      if (r.status !== 204 && r.status !== 200 && r.status !== 409) throw new Error(`gitea collaborator add failed: ${r.status}`);
    },
    async purgeStudent(studentId: string): Promise<void> {
      // 1. 找到该生分支保护规则并删除（Gitea 28：规则对象无 id 字段，按 rule_name 删；无规则则跳过）
      const list = await api(`/api/v1/repos/${deps.repo}/branch_protections`, "GET");
      if (list.ok) {
        const rules = (await list.json()) as Array<{ id?: number; rule_name: string }>;
        const rule = rules.find((r) => r.rule_name === `student-${studentId}`);
        if (rule) {
          const key = rule.rule_name ?? rule.id;   // 新版 Gitea 按 rule_name 删，旧版按 id
          const del = await api(`/api/v1/repos/${deps.repo}/branch_protections/${key}`, "DELETE");
          if (!del.ok && del.status !== 404) throw new Error(`gitea branch protection delete failed: ${del.status}`);
        }
      } else {
        // F4：列取分支保护规则非 2xx 不再静默跳过（规则可能残留），记 warn 供排查
        logEvent({ event: "gitea.protection_list_failed", level: "warn", data: { studentId, status: list.status } });
      }
      // 2. 删学生分支（404=已无分支，视为已完成）
      const delBranch = await api(`/api/v1/repos/${deps.repo}/branches/student-${studentId}`, "DELETE");
      if (!delBranch.ok && delBranch.status !== 404) throw new Error(`gitea branch delete failed: ${delBranch.status}`);
      // 3. 删 Gitea 账户（404=已删，视为已完成）
      const delUser = await api(`/api/v1/admin/users/${studentId}`, "DELETE");
      if (!delUser.ok && delUser.status !== 404) throw new Error(`gitea user delete failed: ${delUser.status}`);
    },
  };
}
