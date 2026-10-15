import { describe, it, expect } from "vitest";
import { createPersistence, type Persistence } from "../persistence";
import { createStateManager } from "../stateManager";
import { requestReview, buildProjectReviewInput, validateFiles, type ReviewRequestDeps } from "../controllers/reviewController";
import { createReviewService } from "../reviewService";

function seedPersistence(): Persistence {
  const p = createPersistence(":memory:");
  p.replaceRoster([{ studentId: "2025001", studentName: "张三" }]);
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
  const counters = { snapshotPushes: 0 };
  const deps: ReviewRequestDeps = {
    persistence: p, reviewService, stateManager,
    publishSnapshot: () => { counters.snapshotPushes++; },
  };
  return { p, deps, counters, llm };
}

const fileInput = { studentId: "2025001", studentName: "张三", filePath: "lesson5/a.py", code: "print(1)", commitHash: "c1" };
const projectInput = {
  studentId: "2025001", studentName: "张三", filePath: "lesson5/weather-app/utils.py", code: "M", commitHash: "c2",
  files: [{ path: "main.py", content: "M" }, { path: "utils.py", content: "u" }],
};
const seedNotifyRow = (p: Persistence, id: string, commitHash: string, files: string[] = []) =>
  p.insertNotifyRow({ id, studentId: "2025001", studentName: "张三", commitHash, filesJson: JSON.stringify(files), submittedAt: 100 });

describe("运行触发评审（reviews/request，作业域退役：无练习解析，题面锚点 = 文件内注释）", () => {
  it("buildProjectReviewInput：.py 按路径排序拼接（带路径头），非 .py 不入", () => {
    const out = buildProjectReviewInput([
      { path: "utils.py", content: "u" }, { path: "data/x.txt", content: "T" },
      { path: "main.py", content: "m" }, { path: "sub/b.py", content: "b" },
    ]);
    const idxMain = out.indexOf("# ===== 文件: main.py =====");
    const idxSub = out.indexOf("# ===== 文件: sub/b.py =====");
    const idxUtils = out.indexOf("# ===== 文件: utils.py =====");
    expect(idxMain).toBeGreaterThanOrEqual(0);
    expect(idxMain).toBeLessThan(idxSub);
    expect(idxSub).toBeLessThan(idxUtils);
    expect(out).toContain("u");
    expect(out).not.toContain("x.txt");
  });

  it("validateFiles 边界：空/超50个/超100KB/超500KB/路径穿越", () => {
    expect(validateFiles([])).toBeTruthy();
    expect(validateFiles(Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.py`, content: "x" })))).toBeTruthy();
    expect(validateFiles([{ path: "big.py", content: "a".repeat(101 * 1024) }])).toBeTruthy();
    expect(validateFiles(Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.py`, content: "a".repeat(90 * 1024) })))).toBeTruthy();
    expect(validateFiles([{ path: "../evil.py", content: "x" }, { path: "main.py", content: "m" }])).toBeTruthy();
    expect(validateFiles([{ path: "ok.py", content: "x" }])).toBeNull();
  });

  it("单文件评审（含题面注释全文直达 LLM）：回填 review map 按 filePath 键", async () => {
    const { p, deps } = makeDeps();
    seedNotifyRow(p, "n1", "c1");
    const r = await requestReview(deps, { ...fileInput, code: "# 题：两数之和\n# ===== 代码区 =====\nprint(1)" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submissionId).toBe("n1");
    expect(r.review.status).toBe("pass");
    const row = p.getSubmissionsByStudent("2025001").find((x) => x.id === "n1")!;
    expect(row.review).not.toBeNull();
    expect(Object.keys(row.review!)).toEqual(["lesson5/a.py"]);
    expect(row.review!["lesson5/a.py"]).toMatchObject({ status: "pass" });
  });

  it("无 404 not-exercise：任意路径（根目录散文件/自建笔记）皆可评审", async () => {
    const { deps } = makeDeps();
    const r1 = await requestReview(deps, { ...fileInput, filePath: "notes/todo.py" });
    const r2 = await requestReview(deps, { ...fileInput, filePath: "scratch.py" });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it("项目评审：files 快照校验 + 多文件拼接 + 回填同 push 行（filePath 独立键）", async () => {
    const { p, deps } = makeDeps();
    seedNotifyRow(p, "n2", "c2", ["lesson5/weather-app/main.py", "lesson5/weather-app/utils.py"]);
    const r = await requestReview(deps, projectInput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submissionId).toBe("n2");
    const map = p.getSubmissionsByStudent("2025001").find((x) => x.id === "n2")!.review!;
    expect(Object.keys(map)).toEqual(["lesson5/weather-app/utils.py"]);
    // 同一 push 行多文件评审互不覆盖
    await requestReview(deps, { ...projectInput, filePath: "lesson5/weather-app/main.py" });
    const map2 = p.getSubmissionsByStudent("2025001").find((x) => x.id === "n2")!.review!;
    expect(Object.keys(map2).sort()).toEqual(["lesson5/weather-app/main.py", "lesson5/weather-app/utils.py"]);
  });

  it("幂等：同路径同评审输入二次请求命中缓存不重评", async () => {
    const { deps, llm } = makeDeps();
    await requestReview(deps, fileInput);
    await requestReview(deps, fileInput);
    expect(llm.calls).toBe(1);
  });

  it("commitHash 空：回填跳过；缓存仍生效", async () => {
    const { p, deps, llm } = makeDeps();
    seedNotifyRow(p, "n1", "c1");
    const input = { studentId: "2025001", studentName: "张三", filePath: "lesson5/a.py", code: "print(1)" };
    const r1 = await requestReview(deps, input);
    expect(r1.ok && r1.submissionId).toBe(null);
    expect(p.getSubmissionsByStudent("2025001").find((x) => x.id === "n1")!.review).toBeNull();
    await requestReview(deps, input);
    expect(llm.calls).toBe(1);
  });

  it("commitHash 无对应 push 行（notify 未达）：评审成功但回填跳过", async () => {
    const { deps } = makeDeps();
    const r = await requestReview(deps, { ...fileInput, commitHash: "no-such-commit" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submissionId).toBe(null);
  });

  it("fail：回填 + 注入聚合 + 快照推送（仅在回填行存在时）", async () => {
    const { p, deps, counters } = makeDeps("fail");
    seedNotifyRow(p, "n1", "c1");
    await requestReview(deps, fileInput);
    const rec = deps.stateManager.listRecords()[0];
    expect(rec).toBeTruthy();
    const failEvents = rec!.events.filter((e) => e.subtype === "review_fail");
    expect(failEvents.length).toBe(1);
    expect(failEvents[0].knowledge).toBe("死循环风险");
    expect(rec!.consecutiveErrors).toBe(1);
    expect(counters.snapshotPushes).toBe(1);
    // commitHash 空 → 不注入（回填行不存在）
    const countersBefore = counters.snapshotPushes;
    await requestReview(deps, { ...fileInput, commitHash: undefined });
    expect(counters.snapshotPushes).toBe(countersBefore);
  });

  it("校验链：名册 400 / files 非法 400 / 超 50KB 400", async () => {
    const { deps } = makeDeps();
    expect((await requestReview(deps, { ...fileInput, studentId: "999" })).ok).toBe(false);
    expect((await requestReview(deps, { ...fileInput, files: [{ path: "../evil.py", content: "x" }] })).ok).toBe(false);
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
