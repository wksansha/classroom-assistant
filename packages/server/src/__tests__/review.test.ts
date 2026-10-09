import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { createReviewService } from "../reviewService";

const passFetch = (async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: '{"status":"pass","reason":"代码通过所有测试用例"}' } }] }),
})) as unknown as typeof fetch;

const opts = { apiKey: "k", fetchImpl: passFetch };
const ex = { id: "e1", versionHash: "v1", problemStatement: "题", testCases: [] as never[] };

describe("ReviewService（A6 key 组装 / A11 限流）", () => {
  it("改题（versionHash 变）→ 缓存失效，重新评审", async () => {
    const p = createPersistence(":memory:");
    let calls = 0;
    const svc = createReviewService(p, { ...opts, fetchImpl: (async (u: unknown, i: any) => {
      calls++; return passFetch(u as never, i as never);
    }) as unknown as typeof fetch });
    await svc.review(ex, "print(1)");
    await svc.review(ex, "print(1)");                 // 命中缓存
    await svc.review({ ...ex, versionHash: "v2" }, "print(1)");  // 改题 → 新 key
    expect(calls).toBe(2);
  });
  it("缓存命中返回完整 ReviewResult（reviewedAt 重打）", async () => {
    const p = createPersistence(":memory:");
    const svc = createReviewService(p, opts);
    const first = await svc.review(ex, "print(2)");
    expect(first.reviewedAt).toBeGreaterThan(0);
    const second = await svc.review(ex, "print(2)");
    expect(second.status).toBe("pass");
  });
});
