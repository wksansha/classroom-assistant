import crypto, { randomUUID } from "node:crypto";
import type { SSEMessage, Submission, SubmissionInput } from "@classroom/shared";
import type { Persistence } from "../persistence";
import type { ReviewService } from "../reviewService";
import type { GitService } from "../gitService";
import { logEvent } from "../logger";

export interface SubmissionDeps {
  persistence: Persistence;
  reviewService: ReviewService;
  git: GitService | null;             // 未配置 → 跳过归档（git_synced 保持 0，同步任务补推）
  publish: (msg: SSEMessage) => void;
}

export function computeCodeHash(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export type CreateSubmissionResult =
  | { ok: true; created: boolean; submission: Submission }
  | { ok: false; status: 400; error: string };

/** 校验链 + 入库 + 异步发起评审/git 归档（spec §4.4；同步函数，立即返回） */
export function createSubmission(deps: SubmissionDeps, input: SubmissionInput): CreateSubmissionResult {
  const { persistence } = deps;
  if (!input?.exerciseId || !input.studentId || typeof input.code !== "string") {
    return { ok: false, status: 400, error: "缺少必要字段" };
  }
  if (Buffer.byteLength(input.code, "utf8") > 50 * 1024) {
    return { ok: false, status: 400, error: "代码超过 50KB 限制" };
  }
  const exercise = persistence.getExercise(input.exerciseId);
  if (!exercise || !exercise.isActive) return { ok: false, status: 400, error: "练习不存在或已下线" };
  const assignment = persistence.getAssignment(exercise.assignmentId);
  if (!assignment || !assignment.isPublished) return { ok: false, status: 400, error: "练习未发布" };
  const rosterEntry = persistence.getRosterEntry(input.studentId.trim());
  if (!rosterEntry) return { ok: false, status: 400, error: "学号不在名册" };

  const codeHash = computeCodeHash(input.code);
  const existing = persistence.findSubmissionByKey(exercise.id, rosterEntry.studentId, codeHash);
  if (existing) {
    // A30：终态直接返回；unreviewed（瞬态）重新入队评审
    if (!existing.review || existing.review.status === "unreviewed") {
      void runReviewAndPublish(deps, existing).catch((err) =>
        logEvent({ event: "review.resubmit_error", level: "warn", data: { submissionId: existing.id, error: String(err) } }));
    }
    return { ok: true, created: false, submission: existing };
  }

  const submission: Submission = {
    id: randomUUID(), exerciseId: exercise.id, studentId: rosterEntry.studentId,
    studentName: rosterEntry.studentName, code: input.code,
    source: input.source === "manual" ? "manual" : "auto",
    submittedAt: Date.now(), review: null,
  };
  persistence.insertSubmission({ ...submission, codeHash, gitSynced: false });
  deps.publish({ type: "submission_received", data: {
    submissionId: submission.id, exerciseId: exercise.id, studentId: submission.studentId,
    assignmentId: assignment.id, submittedAt: submission.submittedAt } });
  // §4.4 并行两路异步：① 评审（→ review_complete）② git 归档（不等评审，A15）
  void runReviewAndPublish(deps, submission).catch((err) =>
    logEvent({ event: "review.async_error", level: "error", data: { submissionId: submission.id, error: String(err) } }));
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
    week: assignment.week, filename: exercise.filename, content: submission.code,
  });
  if (r === "ok") deps.persistence.setSubmissionGitSynced(submission.id);
  else logEvent({ event: "git.push_failed", level: "error", data: { submissionId: submission.id, result: r } });
}

export async function runReviewAndPublish(deps: SubmissionDeps, submission: Submission): Promise<void> {
  const exercise = deps.persistence.getExercise(submission.exerciseId);
  const assignment = exercise ? deps.persistence.getAssignment(exercise.assignmentId) : null;
  if (!exercise || !assignment) return;
  const review = await deps.reviewService.review(exercise, submission.code);
  deps.persistence.updateSubmissionReview(submission.id, review);
  deps.publish({ type: "review_complete", data: {
    submissionId: submission.id, exerciseId: exercise.id, studentId: submission.studentId,
    assignmentId: assignment.id, submittedAt: submission.submittedAt, review } });
}

/** 启动补扫（A29）：review_json IS NULL 的提交重新入队评审（单条失败不中断整体补扫） */
export async function rescanPendingReviews(deps: SubmissionDeps): Promise<number> {
  let n = 0;
  for (const sub of deps.persistence.getPendingReviewSubmissions()) {
    try {
      await runReviewAndPublish(deps, sub);
      n++;
    } catch (err) {
      logEvent({ event: "review.rescan_error", level: "warn", data: { submissionId: sub.id, error: String(err) } });
    }
  }
  return n;
}
