import crypto from "node:crypto";
import type { Explanation } from "@classroom/shared";
import type { Persistence } from "../persistence";

export interface Cache {
  getExplanation(cacheKey: string, llmCallFn: () => Promise<Explanation>): Promise<Explanation>;
  getStats(): { memoryCacheSize: number; pendingRequestsSize: number };
}

export function createCache(p: Persistence): Cache {
  const memoryCache = new Map<string, Explanation>();
  const pending = new Map<string, Promise<Explanation>>();

  return {
    async getExplanation(cacheKey, llmCallFn) {
      // 1. 内存命中
      const mem = memoryCache.get(cacheKey);
      if (mem) return mem;

      // 2. SQLite 命中（同步回内存）
      const rawHash = crypto.createHash("sha256").update(cacheKey).digest("hex");
      const cached = p.getCachedExplanation(rawHash);
      if (cached) {
        memoryCache.set(cacheKey, cached);
        return cached;
      }

      // 3. 并发去重：同 key 共享同一个 Promise
      const inflight = pending.get(cacheKey);
      if (inflight) return inflight;

      const promise = (async () => {
        try {
          const result = await llmCallFn();
          memoryCache.set(cacheKey, result);
          p.saveCache(rawHash, cacheKey, result, "llm");
          return result;
        } finally {
          pending.delete(cacheKey);
        }
      })();
      pending.set(cacheKey, promise);
      return promise;
    },

    getStats: () => ({ memoryCacheSize: memoryCache.size, pendingRequestsSize: pending.size }),
  };
}
