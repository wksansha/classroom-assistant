import type { TrendBucket } from "@classroom/shared";

const BUCKET_MS = 5 * 60_000;
const PRUNE_MS = 24 * 60 * 60_000;

export interface RunEventRow {
  ts: number;
  success: boolean;
}

export interface TrendTracker {
  /** run 事件驱动：success → runs++，否则 errors++（幂等命中由调用方跳过，spec §5.4） */
  record(ts: number, success: boolean): void;
  /** 服务端重启预热（spec §5.4）：回放 getRunEventsSince(dayStart) 的当天 run 行重建分桶；
   * 预热失败降级空桶 + warmup.failed 日志由装配处 try/catch 负责 */
  warmUpFromRuns(rows: RunEventRow[]): void;
  /** 当天桶（双窗口口径 spec §4.1）：tStart >= dayStartMs（边界计入），tStart 升序 */
  list(dayStartMs: number): TrendBucket[];
}

export function createTrendTracker(): TrendTracker {
  const buckets = new Map<number, TrendBucket>();

  const recordAt = (ts: number, success: boolean) => {
    const tStart = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    const b = buckets.get(tStart) ?? { tStart, runs: 0, errors: 0 };
    if (success) b.runs += 1;
    else b.errors += 1;
    buckets.set(tStart, b);
    for (const [k, v] of buckets) if (ts - v.tStart > PRUNE_MS) buckets.delete(k);   // 24h 修剪防膨胀
  };

  return {
    record(ts, success) {
      recordAt(ts, success);
    },
    warmUpFromRuns(rows) {
      const sorted = [...rows].sort((a, b) => a.ts - b.ts);
      for (const r of sorted) recordAt(r.ts, r.success);
    },
    list(dayStartMs) {
      return [...buckets.values()]
        .filter((b) => b.tStart >= dayStartMs)
        .sort((a, b) => a.tStart - b.tStart);
    },
  };
}
