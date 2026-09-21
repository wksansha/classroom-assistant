import type {
  AggItem, AlertItem, RecentError, StudentState, SuggestionItem, TeacherSnapshot,
} from "@classroom/shared";
import type { StatusColor } from "@classroom/shared";
import type { StudentRecord, StoredEvent } from "./stateManager";
import { logEvent } from "./logger";

const FIVE_MIN = 5 * 60_000;
const TWO_MIN = 2 * 60_000;
const THREE_MIN = 3 * 60_000;
/** 课堂窗口：只聚合/统计这个时间窗口内的事件（默认 120 分钟，可用 CLASS_WINDOW_MIN 环境变量覆盖） */
const CLASS_WINDOW_MS = (Number(process.env.CLASS_WINDOW_MIN) || 120) * 60_000;

/** 事件是否落在当前课堂窗口内（默认 90 分钟，可通过 CLASS_WINDOW_MIN 环境变量覆盖） */
function isWithinClassWindow(ts: number, now: number): boolean {
  return now - ts <= CLASS_WINDOW_MS;
}

/** 窗口内错误事件按 subtype 计数，返回最高重复次数（沿用 spec 的 5 分钟口径） */
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
  // 分数只反映「当前是否还有未解决的错」：最后一次事件是成功 = 已解决 → 0 分。
  // 旧公式用 minutesSinceError*5 让分数随时间一直涨，学生自己修好后反而越来越靠前。
  // 超过课堂窗口的「老旧报错」也不再计入（不会被聚合看到）。
  const unresolved = r.lastErrorAt === r.lastActivityAt; // 最后一次事件是错误
  if (!unresolved) return 0;
  if (!isWithinClassWindow(r.lastErrorAt, now)) return 0;
  const repeat = maxSubtypeRepeat(r.events, now);
  let score = 10 + repeat * 10;
  if (r.consecutiveErrors >= 5) score += 30;
  return score;
}

export interface Aggregator {
  recompute(records: StudentRecord[], now: number): Omit<TeacherSnapshot, "ts" | "classId">;
  ack(id: string): void;
}

interface SubtypeGroup {
  subtype: string;
  category: string;
  knowledge: string;
  latestTs: number;
  students: { studentId: string; studentName: string }[];
}

export function createAggregator(): Aggregator {
  const acked = new Set<string>();

  return {
    recompute(records, now) {
      const startTime = Date.now();
      // ── 学生状态 ────────────────────────────────
      const students: StudentState[] = records.map((r) => {
        const errors = r.events.filter((e) => !e.success && isWithinClassWindow(e.ts, now));
        const recentErrors: RecentError[] = [...errors]
          .slice(-3).reverse()
          .map((e) => ({ ts: e.ts, subtype: e.subtype ?? "未知错误", knowledge: e.knowledge ?? "", rawMessage: e.rawMessage }));
        return {
          studentId: r.studentId, studentName: r.studentName,
          status: computeStatus(r, now),
          priorityScore: computeScore(r, now),
          lastActivityAt: r.lastActivityAt, lastErrorAt: r.lastErrorAt,
          errorCountTotal: errors.length, recentErrors,
        };
      });

      // ── 告警（score>0 前 5）────────────────────
      const scored = records
        .map((r, i) => ({ r, score: students[i].priorityScore }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      const alerts: AlertItem[] = scored.slice(0, 5).map(({ r, score }) => {
        const lastErr = [...r.events].reverse().find((e) => !e.success && isWithinClassWindow(e.ts, now));
        const repeat = maxSubtypeRepeat(r.events, now);
        const unresolved = r.lastErrorAt === r.lastActivityAt; // 最后一次事件仍是错误
        const reason =
          r.consecutiveErrors >= 5 ? `连续报错 ${r.consecutiveErrors} 次`
          : repeat >= 3 ? `同一错误 5 分钟内 ${repeat} 次`
          : unresolved ? `报错后 ${Math.floor((now - (r.lastErrorAt ?? now)) / 60_000)} 分钟无进展`
          : `报错已解决，仍在关注`;
        return {
          studentId: r.studentId, studentName: r.studentName, score,
          reason,
          subtype: lastErr?.subtype ?? "未知错误",
          knowledge: lastErr?.knowledge ?? "",
          lastErrorAt: r.lastErrorAt ?? now,
        };
      });
      // 「正常」= 优先级分为 0 的学生（不能简单用总数减 top5，否则未进榜的报警学生被误计为正常）
      const normalCount = students.filter((s) => s.priorityScore === 0).length;
      const alertSummary = `其余 ${normalCount} 人正常`;

      // ── 聚合（按 subtype，count=人数，仅课堂窗口内）─────────────
      const groups = new Map<string, SubtypeGroup>();
      for (const r of records) {
        for (const e of r.events) {
          if (e.success || !e.subtype || !isWithinClassWindow(e.ts, now)) continue;
          let g = groups.get(e.subtype);
          if (!g) {
            g = { subtype: e.subtype, category: e.category ?? "其他", knowledge: "", latestTs: -1, students: [] };
            groups.set(e.subtype, g);
          }
          if (!g.students.some((s) => s.studentId === r.studentId)) {
            g.students.push({ studentId: r.studentId, studentName: r.studentName });
          }
          if (e.ts >= g.latestTs) {
            g.latestTs = e.ts;
            g.knowledge = e.knowledge ?? g.knowledge;
          }
        }
      }
      // category 由 explainService 写入 StoredEvent（run 用静态映射，diag 来自 LLM），聚合层直接从事件读取。
      const aggregates: AggItem[] = [...groups.values()]
        .map((g) => ({ subtype: g.subtype, category: g.category, knowledge: g.knowledge, count: g.students.length, students: g.students }))
        .sort((a, b) => b.count - a.count);

      // ── 建议（分母 = 课堂窗口内上报过错误的学生数）──────────
      const errorStudents = records.filter((r) => r.events.some((e) => !e.success && isWithinClassWindow(e.ts, now))).length;
      const suggestions: SuggestionItem[] = [];
      if (errorStudents > 0) {
        for (const g of groups.values()) {
          const ratio = g.students.length / errorStudents;
          if (ratio >= 0.4) {
            suggestions.push({
              id: `class-review:${g.subtype}`, kind: "class-review",
              text: `⚠️ ${g.students.length} 人卡在「${g.subtype}」，建议全班讲评`,
              acked: acked.has(`class-review:${g.subtype}`),
            });
          } else if (ratio >= 0.2) {
            suggestions.push({
              id: `group-discuss:${g.subtype}`, kind: "group-discuss",
              text: `💡 ${g.students.length} 人遇到「${g.subtype}」，可小组讨论`,
              acked: acked.has(`group-discuss:${g.subtype}`),
            });
          }
        }
        // 连续报错只认课堂窗口内
        const stuck = records.filter((r) =>
          r.events.some((e) => !e.success && isWithinClassWindow(e.ts, now)) &&
          r.consecutiveErrors >= 3
        );
        if (stuck.length > 0) {
          const id = `individual:${stuck.map((s) => s.studentId).sort().join(",")}`;
          suggestions.push({
            id, kind: "individual",
            text: `🙋 ${stuck.map((s) => s.studentName).join("、")} 连续报错，建议单独辅导`,
            acked: acked.has(id),
          });
        }
      }

      const durationMs = Date.now() - startTime;
      logEvent({ event: "aggregator.recompute", level: "debug", data: {
        studentCount: records.length,
        alertCount: alerts.length,
        aggregateCount: aggregates.length,
        suggestionCount: suggestions.length,
        redCount: students.filter((s) => s.status === "red").length,
        yellowCount: students.filter((s) => s.status === "yellow").length,
        greenCount: students.filter((s) => s.status === "green").length,
        durationMs,
      } });
      return { students, alerts, alertSummary, aggregates, suggestions };
    },

    ack(id) { acked.add(id); },
  };
}
