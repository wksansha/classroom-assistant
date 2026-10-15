import { describe, it, expect } from "vitest";
import { createPersistence, type Persistence } from "../persistence";
import { createStateManager } from "../stateManager";
import { requestReview, buildReviewInput, type ReviewRequestDeps } from "../controllers/reviewController";
import { createReviewService } from "../reviewService";
import type { SSEMessage } from "@classroom/shared";

// seed：roster + assignment(week_dir=lesson5, 已发布) + 单文件题 a.py + 项目题 weather-app
function seedPersistence(): Persistence {
  const p = createPersistence(":memory:");
  p.replaceRoster([{ studentId: "2025001", studentName: "张三" }]);
  p.upsertAssignment({ id: "a1", title: "第 5 课", week: 5, isPublished: true, createdAt: 1_000 });
  p.setAssignmentWeekDir("a1", "lesson5");
  p.upsertExercise({ id: "ex-a", assignmentId: "a1", order: 1, filename: "a.py",
    problemStatement: "单文件题", starterCode: "", testCases: [], versionHash: "v1", isActive: true, createdAt: 1_000,
    kind: "file" });
  p.upsertExercise({ id: "ex-weather", assignmentId: "a1", order: 2, filename: "weather-app",
    problemStatement: "项目题", starterCode: "", testCases: [], versionHash: "v1", isActive: true, createdAt: 1_000,
    kind: "project", entry: "main.py" });
  return p;
}

interface LlmCounter { calls: number; status: "pass" | "fail"; reason: string }

/** 真 reviewService + 假 LLM fetch：缓存/限流走真实实现，调用次数可观测 */
function makeDeps(llmStatus: "pass" | "fail" = "pass") {
  const p = seedPersistence();
  const llm: LlmCounter = { calls: 0, status: llmStatus, reason: llmStatus === "fail" ? "死循环风险" : "通过" };
  const fetchImpl = (async () => {
    llm.calls++;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ status: llm.status, reason: llm.reason }) } }] }),
    };
  }) as unknown as typeof fetch;
  const reviewService = createReviewService(p, { apiKey: "k", fetchImpl });
  const stateManager = createStateManager();
  const sse: SSEMessage[] = [];
  const counters = { snapshotPushes: 0 };
  const deps: ReviewRequestDeps = {
    persistence: p, reviewService, stateManager,
    publish: (m) => sse.push(m),
    publishSnapshot: () => { counters.snapshotPushes++; },
  };
  return { p, deps, sse, counters, llm };
}

const fileInput = { studentId: "2025001", studentName: "张三", filePath: "lesson5/a.py", code: "print(1)", commitHash: "c1" };
const projectInput = {
  studentId: "2025001", studentName: "张三", filePath: "lesson5/weather-app/utils.py", code: "M", commitHash: "c2",
  files: [{ path: "main.py", content: "M" }, { path: "utils.py", content: "u" }],
};
const insertNotify = (p: Persistence, id: string, exerciseId: string, commitHash: string) =>
  p.insertNotifyRow({ id, exerciseId, studentId: "2025001", studentName: "张三", commitHash, filesJson: "[]", submittedAt: 100 });

describe("运行触发评审（reviews/request，路径定位）", () => {
  it("buildReviewInput：入口 + 其余 .py 拼接（非 .py 不入）", () => {
    const ex = { entry: "main.py" } as never;
    const out = buildReviewInput(ex, "MAIN", [
      { path: "main.py", content: "m" }, { path: "utils.py", content: "u" }, { path: "data/x.txt", content: "T" },
    ]);
    expect(out.startsWith("MAIN")).toBe(true);
    expect(out).toContain("# ===== 文件: utils.py =====");
    expect(out).toContain("u");
    expect(out).not.toContain("x.txt");
  });

  it("命中单文件题：回填 submission_notify + SSE review_complete", async () => {
    const { p, deps, sse } = makeDeps();
    insertNotify(p, "n1", "ex-a", "c1");
    const r = await requestReview(deps, fileInput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submissionId).toBe("n1");
    expect(r.review.status).toBe("pass");
    const row = p.getNotifyRowsByStudent("2025001").find((x) => x.id === "n1")!;
    expect(JSON.parse(row.reviewJson!)).toMatchObject({ status: "pass" });
    const rc = sse.find((m) => m.type === "review_complete");
    expect(rc).toBeTruthy();
    expect((rc!.data as { submissionId: string; exerciseId: string; studentId: string }))
      .toMatchObject({ submissionId: "n1", exerciseId: "ex-a", studentId: "2025001" });
  });

  it("命中项目题：files 快照校验通过 + 回填", async () => {
    const { p, deps } = makeDeps();
    insertNotify(p, "n2", "ex-weather", "c2");
    const r = await requestReview(deps, projectInput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submissionId).toBe("n2");
    const row = p.getNotifyRowsByStudent("2025001").find((x) => x.id === "n2")!;
    expect(JSON.parse(row.reviewJson!)).toMatchObject({ status: "pass" });
  });

  it("路径未命中 exercises 表 → 404 not-exercise（根目录散文件同）", async () => {
    const { deps } = makeDeps();
    const r1 = await requestReview(deps, { ...fileInput, filePath: "notes/todo.py" });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.status).toBe(404);
    expect(r1.error).toBe("not-exercise");
    const r2 = await requestReview(deps, { ...fileInput, filePath: "scratch.py" });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.status).toBe(404);
    expect(r2.error).toBe("not-exercise");
  });

  it("幂等：同路径同 code 二次请求命中缓存不重评；回填两次均生效", async () => {
    const { p, deps, llm } = makeDeps();
    insertNotify(p, "n1", "ex-a", "c1");
    const r1 = await requestReview(deps, fileInput);
    const r2 = await requestReview(deps, fileInput);
    expect(r1.ok && r2.ok).toBe(true);
    expect(llm.calls).toBe(1);                                   // 第二次缓存命中
    expect((r2 as { review: { reviewedAt: number } }).review.reviewedAt)
      .toBeGreaterThanOrEqual((r1 as { review: { reviewedAt: number } }).review.reviewedAt);
    expect(p.getNotifyRowsByStudent("2025001").find((x) => x.id === "n1")!.reviewJson).toBeTruthy();
  });

  it("commitHash 空：回填跳过、无 SSE；缓存仍生效", async () => {
    const { p, deps, sse, llm } = makeDeps();
    insertNotify(p, "n1", "ex-a", "c1");                          // 已有提交记录，但本次未提交
    const input = { studentId: "2025001", studentName: "张三", filePath: "lesson5/a.py", code: "print(1)" };
    const r1 = await requestReview(deps, input);
    expect(r1.ok && r1.submissionId).toBe(null);
    expect(p.getNotifyRowsByStudent("2025001").find((x) => x.id === "n1")!.reviewJson).toBeNull();
    expect(sse).toEqual([]);
    await requestReview(deps, input);
    expect(llm.calls).toBe(1);                                    // 缓存命中
  });

  it("fail：回填 + 注入聚合 + 快照推送（仅在回填行存在时）", async () => {
    const { p, deps, counters } = makeDeps("fail");
    insertNotify(p, "n1", "ex-a", "c1");
    await requestReview(deps, fileInput);
    const rec = deps.stateManager.listRecords()[0];
    expect(rec).toBeTruthy();
    const failEvents = rec!.events.filter((e) => e.subtype === "review_fail");
    expect(failEvents.length).toBe(1);
    expect(failEvents[0].knowledge).toBe("死循环风险");
    expect(rec!.consecutiveErrors).toBe(1);
    expect(counters.snapshotPushes).toBe(1);
  });

  it("校验链：名册/未发布/项目缺 files/超 50KB", async () => {
    const { p, deps } = makeDeps();
    // 1) 名册未命中
    expect((await requestReview(deps, { ...fileInput, studentId: "999" })).ok).toBe(false);
    // 2) 练习未发布：a2 未发布 + 关联练习 ex2（lesson9/x.py）
    p.upsertAssignment({ id: "a2", title: "t", week: 9, isPublished: false, createdAt: 1 });
    p.setAssignmentWeekDir("a2", "lesson9");
    p.upsertExercise({ id: "ex2", assignmentId: "a2", order: 1, filename: "x.py",
      problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1,
      kind: "file" });
    const unpublished = await requestReview(deps, { ...fileInput, filePath: "lesson9/x.py" });
    expect(unpublished.ok).toBe(false);
    if (!unpublished.ok) expect(unpublished.error).toBe("练习未发布");
    // 3) 项目练习缺 files
    expect((await requestReview(deps, { ...projectInput, files: undefined })).ok).toBe(false);
    // 4) 超 50KB
    expect((await requestReview(deps, { ...fileInput, code: "a".repeat(50 * 1024 + 1) })).ok).toBe(false);
  });

  it("畸形输入：studentId 为数字直接 400（防 .trim() TypeError 把路由挂起）", async () => {
    const { deps } = makeDeps();
    const r = await requestReview(deps, { ...fileInput, studentId: 123 as unknown as string });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toBe("缺少必要字段");
  });
});
