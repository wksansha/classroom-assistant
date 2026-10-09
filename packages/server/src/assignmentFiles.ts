import crypto from "node:crypto";
import { scanExerciseId, type TestCase } from "@classroom/shared";

const META_START = "# ===== classroom-assistant =====";
const META_END = "# ===============================";
const CODE_MARKER = "# ===== 代码区 =====";

export interface ParsedExerciseFile {
  exerciseId: string | null;
  week: number | null;
  problemStatement: string;
  starterCode: string;
}

export function parseExerciseFile(content: string): ParsedExerciseFile {
  const lines = content.split(/\r?\n/);
  const exerciseId = scanExerciseId(content);
  let week: number | null = null;
  for (const line of lines.slice(0, 20)) {
    const m = line.match(/^#\s*week:\s*(\d+)\s*$/);
    if (m) { week = parseInt(m[1], 10); break; }
  }
  // 内容提取（spec §2.2）：元数据块之后、代码区标记之前 = 题目描述；之后 = starterCode
  const startIdx = lines.indexOf(META_START);
  let descStart = 0;
  if (startIdx !== -1) {
    const endIdx = lines.indexOf(META_END, startIdx);
    descStart = endIdx !== -1 ? endIdx + 1 : startIdx + 1;
  }
  const codeIdx = lines.indexOf(CODE_MARKER);
  const descEnd = codeIdx === -1 ? lines.length : codeIdx;
  const problemStatement = lines.slice(descStart, descEnd)
    .map((l) => l.replace(/^#\s?/, "").trimEnd())
    .join("\n")
    .trim();
  const starterCode = codeIdx === -1 ? "" : lines.slice(codeIdx + 1).join("\n").trim();
  return { exerciseId, week, problemStatement, starterCode };
}

export function injectExerciseId(content: string, exerciseId: string, week: number): string {
  const lines = content.split(/\r?\n/);
  const idLine = `# exercise-id: ${exerciseId}`;
  const weekLine = `# week: ${week}`;
  const startIdx = lines.indexOf(META_START);
  if (startIdx === -1) {
    // 教师裸文件：前插完整元数据块（已有 coding 声明则不重复加）
    const hasCoding = (lines[0] ?? "").startsWith("# -*- coding");
    const header = [
      ...(hasCoding ? [] : ["# -*- coding: utf-8 -*-"]),
      META_START, idLine, weekLine, META_END, "",
    ];
    return [...header, ...lines].join("\n");
  }
  // 已有元数据块但缺 id（对账后仍需注入的场景）：插到块内起始标记之后
  return [...lines.slice(0, startIdx + 1), idLine, weekLine, ...lines.slice(startIdx + 1)].join("\n");
}

export function computeExerciseVersionHash(
  problemStatement: string,
  testCases?: TestCase[] | null,
  starterCode?: string | null,
): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify([problemStatement, testCases ?? [], starterCode ?? ""]))
    .digest("hex")
    .slice(0, 16);
}
