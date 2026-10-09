import type { RosterEntry } from "@classroom/shared";
import type { Persistence } from "../persistence";

/** 名册文本解析：每行「学号 姓名」，首段=学号、其余=姓名；空行/缺姓名的行跳过（spec §3） */
export function parseRosterText(text: string): RosterEntry[] {
  const entries: RosterEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(\S.*)$/);
    if (m) entries.push({ studentId: m[1], studentName: m[2].trim() });
  }
  return entries;
}

export interface IdentityValidateBody { studentId?: string; studentName?: string; }

export type IdentityValidateResult =
  | { ok: true; studentName: string }
  | { ok: false; code: "roster_empty" | "student_id_not_found" | "name_mismatch"; message: string };

/** 身份校验（A25）：错误码与文案 = spec §6.5 表格逐字 */
export function validateIdentity(p: Persistence, body: IdentityValidateBody): IdentityValidateResult {
  if (p.getRoster().length === 0) {
    return { ok: false, code: "roster_empty", message: "教师尚未导入名册，请联系教员后再试" };
  }
  const entry = p.getRosterEntry((body.studentId ?? "").trim());
  if (!entry) {
    return { ok: false, code: "student_id_not_found", message: "学号输入有误，请检查或联系教员" };
  }
  if (entry.studentName !== (body.studentName ?? "").trim()) {
    return { ok: false, code: "name_mismatch", message: "姓名与该学号不匹配，请检查或联系教员" };
  }
  return { ok: true, studentName: entry.studentName };
}
