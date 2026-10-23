import type { ExerciseProgressItem, ExerciseStatus } from "@classroom/shared";

interface Entry {
  studentName: string;
  latest: ExerciseStatus;
  /** 最近一次事件时间（epoch ms），list 当天过滤用 */
  lastTs: number;
}

export interface ReviewResultRow {
  studentId: string;
  studentName: string;
  filePath: string;
  status: "pass" | "fail" | "unreviewed";
  ts: number;
}

export interface ExerciseProgressTracker {
  /** 评审结果驱动：fail → latest=fail；pass → latest=pass */
  applyReview(studentId: string, studentName: string, filePath: string, status: "pass" | "fail", ts: number): void;
  /** 评审请求无有效结论（LLM 未配置/挂/mock 兜底/不确定，spec 决策 #14）：latest=unreviewed；pass/fail 强信号不覆盖 */
  applyUnreviewed(studentId: string, studentName: string, filePath: string, ts: number): void;
  /** run 失败驱动：latest=fail（强负面信号） */
  applyRunFailure(studentId: string, studentName: string, filePath: string, ts: number): void;
  /** 服务端重启回放（spec §5.3）：仅传当天行；按 ts 升序回放 latest（unreviewed 不覆盖 pass/fail） */
  warmUpFromReviews(rows: ReviewResultRow[]): void;
  /** 当天涌现题（spec 决策 #18）：任一格 lastTs >= dayStartMs 的题才输出；每题只统计当天格子；三态总和降序；不含学生名单 */
  list(dayStartMs: number): Omit<ExerciseProgressItem, "total" | "passRate">[];
}

export function createExerciseProgressTracker(): ExerciseProgressTracker {
  // 题 id（filePath）→ 学生 id → 格子（仅服务端内存计数用，决策 #18 涌现口径）
  const files = new Map<string, Map<string, Entry>>();

  const entryOf = (id: string, studentId: string, studentName: string, ts: number): Entry => {
    let m = files.get(id);
    if (!m) { m = new Map(); files.set(id, m); }
    let e = m.get(studentId);
    if (!e) { e = { studentName, latest: "unreviewed", lastTs: ts }; m.set(studentId, e); }
    e.studentName = studentName;
    e.lastTs = Math.max(e.lastTs, ts);
    return e;
  };

  return {
    applyReview(studentId, studentName, filePath, status, ts) {
      const e = entryOf(filePath, studentId, studentName, ts);
      e.latest = status;   // pass / fail
    },
    applyUnreviewed(studentId, studentName, filePath, ts) {
      const e = entryOf(filePath, studentId, studentName, ts);
      if (e.latest !== "pass" && e.latest !== "fail") e.latest = "unreviewed";   // 强信号不覆盖
    },
    applyRunFailure(studentId, studentName, filePath, ts) {
      const e = entryOf(filePath, studentId, studentName, ts);
      e.latest = "fail";
    },
    warmUpFromReviews(rows) {
      const sorted = [...rows].sort((a, b) => a.ts - b.ts);
      for (const r of sorted) {
        const e = entryOf(r.filePath, r.studentId, r.studentName, r.ts);
        if (r.status === "unreviewed") {
          if (e.latest !== "pass" && e.latest !== "fail") e.latest = "unreviewed";   // 与实时语义一致
        } else {
          e.latest = r.status;
        }
      }
    },
    list(dayStartMs) {
      const items: Omit<ExerciseProgressItem, "total" | "passRate">[] = [];
      for (const [id, students] of files) {
        let passed = 0, stuck = 0, unreviewed = 0;
        let active = false;
        for (const e of students.values()) {
          if (e.lastTs < dayStartMs) continue;   // 当天口径：只统计今天动过的格子
          active = true;
          if (e.latest === "pass") passed++;
          else if (e.latest === "fail") stuck++;
          else unreviewed++;
        }
        if (!active) continue;   // 题目筛选：当天无提交/运行记录的题不显示
        items.push({
          id,
          displayName: id.split(/[\\/]/).pop() ?? id,
          isProject: !id.endsWith(".py"),
          passed, stuck, unreviewed,
        });
      }
      return items.sort((a, b) => {
        const sumA = a.passed + a.stuck + a.unreviewed;
        const sumB = b.passed + b.stuck + b.unreviewed;
        return sumA !== sumB ? sumB - sumA : a.id < b.id ? -1 : 1;
      });
    },
  };
}
