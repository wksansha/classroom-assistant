import type { RosterEntry } from "@classroom/shared";

/** 管理密码令牌（登录门校验通过后持久化；401 自动清除回登录态） */
export const ADMIN_TOKEN_KEY = "pylearner.admin.token";

export interface AdminSession {
  adminProtected: boolean;
  ok?: boolean;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(ADMIN_TOKEN_KEY);
  return token ? { "X-Admin-Token": token } : {};
}

/** 401 = 令牌失效（服务端改密码/过期策略）→ 清令牌回登录门 */
function rejectUnauthorized(): never {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
  window.location.reload();
  throw new Error("401");
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: authHeaders() });
  if (r.status === 401) rejectUnauthorized();
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return (await r.json()) as T;
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) rejectUnauthorized();
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return (await r.json()) as T;
}

/** 登录门探测：不走 401 自动重载（由 AdminView 自行处理错误提示） */
async function verifySession(): Promise<AdminSession> {
  const r = await fetch("/api/admin/session", { headers: authHeaders() });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as AdminSession;
}

/** 管理页 API（花名册行内优先交互，spec roster §4；请求自动附 X-Admin-Token） */
export const adminApi = {
  verifySession,
  roster: () => get<RosterEntry[]>("/api/roster"),
  /** 单条新增（补录转学生） */
  addRosterEntry: (studentId: string, studentName: string) =>
    send<{ ok: true }>("/api/roster/entry", "POST", { studentId, studentName }),
  /** 仅改姓名（学号不可改） */
  renameRosterEntry: (studentId: string, studentName: string) =>
    send<{ ok: true; studentId: string; studentName: string }>(`/api/roster/entry/${encodeURIComponent(studentId)}`, "PATCH", { studentName }),
  /** 软删除：仅移出名册，Gitea 凭证保留 */
  removeRosterEntry: (studentId: string) =>
    send<{ ok: true }>(`/api/roster/entry/${encodeURIComponent(studentId)}`, "DELETE"),
  /** 硬删除：删 Gitea 账户与学生分支（前端已二次确认） */
  purgeRosterEntry: (studentId: string) =>
    send<{ ok: true }>(`/api/roster/entry/${encodeURIComponent(studentId)}/purge`, "POST"),
};
