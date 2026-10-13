import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { createStateManager } from "../stateManager";
import { requestReview, buildReviewInput, type ReviewRequestDeps } from "../controllers/reviewController";
import type { ReviewService } from "../reviewService";
import type { SSEMessage } from "@classroom/shared";

function makeDeps(reviewStatus: "pass" | "fail" | "unreviewed") {
  const p = createPersistence(":memory:");
  p.replaceRoster([{ studentId: "2025001", studentName: "张三" }]);
  p.upsertAssignment({ id: "a1", title: "t", week: 3, isPublished: true, createdAt: 1, publishedAt: 1 });
  p.upsertExercise({ id: "ep", assignmentId: "a1", order: 1, filename: "weather-app",
    problemStatement: "做天气", starterCode: "", testCases: [], versionHash: "v1", isActive: true, createdAt: 1,
    kind: "project", dir: "weather-app", entry: "main.py" });
  const review = { status: reviewStatus, reason: "死循环风险", reviewedAt: 1, model: "m", source: "llm" as const };
  const reviewService = { async review() { return review; } } as unknown as ReviewService;
  const stateManager = createStateManager();
  const sse: SSEMessage[] = [];
  const counters = { snapshotPushes: 0 };   // 对象包裹：原始值解构是拷贝，闭包自增观测不到（brief 脚手架缺陷的最小修正）
  const deps: ReviewRequestDeps = {
    persistence: p, reviewService, stateManager,
    publish: (m) => sse.push(m),
    publishSnapshot: () => { counters.snapshotPushes++; },
  };
  return { p, deps, sse, counters, review };
}

const files = [{ path: "main.py", content: "m" }, { path: "utils.py", content: "u" }];
const baseInput = { studentId: "2025001", exerciseId: "ep", code: "m", files };

describe("运行触发评审（reviews/request）", () => {
  it("buildReviewInput：入口 + 其余 .py 拼接（非 .py 不入）", () => {
    const ex = { entry: "main.py" } as never;
    const out = buildReviewInput(ex, "MAIN", [...files, { path: "data/x.txt", content: "T" }]);
    expect(out.startsWith("MAIN")).toBe(true);
    expect(out).toContain("# ===== 文件: utils.py =====");
    expect(out).toContain("u");
    expect(out).not.toContain("x.txt");
  });

  it("有提交记录：写回最新 review + SSE review_complete", async () => {
    const { p, deps, sse, review } = makeDeps("fail");
    p.insertSubmission({ id: "s1", exerciseId: "ep", studentId: "2025001", studentName: "张三",
      code: "m", source: "manual", submittedAt: 100, review: null, codeHash: "h", gitSynced: true, files });
    const r = await requestReview(deps, baseInput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submissionId).toBe("s1");
    expect(r.review.status).toBe("fail");
    const latest = p.getLatestSubmissionByExerciseStudent("ep", "2025001")!;
    expect(latest.review!.status).toBe("fail");
    expect(sse.some((m) => m.type === "review_complete")).toBe(true);
  });

  it("fail 注入聚合：stateManager 出现 review_fail 事件 + 快照推送", async () => {
    const { p, deps, counters } = makeDeps("fail");
    p.insertSubmission({ id: "s1", exerciseId: "ep", studentId: "2025001", studentName: "张三",
      code: "m", source: "manual", submittedAt: 100, review: null, codeHash: "h", gitSynced: true });
    await requestReview(deps, baseInput);
    const rec = deps.stateManager.listRecords()[0];
    expect(rec).toBeTruthy();
    const failEvents = rec!.events.filter((e) => e.subtype === "review_fail");
    expect(failEvents.length).toBe(1);
    expect(failEvents[0].knowledge).toBe("死循环风险");
    expect(rec!.consecutiveErrors).toBe(1);
    expect(counters.snapshotPushes).toBe(1);
  });

  it("无提交记录：仅回传评审，不落库不注入", async () => {
    const d = makeDeps("pass");
    const r = await requestReview(d.deps, baseInput);
    expect(r.ok && r.submissionId).toBe(null);
    expect(d.p.getSubmissionsByStudent("2025001")).toEqual([]);
    expect(d.deps.stateManager.listRecords()).toEqual([]);
  });

  it("校验链：名册/未发布/项目缺 files", async () => {
    const { p, deps } = makeDeps("pass");
    // 1) 名册未命中
    expect((await requestReview(deps, { ...baseInput, studentId: "999" })).ok).toBe(false);
    // 2) 练习未发布：a2 未发布 + 关联练习 ep2（写入 makeDeps 自己的持久层）
    p.upsertAssignment({ id: "a2", title: "t", week: 9, isPublished: false, createdAt: 1 });
    p.upsertExercise({ id: "ep2", assignmentId: "a2", order: 1, filename: "x.py",
      problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1,
      kind: "project", dir: "app9", entry: "main.py" });
    const unpublished = await requestReview(deps, { studentId: "2025001", exerciseId: "ep2", code: "m", files });
    expect(unpublished.ok).toBe(false);
    if (unpublished.ok) return;
    expect(unpublished.error).toBe("练习未发布");
    // 3) 项目练习缺 files
    expect((await requestReview(deps, { ...baseInput, files: undefined })).ok).toBe(false);
  });

  it("畸形输入：studentId 为数字直接 400（防 .trim() TypeError 把路由挂起）", async () => {
    const { deps } = makeDeps("pass");
    const r = await requestReview(deps, { ...baseInput, studentId: 123 as unknown as string });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toBe("缺少必要字段");
  });
});
