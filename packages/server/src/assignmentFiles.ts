import crypto from "node:crypto";
import { scanExerciseId, type SubmissionFile, type TestCase } from "@classroom/shared";

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

// —— V2.0 项目练习（spec §3）——

const IGNORE_DIRS = new Set(["__pycache__", ".venv", "venv", ".git"]);
const IGNORE_FILE_NAMES = new Set([".DS_Store"]);

export function isProjectIgnoredEntry(name: string, isDir: boolean): boolean {
  return isDir ? IGNORE_DIRS.has(name) : IGNORE_FILE_NAMES.has(name) || name.endsWith(".pyc");
}

export interface ParsedManifest {
  exerciseId: string | null;
  week: number | null;
  title: string | null;
  entry: string;              // 缺省 "main.py"
}

export function parseExerciseManifest(content: string): ParsedManifest | null {
  try {
    const raw = JSON.parse(content) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) return null;
    return {
      exerciseId: typeof raw.exerciseId === "string" ? raw.exerciseId : null,
      week: typeof raw.week === "number" ? raw.week : null,
      title: typeof raw.title === "string" ? raw.title : null,
      entry: typeof raw.entry === "string" && raw.entry ? raw.entry : "main.py",
    };
  } catch {
    return null;
  }
}

const sortFiles = (files: SubmissionFile[]) =>
  files.map((f) => ({ path: f.path, content: f.content }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/** 项目题目版本哈希（server 内部，16-hex，风格同 computeExerciseVersionHash） */
export function computeProjectVersionHash(files: SubmissionFile[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(sortFiles(files))).digest("hex").slice(0, 16);
}
