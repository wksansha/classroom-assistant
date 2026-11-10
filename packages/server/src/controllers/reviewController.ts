import type { NormalizedEvent, ReviewResult, SubmissionFile, ReviewRequestInput } from "@classroom/shared";
import type { Persistence } from "../persistence";
import type { ReviewService } from "../reviewService";
import type { StateManager } from "../stateManager";
import type { ExerciseProgressTracker } from "../exerciseProgress";
import type { ActivityFeed } from "../activityFeed";
import { parseExerciseHeader } from "../exerciseHeader";
import { logEvent } from "../logger";

export interface ReviewRequestDeps {
  persistence: Persistence;
  reviewService: ReviewService;
  stateManager: StateManager;
  exerciseProgress: ExerciseProgressTracker;   // 题目进度矩阵（spec dashboard-v2 §5.3）
  activityFeed?: ActivityFeed;                 // 课堂动态（可选注入，测试可缺省）
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

/** 评审结果落库（spec dashboard-v2 §5.2/§5.3；多任务题逐任务一行带 taskId，spec 2026-11-09 §5）：
 * 三态均落行（unreviewed 落行支撑重启回放）；缓存表「unreviewed 不缓存」约束不变；
 * 写失败不阻塞评审响应（log warn 后继续） */
function persistReviewResult(
  deps: ReviewRequestDeps,
  args: { studentId: string; studentName: string; filePath: string; status: "pass" | "fail" | "unreviewed"; reason: string | null; title?: string; taskId?: string },
): void {
  try {
    deps.persistence.saveReviewResult({
      studentId: args.studentId, classId: null, filePath: args.filePath,
      status: args.status, reason: args.reason, ts: Date.now(), taskId: args.taskId ?? null,
    });
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

/** LLM 不可用类 unreviewed 的降级置绿：run 成功即视为运行时问题已解决，不因评审服务故障卡黄。
 * 与 injectReviewPass 区分：rawMessage/日志明确标注「未经质量评审」，进度表仍落 unreviewed（质量维度待补评） */
function injectLlmUnavailableResolve(
  deps: ReviewRequestDeps,
  args: { studentId: string; studentName: string; reason: string },
): void {
  const ev: NormalizedEvent = {
    studentId: args.studentId, studentName: args.studentName, classId: "default",
    eventType: "run", success: true,
    errorType: null, errorMessage: null, samples: [],
    rawMessage: `run 成功，评审服务不可用（${args.reason}），视为已解决（未经质量评审）`, cacheKey: null, ts: Date.now(),
  };
  deps.stateManager.apply(ev, null, { resolves: true });
  deps.publishSnapshot();
  logEvent({ event: "review.unreviewed_resolved", level: "info", data: { studentId: args.studentId, reason: args.reason } });
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

  const header = parseExerciseHeader(input.code);
  const reviewCode = input.files ? buildProjectReviewInput(input.files) : input.code;
  const title = header.title;
  const tasks = header.tasks;   // 任务声明 ≥2 = 多任务题（spec 2026-11-09 §3）
  if (tasks.length >= 2) deps.exerciseProgress.registerTasks(input.filePath, tasks);
  const review = await deps.reviewService.review({ filePath: input.filePath, code: reviewCode, tasks: tasks.length >= 2 ? tasks : undefined });

  // 课堂动态：代码 LRU（悬浮代码卡懒加载源）+ 评审条目（unreviewed 只计数不产生条目 = LLM 降级自动满足）
  if (deps.activityFeed) {
    deps.activityFeed.stashCode({ studentId: rosterEntry.studentId, filePath: input.filePath, code: reviewCode, title });
    deps.activityFeed.recordReview({
      studentId: rosterEntry.studentId, studentName: rosterEntry.studentName,
      filePath: input.filePath, ts: Date.now(), status: review.status, reason: review.reason, title,
    });
  }

  // 逐任务/整文件落行 + 喂养进度桶（多任务题每任务一行一桶；LLM 不可用兜底 = 逐声明任务 unreviewed 行）：
  const verdicts: { name: string | null; status: typeof review.status; reason: string }[] = tasks.length >= 2
    ? (review.tasks ?? tasks.map((t) => ({ name: t, status: review.status, reason: review.reason })))
    : [{ name: null, status: review.status, reason: review.reason }];
  for (const v of verdicts) {
    persistReviewResult(deps, {
      studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, filePath: input.filePath,
      status: v.status, reason: v.reason, title, taskId: v.name ?? undefined,
    });
  }
  for (const v of verdicts) {
    if (v.status === "unreviewed") {
      deps.exerciseProgress.applyUnreviewed(rosterEntry.studentId, rosterEntry.studentName, input.filePath, Date.now(), title, v.name ?? undefined);
    } else {
      deps.exerciseProgress.applyReview(rosterEntry.studentId, rosterEntry.studentName, input.filePath, v.status, Date.now(), title, v.name ?? undefined);
    }
  }

  // 评审结果驱动教师端状态（文件级，沿用现状语义）：fail 等同报错进告警/聚合；pass 置绿（清零连续错误）；
  // unreviewed 为瞬态，不改变学生状态
  if (review.status === "fail") {
    injectReviewFail(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, review });
  } else if (review.status === "pass") {
    injectReviewPass(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, review });
  } else if (review.source !== "llm") {
    // LLM 不可用类（not_configured/timeout/mock 兜底）→ run 成功降级置绿（清零连续错误），不卡黄
    injectLlmUnavailableResolve(deps, { studentId: rosterEntry.studentId, studentName: rosterEntry.studentName, reason: review.reason });
  }
  return { ok: true, review };
}
