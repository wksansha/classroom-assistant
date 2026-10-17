import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { createCache } from "../explainService/cache";

const exp = { category: "运算错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" };
const llmResult = { ...exp, source: "llm" as const };
const mockResult = { ...exp, source: "mock" as const };

describe("三层缓存（spec §6）", () => {
  it("未命中：调 1 次 LLM 并写入缓存；再取：内存命中不再调", async () => {
    const cache = createCache(createPersistence(":memory:"));
    let calls = 0;
    const fn = async () => { calls++; return llmResult; };
    expect(await cache.getExplanation("k1", fn)).toEqual({ exp, source: "llm" });
    expect(await cache.getExplanation("k1", fn)).toEqual({ exp, source: "llm" });
    expect(calls).toBe(1);
    expect(cache.getStats().memoryCacheSize).toBe(1);
  });

  it("并发去重：同 key 并发只调 1 次 LLM（pendingRequests 语义）", async () => {
    const cache = createCache(createPersistence(":memory:"));
    let calls = 0;
    const fn = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return llmResult; };
    const [a, b] = await Promise.all([
      cache.getExplanation("k2", fn),
      cache.getExplanation("k2", fn),
    ]);
    expect(a).toEqual({ exp, source: "llm" });
    expect(b).toEqual({ exp, source: "llm" });
    expect(calls).toBe(1);
  });

  it("重启模拟：新 cache 实例（内存空）+ 同一 SQLite → 命中持久层，0 次 LLM", async () => {
    const p = createPersistence(":memory:");
    const c1 = createCache(p);
    await c1.getExplanation("k3", async () => llmResult);
    const c2 = createCache(p);
    let calls = 0;
    expect(await c2.getExplanation("k3", async () => { calls++; return llmResult; })).toEqual({ exp, source: "llm" });
    expect(calls).toBe(0);
  });

  it("source 透传：mock 兜底结果 source=mock，重启后从 SQLite 读回仍为 mock", async () => {
    const p = createPersistence(":memory:");
    const c1 = createCache(p);
    // callLLM 的兜底路径（无 API key / API 失败，见 llm.ts）返回 source:"mock"
    const r = await c1.getExplanation("k4", async () => mockResult);
    expect(r.source).toBe("mock");
    const c2 = createCache(p); // 模拟重启
    expect(await c2.getExplanation("k4", async () => llmResult)).toEqual({ exp, source: "mock" });
  });
});
