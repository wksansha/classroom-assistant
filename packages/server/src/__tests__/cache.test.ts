import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { createCache } from "../explainService/cache";

const exp = { category: "运算错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" };

describe("三层缓存", () => {
  it("未命中：调 1 次 LLM 并写入缓存；再取：内存命中不再调", async () => {
    const cache = createCache(createPersistence(":memory:"));
    let calls = 0;
    const fn = async () => { calls++; return exp; };
    expect(await cache.getExplanation("k1", fn)).toEqual(exp);
    expect(await cache.getExplanation("k1", fn)).toEqual(exp);
    expect(calls).toBe(1);
    expect(cache.getStats().memoryCacheSize).toBe(1);
  });

  it("并发去重：同 key 并发只调 1 次 LLM（demo pendingRequests 语义）", async () => {
    const cache = createCache(createPersistence(":memory:"));
    let calls = 0;
    const fn = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return exp; };
    const [a, b] = await Promise.all([
      cache.getExplanation("k2", fn),
      cache.getExplanation("k2", fn),
    ]);
    expect(a).toEqual(exp);
    expect(b).toEqual(exp);
    expect(calls).toBe(1);
  });

  it("重启模拟：新 cache 实例（内存空）+ 同一 SQLite → 命中持久层，0 次 LLM", async () => {
    const p = createPersistence(":memory:");
    const c1 = createCache(p);
    await c1.getExplanation("k3", async () => exp);
    const c2 = createCache(p); // 模拟重启：内存清零，SQLite 还在
    let calls = 0;
    expect(await c2.getExplanation("k3", async () => { calls++; return exp; })).toEqual(exp);
    expect(calls).toBe(0);
  });
});
