import type {
  NormalizedEvent, ReviewResult, SubmissionFile, ReviewRequestInput,
} from "@classroom/shared";
import type { Persistence } from "../persistence";
import type { ReviewService } from "../reviewService";
import type { StateManager } from "../stateManager";
import type { ExerciseProgressTracker } from "../exerciseProgress";
import { logEvent } from "../logger";

export interface ReviewRequestDeps {
  persistence: Persistence;
  reviewService: ReviewService;
  stateManager: StateManager;
  exerciseProgress: ExerciseProgressTracker;   // 题目进度矩阵（spec dashboard-v2 §5.3）
  publishSnapshot: () => void;   // fail 注入后推全量快照（告警/聚合面板刷新）
}

export type ReviewRequestResult =
  | { ok: true; review: ReviewResult }
  | { ok: false; status: 400; error: string };

const MAX_FILES = 50;
const MAX_FILE_BYTES = 100 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024;

/** 项目 files 快照校验（review wire 约束）；返回 null = 通过，否则错误文案 */
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

/** 项目评审输入组装（spec §0.2）：全部 .py 按路径排序拼接（带路径头），非 .py 不入 */
export function buildProjectReviewInput(files: SubmissionFile[]): string {
  return files
    .filter((f) => f.path.endsWith(".py"))
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((f) => `# ===== 文件: ${f.path} =====\n${f.content}`)
    .join("\n\n");
}

/** 评审结果落库 + 喂养题目进度（spec dashboard-v2 §5.2/§5.3）：pass/fail/unreviewed 三态均落行
 * （本表是题目进度事实源，unreviewed 落行支撑重启回放；缓存表「unreviewed 不缓存」约束不变）；
 * 写失败不阻塞评审响应（log warn 后继续） */
function persistReviewResult(
  deps: ReviewRequestDeps,
  args: { studentId: string; studentName: string; filePath: string; status: "pass" | "fail" | "unreviewed"; reason: string | null },
): void {
  try {
    deps.persistence.saveReviewResult({
      studentId: args.studentId, classId: null, filePath: args.filePath,
      status: args.status, reason: args.reason, ts: Date.now(),
    });
    if (args.status === "unreviewed") {
      deps.exerciseProgress.applyUnreviewed(args.studentId, args.studentName, args.filePath, Date.now());
    } else {
      deps.exerciseProgress.applyReview(args.studentId, args.studentName, args.filePath, args.status, Date.now());
    }
  } catch (err) {
    logEvent({ event: "review.result_persist_failed", level: "warn", data: {
      studentId: args.studentId, error: err instanceof Error ? err.message : String(err),
    } });
  }
}

/** fail 合成事件注入 stateManager（spec §4.3）：进告警面板 + 知识点聚合（评审失败等同报错） */
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
  logEvent({ event: "review.fail_injected", level: "info", data: { studentId: args.studentId, reason: args.review.reason } });
}

/** pass 合成事件注入 stateManager（spec：评审成功才变绿）：清零连续错误并标记问题已解决 */
function injectReviewPass(
  deps: ReviewRequestDeps,
  args: { studentId: string; studentName: string; review: ReviewResult },
): void {
  const ev: NormalizedEvent = {
    studentId: args.studentId, studentName: args.studentName, classId: "default",
    eventType: "run", success: true,
    errorType: null, errorMessage: null, samples: [],
    rawMessage: `评审通过：${args.review.reason}`, cacheKey: null, ts: Date.now(),
  };
  deps.stateManager.apply(ev, null, { resolves: true });
  deps.publishSnapshot();
  logEvent({ event: "review.pass_applied", level: "info", data: { studentId: args.studentId, reason: args.review.reason } });
}

/** 运行触发评审（spec §0：作业域退役——无练习解析，所有文件皆可评审，题面锚点 = 文件内注释） */
export async function requestReview(deps: ReviewRequestDeps, input: ReviewRequestInput): Promise<ReviewRequestResult> {
  if (!input || typeof input.studentId !== "string" || !input.studentName
    || typeof input.filePath !== "string" || !input.filePath
    || typeof input.code !== "string") {
    return { ok: false, status: 400, error: "缺少必要字段" };
  }
  const rosterEntry = deps.persistence.getRosterEntry(input.studentId.trim());
  if (!rosterEntry) return { ok: false, status: 400, error: "学号不在名册" };
  if (input.files !== undefined) {
    const verr = validateFiles(input.files);
    if (verr) return { ok: false, status: 400, error: verr };
  }
  if (Buffer.byteLength(input.code, "utf8") > 50 * 1024) {
    return { ok: false, status: 400, error: "代码超过 50KB 限制" };
  }

  const reviewCode = input.files ? buildProjectReviewInput(input.files) : input.code;
  const review = await deps.reviewService.review({ filePath: input.filePath, code: reviewCode });

  // 评审结果驱动教师端状态（notify 已退役）：fail 等同报错进告警/聚合；pass 置绿（清零连续错误）；
  // unreviewed 为瞬态，不改变学生状态
  if (review.status === "fail") {
    persistReviewResult(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, filePath: input.filePath, status: "fail", reason: review.reason });
    injectReviewFail(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, review });
  } else if (review.status === "pass") {
    persistReviewResult(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, filePath: input.filePath, status: "pass", reason: review.reason });
    injectReviewPass(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, review });
  } else {
    // unreviewed（LLM 未配置/挂/不确定，spec 决策 #14）：不注入告警/置绿（瞬态不变学生状态），
    // 但落进度事实表 + 待评审计数
    persistReviewResult(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, filePath: input.filePath, status: "unreviewed", reason: review.reason });
  }
  return { ok: true, review };
}
