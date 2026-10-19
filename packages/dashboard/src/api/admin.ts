import type { RosterEntry } from "@classroom/shared";

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return (await r.json()) as T;
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return (await r.json()) as T;
}

/** 管理页 API（花名册行内优先交互，spec roster §4） */
export const adminApi = {
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
