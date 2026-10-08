import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { createReviewCache } from "../reviewService/cache";

const p = createPersistence(":memory:");
const pass = { status: "pass" as const, reason: "通过", reviewedAt: 1, model: "m", source: "llm" as const };
const unreviewed = { status: "unreviewed" as const, reason: "评审超时", reviewedAt: 1, model: "m", source: "timeout" as const };
const args = { cacheKey: "k", exerciseId: "e", versionHash: "v" };

describe("reviewCache（A6/A30）", () => {
  it("终态结果：第二次同 key 不再调 LLM（内存命中）", async () => {
    const cache = createReviewCache(p);
    let calls = 0;
    const fn = async () => { calls++; return pass; };
    await cache.getReview(args, fn);
    await cache.getReview(args, fn);
    expect(calls).toBe(1);
  });
  it("unreviewed 不入缓存：第二次重新调 LLM（A30 瞬态不粘滞）", async () => {
    const cache = createReviewCache(p);
    let calls = 0;
    const fn = async () => { calls++; return unreviewed; };
    await cache.getReview({ ...args, cacheKey: "k2" }, fn);
    await cache.getReview({ ...args, cacheKey: "k2" }, fn);
    expect(calls).toBe(2);
  });
  it("并发同 key 共享一次 LLM 调用（pending 去重）", async () => {
    const cache = createReviewCache(p);
    let calls = 0;
    const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return pass; };
    await Promise.all([cache.getReview({ ...args, cacheKey: "k3" }, fn), cache.getReview({ ...args, cacheKey: "k3" }, fn)]);
    expect(calls).toBe(1);
  });
  it("终态跨实例持久化：新 cache 实例命中 SQLite", async () => {
    await createReviewCache(p).getReview({ ...args, cacheKey: "k4" }, async () => pass);
    let calls = 0;
    await createReviewCache(p).getReview({ ...args, cacheKey: "k4" }, async () => { calls++; return pass; });
    expect(calls).toBe(0);
  });
});
