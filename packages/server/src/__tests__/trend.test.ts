import { describe, it, expect } from "vitest";
import { createTrendTracker } from "../trend";

const BUCKET_MS = 5 * 60_000;
const T0 = Date.parse("2026-10-22T08:00:00.000Z");
const DAY_START = Date.parse("2026-10-22T00:00:00.000Z");

describe("TrendTracker（课堂节奏，spec dashboard-v2 §5.4）", () => {
  it("同桶累计：同桶多次 run 计入同一桶，成功/失败分计", () => {
    const t = createTrendTracker();
    t.record(T0 + 1, true);
    t.record(T0 + 2, true);
    t.record(T0 + 3, false);
    expect(t.list(DAY_START)).toEqual([
      { tStart: T0, runs: 2, errors: 1 },
    ]);
  });

  it("跨桶分界：越过 5 分钟边界落新桶，list 输出 tStart 升序", () => {
    const t = createTrendTracker();
    t.record(T0 + BUCKET_MS + 1, false);   // 先记新桶
    t.record(T0 + 1, true);                // 再记旧桶
    t.record(T0 + BUCKET_MS, true);        // 边界时刻恰好对齐新桶起点
    expect(t.list(DAY_START)).toEqual([
      { tStart: T0, runs: 1, errors: 0 },
      { tStart: T0 + BUCKET_MS, runs: 1, errors: 1 },
    ]);
  });

  it("list 当天过滤：昨天桶不输出，恰好等于 dayStart 的桶计入（ts >= windowStart）", () => {
    const t = createTrendTracker();
    t.record(DAY_START - BUCKET_MS + 1, true);   // 昨天桶
    t.record(DAY_START, true);                    // 今天首桶（边界计入）
    t.record(DAY_START + 1, false);
    expect(t.list(DAY_START)).toEqual([
      { tStart: DAY_START, runs: 1, errors: 1 },
    ]);
  });

  it("record 修剪超 24h 旧桶（防内存膨胀）", () => {
    const t = createTrendTracker();
    t.record(Date.now() - 25 * 60 * 60_000, true);
    t.record(Date.now(), true);
    expect(t.list(0)).toHaveLength(1);   // dayStart=0 关闭当天过滤，仅验证修剪
  });

  it("预热重建：warmUpFromRuns 回放 run 行 == 逐条 record（含乱序行）", () => {
    const rows = [
      { ts: T0 + BUCKET_MS + 1, success: false },
      { ts: T0 + 1, success: true },
      { ts: T0 + 2, success: true },
    ];
    const warm = createTrendTracker();
    warm.warmUpFromRuns(rows);
    const live = createTrendTracker();
    for (const r of rows) live.record(r.ts, r.success);
    expect(warm.list(DAY_START)).toEqual(live.list(DAY_START));
    expect(warm.list(DAY_START)).toEqual([
      { tStart: T0, runs: 2, errors: 0 },
      { tStart: T0 + BUCKET_MS, runs: 0, errors: 1 },
    ]);
  });
});
