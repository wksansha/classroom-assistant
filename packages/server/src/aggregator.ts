import type { StatusColor } from "@classroom/shared";
import type { StudentRecord, StoredEvent } from "./stateManager";

const FIVE_MIN = 5 * 60_000;
const TWO_MIN = 2 * 60_000;
const THREE_MIN = 3 * 60_000;

/** 窗口内错误事件按 subtype 计数，返回最高重复次数 */
function maxSubtypeRepeat(events: StoredEvent[], now: number): number {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.success || !e.subtype || now - e.ts > FIVE_MIN) continue;
    counts.set(e.subtype, (counts.get(e.subtype) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

export function computeStatus(r: StudentRecord, now: number): StatusColor {
  if (r.consecutiveErrors >= 5 || maxSubtypeRepeat(r.events, now) >= 3) return "red";
  const recentError = r.events.some((e) => !e.success && now - e.ts <= TWO_MIN);
  if (recentError) return "yellow";
  return "green";
}

export function computeScore(r: StudentRecord, now: number): number {
  if (r.lastErrorAt === null) return 0;
  const repeat = maxSubtypeRepeat(r.events, now);
  const minutesSinceError = Math.floor((now - r.lastErrorAt) / 60_000);
  const unresolved = r.lastErrorAt === r.lastActivityAt; // 最后一次事件是错误
  const stale = now - r.lastErrorAt > THREE_MIN;        // 距上次报错>3 分钟（与公式一致）
  let score = repeat * 10 + minutesSinceError * 5;
  if (stale && unresolved) score += 20;
  if (r.consecutiveErrors >= 5) score += 30;
  return score;
}
