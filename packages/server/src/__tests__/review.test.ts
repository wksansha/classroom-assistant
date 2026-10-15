import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { createReviewService } from "../reviewService";

const passFetch = (async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: '{"status":"pass","reason":"代码满足题目要求"}' } }] }),
})) as unknown as typeof fetch;

const opts = { apiKey: "k", fetchImpl: passFetch };
const input = { filePath: "lesson5/a.py", code: "print(1)" };

describe("ReviewService（key 内容寻址：sha256(filePath + 评审输入) / A11 限流）", () => {
  it("同路径同 code → 命中缓存；code 变 → 重新评审（versionHash 已退役）", async () => {
    const p = createPersistence(":memory:");
    let calls = 0;
    const svc = createReviewService(p, { ...opts, fetchImpl: (async (u: unknown, i: any) => {
      calls++; return passFetch(u as never, i as never);
    }) as unknown as typeof fetch });
    await svc.review(input);
    await svc.review(input);                          // 命中缓存
    await svc.review({ ...input, code: "print(2)" }); // 内容变 → 新 key
    expect(calls).toBe(2);
  });
  it("缓存 key 路径化：同 code 不同路径 → 重新评审", async () => {
    const p = createPersistence(":memory:");
    let calls = 0;
    const svc = createReviewService(p, { ...opts, fetchImpl: (async (u: unknown, i: any) => {
      calls++; return passFetch(u as never, i as never);
    }) as unknown as typeof fetch });
    await svc.review(input);
    await svc.review({ ...input, filePath: "lesson5/b.py" });   // 换路径 → 新 key
    expect(calls).toBe(2);
  });
  it("缓存命中返回完整 ReviewResult（reviewedAt 重打）", async () => {
    const p = createPersistence(":memory:");
    const svc = createReviewService(p, opts);
    const first = await svc.review({ ...input, code: "print(2)" });
    expect(first.reviewedAt).toBeGreaterThan(0);
    const second = await svc.review({ ...input, code: "print(2)" });
    expect(second.status).toBe("pass");
  });
});
