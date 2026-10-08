import type { ReviewResult } from "@classroom/shared";
import type { Persistence } from "../persistence";

export interface ReviewCacheArgs { cacheKey: string; exerciseId: string; versionHash: string; }

export interface ReviewCache {
  getReview(args: ReviewCacheArgs, llmCallFn: () => Promise<ReviewResult>): Promise<ReviewResult>;
  getStats(): { memoryCacheSize: number; pendingSize: number };
}

export function createReviewCache(p: Persistence): ReviewCache {
  const memoryCache = new Map<string, ReviewResult>();
  const accessOrder = new Map<string, number>();
  const MAX = Number(process.env.CACHE_SIZE_LIMIT) || 1000;
  const pending = new Map<string, Promise<ReviewResult>>();

  function evictIfNeeded() {
    while (memoryCache.size >= MAX && accessOrder.size > 0) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, ts] of accessOrder) if (ts < oldestTime) { oldestTime = ts; oldestKey = key; }
      if (!oldestKey) break;
      memoryCache.delete(oldestKey);
      accessOrder.delete(oldestKey);
    }
  }

  return {
    async getReview(args, llmCallFn) {
      const { cacheKey } = args;
      const mem = memoryCache.get(cacheKey);
      if (mem) {
        accessOrder.set(cacheKey, Date.now());
        return { ...mem, reviewedAt: Date.now() };   // 缓存命中重打时间戳
      }
      const cached = p.getCachedReview(cacheKey);
      if (cached) {
        accessOrder.set(cacheKey, Date.now());
        evictIfNeeded();
        const result = { ...cached, reviewedAt: Date.now() };
        memoryCache.set(cacheKey, result);
        return result;
      }
      const inflight = pending.get(cacheKey);
      if (inflight) return inflight;

      const promise = (async () => {
        try {
          const result = await llmCallFn();
          // A30：仅终态（pass/fail）入缓存；unreviewed 为瞬态结果，重试即重评
          if (result.status !== "unreviewed") {
            evictIfNeeded();
            memoryCache.set(cacheKey, result);
            p.saveReviewCache({ cacheKey, exerciseId: args.exerciseId, versionHash: args.versionHash, review: result });
          }
          return result;
        } finally {
          pending.delete(cacheKey);
        }
      })();
      pending.set(cacheKey, promise);
      return promise;
    },
    getStats: () => ({ memoryCacheSize: memoryCache.size, pendingSize: pending.size }),
  };
}
