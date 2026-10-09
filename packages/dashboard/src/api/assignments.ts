import type { Assignment, Exercise, PublishedAssignment, RosterEntry, Submission } from "@classroom/shared";

export interface SyncResult {
  importedNew: number; updated: number; injected: number; deactivated: number; warnings: string[];
}

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

export const assignmentsApi = {
  list: () => get<(Assignment & { exercises: Exercise[] })[]>("/api/assignments"),
  detail: (id: string) => get<Assignment & { exercises: Exercise[] }>(`/api/assignments/${id}`),
  patch: (id: string, patch: { title?: string; dueAt?: number | null }) =>
    send<Assignment & { exercises: Exercise[] }>(`/api/assignments/${id}`, "PATCH", patch),
  publish: (id: string, publish: boolean) => send<{ ok: true }>(`/api/assignments/${id}/publish`, "POST", { publish }),
  publishedList: () => get<PublishedAssignment[]>("/api/assignments/published"),
  submissionsByExercise: (exerciseId: string) => get<Submission[]>(`/api/submissions/exercise/${exerciseId}`),
  submissionsByStudent: (studentId: string) => get<Submission[]>(`/api/submissions/student/${studentId}`),
  roster: () => get<RosterEntry[]>("/api/roster"),
  importRoster: (text: string) => send<{ ok: true; count: number }>("/api/roster", "POST", { text }),
  sync: () => send<SyncResult>("/api/sync", "POST"),
};
