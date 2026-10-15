import type {
  Exercise, NormalizedEvent, ReviewResult, SSEMessage, SubmissionFile, ReviewRequestInput,
} from "@classroom/shared";
import type { Persistence } from "../persistence";
import type { ReviewService } from "../reviewService";
import type { StateManager } from "../stateManager";
import { validateFiles } from "./submissionController";
import { resolveExercisesByFiles } from "./exerciseResolver";
import { logEvent } from "../logger";

export interface ReviewRequestDeps {
  persistence: Persistence;
  reviewService: ReviewService;
  stateManager: StateManager;
  publish: (msg: SSEMessage) => void;
  publishSnapshot: () => void;   // fail 注入后推全量快照（告警/聚合面板刷新）
}

export type ReviewRequestResult =
  | { ok: true; review: ReviewResult; submissionId: string | null }
  | { ok: false; status: 400 | 404; error: string };

/** 评审输入组装（spec §4.2）：入口 + 其余 .py 按路径拼接，非 .py 素材不入 */
export function buildReviewInput(exercise: Pick<Exercise, "entry">, code: string, files?: SubmissionFile[]): string {
  if (!files) return code;
  const entry = exercise.entry ?? "main.py";
  const others = files
    .filter((f) => f.path.endsWith(".py") && f.path !== entry)
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return [code, ...others.map((f) => `\n\n# ===== 文件: ${f.path} =====\n${f.content}`)].join("");
}

/** fail 合成事件注入 stateManager（spec §4.3）：进告警面板 + 知识点聚合 */
function injectReviewFail(
  deps: ReviewRequestDeps,
  args: { studentId: string; studentName: string; review: ReviewResult },
): void {
  const ev: NormalizedEvent = {
    studentId: args.studentId, studentName: args.studentName, classId: "default",
    eventType: "run", success: false,
    errorType: "review_fail", errorMessage: args.review.reason, samples: [],
    rawMessage: `评审未通过：${args.review.reason}`, cacheKey: null, ts: Date.now(),
  };
  deps.stateManager.apply(ev, { category: "逻辑错误", subtype: "review_fail", knowledge: args.review.reason });
  deps.publishSnapshot();
  logEvent({ event: "review.fail_injected", level: "info", data: { studentId: args.studentId, exerciseId: undefined, reason: args.review.reason } });
}

/** 学生分支直连模型（spec §6.2）：练习定位 = 文件路径（服务端为唯一练习注册表，学生端零识别） */
export async function requestReview(deps: ReviewRequestDeps, input: ReviewRequestInput): Promise<ReviewRequestResult> {
  if (!input || typeof input.studentId !== "string" || !input.studentName
    || typeof input.filePath !== "string" || !input.filePath
    || typeof input.code !== "string") {
    return { ok: false, status: 400, error: "缺少必要字段" };
  }
  const rosterEntry = deps.persistence.getRosterEntry(input.studentId.trim());
  if (!rosterEntry) return { ok: false, status: 400, error: "学号不在名册" };
  const hits = resolveExercisesByFiles(deps.persistence, [input.filePath]);
  const exercise = hits.length > 0 ? deps.persistence.getExercise(hits[0].exerciseId) : null;
  if (!exercise || !exercise.isActive) return { ok: false, status: 404, error: "not-exercise" };
  const assignment = deps.persistence.getAssignment(exercise.assignmentId);
  if (!assignment || !assignment.isPublished) return { ok: false, status: 400, error: "练习未发布" };

  const kind = exercise.kind ?? "file";
  if (kind === "project") {
    if (!input.files) return { ok: false, status: 400, error: "项目练习必须携带 files" };
    const verr = validateFiles(input.files);
    if (verr) return { ok: false, status: 400, error: verr };
    const entry = exercise.entry ?? "main.py";
    const entryFile = input.files.find((f) => f.path === entry);
    if (!entryFile) return { ok: false, status: 400, error: `缺少入口文件 ${entry}` };
    if (entryFile.content !== input.code) return { ok: false, status: 400, error: "code 与入口文件内容不一致" };
  }
  if (Buffer.byteLength(input.code, "utf8") > 50 * 1024) {
    return { ok: false, status: 400, error: "代码超过 50KB 限制" };
  }

  const reviewCode = buildReviewInput(exercise, input.code, kind === "project" ? input.files : undefined);
  const review = await deps.reviewService.review(
    { id: exercise.id, versionHash: exercise.versionHash, problemStatement: exercise.problemStatement,
      testCases: exercise.testCases, filePath: input.filePath },   // 缓存 key 路径化（spec §6.3）
    reviewCode,
  );

  // 评审回填轻量索引（spec §6.2）：(exercise_id, student_id, commit_hash) 定位 submission_notify 行；
  // commitHash 为空（未提交）→ 跳过回填，仅 review_cache 生效
  const commitHash = (input.commitHash ?? "").trim();
  const notifyRow = commitHash
    ? deps.persistence.getNotifyRowsByStudent(rosterEntry.studentId)
        .find((r) => r.exerciseId === exercise.id && r.commitHash === commitHash) ?? null
    : null;
  if (notifyRow) {
    deps.persistence.updateNotifyReview(notifyRow.id, review);
    deps.publish({ type: "review_complete", data: {
      submissionId: notifyRow.id, exerciseId: exercise.id, studentId: rosterEntry.studentId,
      assignmentId: assignment.id, submittedAt: notifyRow.submittedAt, review } });
    if (review.status === "fail") {
      injectReviewFail(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, review });
    }
  }
  return { ok: true, review, submissionId: notifyRow?.id ?? null };
}
