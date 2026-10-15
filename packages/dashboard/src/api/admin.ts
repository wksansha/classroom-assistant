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

/** 管理页 API（作业域退役后仅剩花名册） */
export const adminApi = {
  roster: () => get<RosterEntry[]>("/api/roster"),
  importRoster: (text: string) => send<{ ok: true; count: number }>("/api/roster", "POST", { text }),
};
