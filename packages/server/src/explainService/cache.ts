import crypto from "node:crypto";
import type { Explanation } from "@classroom/shared";
import type { Persistence } from "../persistence";
import { logger, logEvent } from "../logger";

export interface Cache {
  getExplanation(cacheKey: string, llmCallFn: () => Promise<Explanation>): Promise<Explanation>;
  getStats(): { memoryCacheSize: number; pendingRequestsSize: number };
}

export function createCache(p: Persistence): Cache {
  const memoryCache = new Map<string, Explanation>();
  const accessOrder = new Map<string, number>(); // timestamp of last access
  const MAX_MEMORY_CACHE_SIZE = Number(process.env.CACHE_SIZE_LIMIT) || 1000; // 控制内存缓存上限，避免溢出
  const pending = new Map<string, Promise<Explanation>>();

  // 淘汰最久未使用的条目，保持内存缓存大小在上限内
  function evictIfNeeded() {
    while (memoryCache.size >= MAX_MEMORY_CACHE_SIZE && accessOrder.size > 0) {
      // accessOrder 按时间戳升序排列（但 Map 不保证排序，需手动找最小值）
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, ts] of accessOrder) {
        if (ts < oldestTime) {
          oldestTime = ts;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        memoryCache.delete(oldestKey);
        accessOrder.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  function touch(key: string) {
    accessOrder.set(key, Date.now());
  }

  return {
    async getExplanation(cacheKey, llmCallFn) {
      // 1. 内存命中
      const mem = memoryCache.get(cacheKey);
      if (mem) {
        touch(cacheKey);
        logEvent({ event: "cache.hit", level: "debug", data: { source: "memory", cacheKey } });
        return mem;
      }

      // 2. SQLite 命中（同步回内存）
      const rawHash = crypto.createHash("sha256").update(cacheKey).digest("hex");
      const cached = p.getCachedExplanation(rawHash);
      if (cached) {
        touch(cacheKey);
        evictIfNeeded();
        memoryCache.set(cacheKey, cached);
        logEvent({ event: "cache.hit", level: "debug", data: { source: "sqlite", cacheKey, rawHash } });
        return cached;
      }

      // 3. 并发去重：同 key 共享同一个 Promise
      const inflight = pending.get(cacheKey);
      if (inflight) {
        logEvent({ event: "cache.hit", level: "debug", data: { source: "pending", cacheKey } });
        return inflight;
      }

      logEvent({ event: "cache.miss", level: "debug", data: { cacheKey, rawHash } });

      const promise = (async () => {
        try {
          const result = await llmCallFn();
          evictIfNeeded();
          memoryCache.set(cacheKey, result);
          p.saveCache(rawHash, cacheKey, result, "llm");
          logEvent({ event: "cache.save", level: "debug", data: { cacheKey, rawHash } });
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
