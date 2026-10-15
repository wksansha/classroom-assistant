import { randomUUID } from "node:crypto";
import type { Persistence } from "../persistence";

interface NotifyDeps { persistence: Persistence }

/** 提交通知（spec §5/§0）：花名册校验 → 每次 push 一行原样入库（UNIQUE(student, commit) 幂等），无练习对照 */
export function handleNotify(deps: NotifyDeps, body: any): { status: number; body: unknown } {
  const { studentId, commitHash, files, pushedAt } = body ?? {};
  if (!studentId || !commitHash || !Array.isArray(files)) return { status: 400, body: { error: "缺少必要字段" } };
  const roster = deps.persistence.getRosterEntry(String(studentId).trim());
  if (!roster) return { status: 400, body: { error: "学号不在名册" } };
  const inserted = deps.persistence.insertNotifyRow({
    id: randomUUID(), studentId: roster.studentId, studentName: roster.studentName,
    commitHash: String(commitHash), filesJson: JSON.stringify(files), submittedAt: Number(pushedAt) || Date.now(),
  });
  return { status: 200, body: { ok: true, inserted } };
}
