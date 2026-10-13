import crypto, { randomUUID } from "node:crypto";
import type { SSEMessage, Submission, SubmissionInput, SubmissionFile, ReviewResult } from "@classroom/shared";
import type { Persistence } from "../persistence";
import type { GitService } from "../gitService";
import { canonicalFilesHash } from "../assignmentFiles";
import { logEvent } from "../logger";

export interface SubmissionDeps {
  persistence: Persistence;
  git: GitService | null;             // 未配置 → 跳过归档（git_synced 保持 0，同步任务补推）
  publish: (msg: SSEMessage) => void;
}

export function computeCodeHash(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

const MAX_FILES = 50;
const MAX_FILE_BYTES = 100 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024;

/** files 快照校验（V2.0 wire 约束，spec §4.1）；返回 null = 通过，否则错误文案 */
export function validateFiles(files: SubmissionFile[]): string | null {
  if (!Array.isArray(files) || files.length === 0) return "files 不能为空";
  if (files.length > MAX_FILES) return "文件数超过 50 上限";
  let total = 0;
  for (const f of files) {
    if (!f || typeof f.path !== "string" || !f.path || typeof f.content !== "string") return "文件项缺少 path/content";
    if (f.path.includes("\\") || f.path.startsWith("/") || /^[a-zA-Z]:/.test(f.path) || f.path.split("/").includes("..")) {
      return `非法路径：${f.path}`;
    }
    if (f.path.split("/").some((seg) => ["__pycache__", ".venv", "venv", ".git"].includes(seg) || seg.endsWith(".pyc") || seg === ".DS_Store")) {
      return `不应提交的文件：${f.path}`;
    }
    const size = Buffer.byteLength(f.content, "utf8");
    if (size > MAX_FILE_BYTES) return `文件超过 100KB：${f.path}`;
    total += size;
  }
  if (total > MAX_TOTAL_BYTES) return "项目总大小超过 500KB";
  return null;
}

export type CreateSubmissionResult =
  | { ok: true; created: boolean; submission: Submission }
  | { ok: false; status: 400; error: string };

/** 校验链 + 纯归档入库（spec §4.1：review NULL 为合法终态，不触发评审）+ 异步 git 归档；同步函数，立即返回 */
export function createSubmission(deps: SubmissionDeps, input: SubmissionInput): CreateSubmissionResult {
  const { persistence } = deps;
  if (!input?.exerciseId || !input.studentId || typeof input.code !== "string") {
    return { ok: false, status: 400, error: "缺少必要字段" };
  }
  const exercise = persistence.getExercise(input.exerciseId);
  if (!exercise || !exercise.isActive) return { ok: false, status: 400, error: "练习不存在或已下线" };
  const assignment = persistence.getAssignment(exercise.assignmentId);
  if (!assignment || !assignment.isPublished) return { ok: false, status: 400, error: "练习未发布" };
  const rosterEntry = persistence.getRosterEntry(input.studentId.trim());
  if (!rosterEntry) return { ok: false, status: 400, error: "学号不在名册" };

  const kind = exercise.kind ?? "file";
  let codeHash: string;
  let files: SubmissionFile[] | null;
  if (kind === "project") {
    if (!input.files) return { ok: false, status: 400, error: "项目练习必须提交 files" };
    const verr = validateFiles(input.files);
    if (verr) return { ok: false, status: 400, error: verr };
    const entry = exercise.entry ?? "main.py";
    const entryFile = input.files.find((f) => f.path === entry);
    if (!entryFile) return { ok: false, status: 400, error: `缺少入口文件 ${entry}` };
    if (entryFile.content !== input.code) return { ok: false, status: 400, error: "code 与入口文件内容不一致" };
    if (Buffer.byteLength(input.code, "utf8") > 50 * 1024) return { ok: false, status: 400, error: "代码超过 50KB 限制" };
    codeHash = canonicalFilesHash(input.files);
    files = input.files;
  } else {
    if (input.files) return { ok: false, status: 400, error: "单文件练习不支持 files" };
    if (Buffer.byteLength(input.code, "utf8") > 50 * 1024) return { ok: false, status: 400, error: "代码超过 50KB 限制" };
    codeHash = computeCodeHash(input.code);
    files = null;
  }

  // 纯归档（spec §4.1）：幂等命中直接返回，不重评
  const existing = persistence.findSubmissionByKey(exercise.id, rosterEntry.studentId, codeHash);
  if (existing) return { ok: true, created: false, submission: existing };

  const submission: Submission = {
    id: randomUUID(), exerciseId: exercise.id, studentId: rosterEntry.studentId,
    studentName: rosterEntry.studentName, code: input.code,
    source: input.source === "manual" ? "manual" : "auto",
    submittedAt: Date.now(), review: null, files,
  };
  persistence.insertSubmission({ ...submission, codeHash, gitSynced: false });
  deps.publish({ type: "submission_received", data: {
    submissionId: submission.id, exerciseId: exercise.id, studentId: submission.studentId,
    assignmentId: assignment.id, submittedAt: submission.submittedAt } });
  void archiveToGit(deps, submission).catch((err) =>
    logEvent({ event: "git.async_error", level: "error", data: { submissionId: submission.id, error: String(err) } }));
  return { ok: true, created: true, submission };
}

async function archiveToGit(deps: SubmissionDeps, submission: Submission): Promise<void> {
  if (!deps.git) return;
  const exercise = deps.persistence.getExercise(submission.exerciseId);
  const assignment = exercise ? deps.persistence.getAssignment(exercise.assignmentId) : null;
  if (!exercise || !assignment) return;
  const r = await deps.git.writeToStudentBranch({
    studentId: submission.studentId, studentName: submission.studentName,
    week: assignment.week, weekDir: assignment.weekDir, filename: exercise.filename, content: submission.code,
    files: submission.files ?? undefined,
  });
  if (r === "ok") deps.persistence.setSubmissionGitSynced(submission.id);
  else logEvent({ event: "git.push_failed", level: "error", data: { submissionId: submission.id, result: r } });
}
