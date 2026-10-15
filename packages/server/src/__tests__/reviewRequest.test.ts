import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { createStateManager } from "../stateManager";
import { requestReview, buildProjectReviewInput, validateFiles, type ReviewRequestDeps } from "../controllers/reviewController";
import { createReviewService } from "../reviewService";

function seedPersistence() {
  const p = createPersistence(":memory:");
  p.replaceRoster([{ studentId: "2025001", studentName: "张三" }]);
  return p;
}

interface LlmCounter { calls: number; status: "pass" | "fail" | "unreviewed"; reason: string }

/** 真 reviewService + 假 LLM fetch：缓存/限流走真实实现，调用次数可观测 */
function makeDeps(llmStatus: "pass" | "fail" | "unreviewed" = "pass") {
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
  return { p, deps, counters, llm, stateManager };
}

const fileInput = { studentId: "2025001", studentName: "张三", filePath: "lesson5/a.py", code: "print(1)", commitHash: "c1" };
const projectInput = {
  studentId: "2025001", studentName: "张三", filePath: "lesson5/weather-app/utils.py", code: "M", commitHash: "c2",
  files: [{ path: "main.py", content: "M" }, { path: "utils.py", content: "u" }],
};

describe("运行触发评审（reviews/request，notify 已退役：评审结果驱动教师端状态）", () => {
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

  it("评审 pass：注入置绿事件（清零连续错误 + lastResolvedAt）+ 快照推送", async () => {
    const { deps, counters, stateManager } = makeDeps("pass");
    // 先制造报错状态
    deps.stateManager.apply({
      studentId: "2025001", studentName: "张三", classId: "default", eventType: "run", success: false,
      errorType: "ZeroDivisionError", errorMessage: "division by zero", samples: [],
      rawMessage: "division by zero", cacheKey: "k", ts: Date.now() - 1000,
    }, { category: "运算错误", subtype: "除数为0", knowledge: "k" });
    expect(stateManager.listRecords()[0].consecutiveErrors).toBe(1);

    const r = await requestReview(deps, { ...fileInput, code: "# 题：两数之和\n# ===== 代码区 =====\nprint(1)" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.review.status).toBe("pass");
    expect("submissionId" in r).toBe(false);   // notify 已退役，无回填锚点
    const rec = stateManager.listRecords()[0];
    expect(rec.consecutiveErrors).toBe(0);      // 置绿：清零连续错误
    expect(rec.lastResolvedAt).not.toBeNull();  // 标记已解决
    expect(rec.events.at(-1)).toMatchObject({ success: true, rawMessage: "评审通过：通过" });
    expect(counters.snapshotPushes).toBe(1);
  });

  it("评审 fail：等同报错，无条件注入（无任何提交行也注入）+ 快照推送", async () => {
    const { deps, counters, stateManager } = makeDeps("fail");
    const r = await requestReview(deps, fileInput);
    expect(r.ok).toBe(true);
    const rec = stateManager.listRecords()[0];
    expect(rec).toBeTruthy();
    const failEvents = rec!.events.filter((e) => e.subtype === "review_fail");
    expect(failEvents.length).toBe(1);
    expect(failEvents[0].knowledge).toBe("死循环风险");
    expect(rec!.consecutiveErrors).toBe(1);
    expect(rec!.lastResolvedAt).toBeNull();
    expect(counters.snapshotPushes).toBe(1);
  });

  it("评审 unreviewed：瞬态，不改变学生状态、不推快照", async () => {
    const { deps, counters, stateManager } = makeDeps("unreviewed");
    const r = await requestReview(deps, fileInput);
    expect(r.ok).toBe(true);
    expect(stateManager.listRecords()).toHaveLength(0);   // 无注入
    expect(counters.snapshotPushes).toBe(0);
  });

  it("无 404 not-exercise：任意路径（根目录散文件/自建笔记）皆可评审", async () => {
    const { deps } = makeDeps();
    const r1 = await requestReview(deps, { ...fileInput, filePath: "notes/todo.py" });
    const r2 = await requestReview(deps, { ...fileInput, filePath: "scratch.py" });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it("项目评审：files 快照校验 + 多文件拼接", async () => {
    const { deps } = makeDeps();
    const r = await requestReview(deps, projectInput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.review.status).toBe("pass");
  });

  it("幂等：同路径同评审输入二次请求命中缓存不重评", async () => {
    const { deps, llm } = makeDeps();
    await requestReview(deps, fileInput);
    await requestReview(deps, fileInput);
    expect(llm.calls).toBe(1);
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
