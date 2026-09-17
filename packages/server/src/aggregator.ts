import type {
  AggItem, AlertItem, RecentError, StudentState, SuggestionItem, TeacherSnapshot,
} from "@classroom/shared";
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
      // ── 学生状态 ────────────────────────────────
      const students: StudentState[] = records.map((r) => {
        const errors = r.events.filter((e) => !e.success);
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
        const lastErr = [...r.events].reverse().find((e) => !e.success);
        const repeat = maxSubtypeRepeat(r.events, now);
        const reason =
          r.consecutiveErrors >= 5 ? `连续报错 ${r.consecutiveErrors} 次`
          : repeat >= 3 ? `同一错误 5 分钟内 ${repeat} 次`
          : `报错后 ${Math.floor((now - (r.lastErrorAt ?? now)) / 60_000)} 分钟无进展`;
        return {
          studentId: r.studentId, studentName: r.studentName, score,
          reason,
          subtype: lastErr?.subtype ?? "未知错误",
          knowledge: lastErr?.knowledge ?? "",
          lastErrorAt: r.lastErrorAt ?? now,
        };
      });
      const alertSummary = `其余 ${records.length - alerts.length} 人正常`;

      // ── 聚合（按 subtype，count=人数）─────────────
      const groups = new Map<string, SubtypeGroup>();
      for (const r of records) {
        for (const e of r.events) {
          if (e.success || !e.subtype) continue;
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

      // ── 建议（分母 = 上报过错误的学生数）──────────
      const errorStudents = records.filter((r) => r.events.some((e) => !e.success)).length;
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
        const stuck = records.filter((r) => r.consecutiveErrors >= 3);
        if (stuck.length > 0) {
          const id = `individual:${stuck.map((s) => s.studentId).sort().join(",")}`;
          suggestions.push({
            id, kind: "individual",
            text: `🙋 ${stuck.map((s) => s.studentName).join("、")} 连续报错，建议单独辅导`,
            acked: acked.has(id),
          });
        }
      }

      return { students, alerts, alertSummary, aggregates, suggestions };
    },

    ack(id) { acked.add(id); },
  };
}
