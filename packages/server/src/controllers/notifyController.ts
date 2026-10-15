import { randomUUID } from "node:crypto";
import type { SSEMessage } from "@classroom/shared";
import type { Persistence } from "../persistence";
import { resolveExercisesByFiles } from "./exerciseResolver";

interface NotifyDeps { persistence: Persistence; publish: (msg: SSEMessage) => void }

export function handleNotify(deps: NotifyDeps, body: any): { status: number; body: unknown } {
  const { studentId, commitHash, files, pushedAt } = body ?? {};
  if (!studentId || !commitHash || !Array.isArray(files)) return { status: 400, body: { error: "缺少必要字段" } };
  const roster = deps.persistence.getRosterEntry(String(studentId).trim());
  if (!roster) return { status: 400, body: { error: "学号不在名册" } };
  const hits = resolveExercisesByFiles(deps.persistence, files);
  const inserted: string[] = [];
  for (const { exerciseId } of hits) {
    const ok = deps.persistence.insertNotifyRow({
      id: randomUUID(), exerciseId, studentId: roster.studentId, studentName: roster.studentName,
      commitHash: String(commitHash), filesJson: JSON.stringify(files), submittedAt: Number(pushedAt) || Date.now(),
    });
    if (ok) inserted.push(exerciseId);
  }
  // SSE 逐练习广播（旧形状消息，消费者零改动）
  for (const exerciseId of inserted) {
    deps.publish({ type: "submission_received", data: {
      submissionId: `${commitHash}:${exerciseId}`, exerciseId, studentId: roster.studentId,
      assignmentId: "", submittedAt: Number(pushedAt) || Date.now() } });
  }
  return { status: 200, body: { ok: true, exercises: inserted.length } };
}
