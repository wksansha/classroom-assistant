import crypto from "node:crypto";
import type { Explanation } from "@classroom/shared";
import type { Persistence } from "../persistence";
import { logger, logEvent } from "../logger";

type ExplSource = "llm" | "mock";

export interface Cache {
  // llmCallFn 返回 callLLM 的结果（Explanation + source），source 由 llm.ts 如实标注（真实成功=llm，任何 mock 兜底=mock）
  getExplanation(
    cacheKey: string,
    llmCallFn: () => Promise<Explanation & { source: ExplSource }>,
  ): Promise<{ exp: Explanation; source: ExplSource }>;
  getStats(): { memoryCacheSize: number; pendingRequestsSize: number };
}

export function createCache(p: Persistence): Cache {
  const memoryCache = new Map<string, { exp: Explanation; source: ExplSource }>();
  const accessOrder = new Map<string, number>(); // timestamp of last access
  const MAX_MEMORY_CACHE_SIZE = Number(process.env.CACHE_SIZE_LIMIT) || 1000; // 控制内存缓存上限，避免溢出
  const pending = new Map<string, Promise<{ exp: Explanation; source: ExplSource }>>();

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

      // 2. SQLite 命中（同步回内存；source 取缓存行原值，未知值防御性归一为 llm）
      const rawHash = crypto.createHash("sha256").update(cacheKey).digest("hex");
      const cached = p.getCachedExplanation(rawHash);
      if (cached) {
        touch(cacheKey);
        evictIfNeeded();
        const entry = {
          exp: { category: cached.category, subtype: cached.subtype, knowledge: cached.knowledge },
          source: cached.source === "mock" ? ("mock" as const) : ("llm" as const),
        };
        memoryCache.set(cacheKey, entry);
        logEvent({ event: "cache.hit", level: "debug", data: { source: "sqlite", cacheKey, rawHash } });
        return entry;
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
          const entry = {
            exp: { category: result.category, subtype: result.subtype, knowledge: result.knowledge },
            source: result.source,
          };
          evictIfNeeded();
          memoryCache.set(cacheKey, entry);
          p.saveCache(rawHash, cacheKey, entry.exp, entry.source);
          logEvent({ event: "cache.save", level: "debug", data: { cacheKey, rawHash } });
          return entry;
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
