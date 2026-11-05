import type { ExerciseProgressItem, ExerciseStatus } from "@classroom/shared";

interface Entry {
  studentName: string;
  latest: ExerciseStatus;
  /** 最近一次事件时间（epoch ms），list 当天过滤用 */
  lastTs: number;
  /** 首次活跃时间（epoch ms，min 口径），前端按时间顺序编号展示用 */
  firstTs: number;
  /** 当前题有运行成功记录（代码能跑）——LLM 无结论时降级计通过的弱信号 */
  runOk: boolean;
  /** 曾收到 LLM 无有效结论的评审（unreviewed）：与「从未提交评审」区分，后者 run 成功不算通过 */
  degraded: boolean;
}

export interface ReviewResultRow {
  studentId: string;
  studentName: string;
  filePath: string;
  status: "pass" | "fail" | "unreviewed";
  ts: number;
}

export interface ExerciseProgressTracker {
  /** 评审结果驱动：fail → latest=fail；pass → latest=pass；title 为题面名（首个非空生效） */
  applyReview(studentId: string, studentName: string, filePath: string, status: "pass" | "fail", ts: number, title?: string): void;
  /** 评审请求无有效结论（LLM 未配置/挂/mock 兜底/不确定，spec 决策 #14）：latest=unreviewed；
   * pass/fail 强信号不覆盖；若当前题已有 run 成功 → 降级计通过（桶不被 LLM 故障卡死） */
  applyUnreviewed(studentId: string, studentName: string, filePath: string, ts: number, title?: string): void;
  /** run 失败驱动：latest=fail（强负面信号） */
  applyRunFailure(studentId: string, studentName: string, filePath: string, ts: number): void;
  /** run 成功驱动：记录当前题「代码能跑」弱信号；若此前有 LLM 无结论的降级 unreviewed → 升级为通过 */
  applyRunSuccess(studentId: string, studentName: string, filePath: string, ts: number): void;
  /** 服务端重启回放（spec §5.3）：仅传当天行；按 ts 升序回放 latest（unreviewed 不覆盖 pass/fail） */
  warmUpFromReviews(rows: ReviewResultRow[]): void;
  /** 课间重置（大屏重置）：清空内存格子，从零统计新课 */
  reset(): void;
  /** 当天涌现题（spec 决策 #18）：任一格 lastTs >= dayStartMs 的题才输出；每题只统计当天格子；三态总和降序；不含学生名单 */
  list(dayStartMs: number): Omit<ExerciseProgressItem, "total" | "passRate">[];
}

export function createExerciseProgressTracker(): ExerciseProgressTracker {
  // 题 id（filePath）→ 学生 id → 格子（仅服务端内存计数用，决策 #18 涌现口径）
  const files = new Map<string, Map<string, Entry>>();
  // 题 id → 题面名（评审输入分隔线前首行注释；首个非空题面生效）
  const fileTitles = new Map<string, string>();

  const setTitle = (id: string, title?: string) => {
    if (title && !fileTitles.has(id)) fileTitles.set(id, title);
  };

  const entryOf = (id: string, studentId: string, studentName: string, ts: number): Entry => {
    let m = files.get(id);
    if (!m) { m = new Map(); files.set(id, m); }
    let e = m.get(studentId);
    if (!e) { e = { studentName, latest: "unreviewed" as ExerciseStatus, lastTs: ts, firstTs: ts, runOk: false, degraded: false }; m.set(studentId, e); }
    e.studentName = studentName;
    e.lastTs = Math.max(e.lastTs, ts);
    e.firstTs = Math.min(e.firstTs, ts);
    return e;
  };

  return {
    applyReview(studentId, studentName, filePath, status, ts, title) {
      const e = entryOf(filePath, studentId, studentName, ts);
      setTitle(filePath, title);
      e.latest = status;   // pass / fail（强信号，覆盖降级态）
    },
    applyUnreviewed(studentId, studentName, filePath, ts, title) {
      const e = entryOf(filePath, studentId, studentName, ts);
      setTitle(filePath, title);
      e.degraded = true;   // 该 unreviewed 来自评审请求（LLM 无有效结论），非「从未提交」
      if (e.latest !== "pass" && e.latest !== "fail") {
        e.latest = e.runOk ? "pass" : "unreviewed";   // 降级：当前题代码能跑 → 计通过，桶不被 LLM 故障卡死
      }
    },
    applyRunFailure(studentId, studentName, filePath, ts) {
      const e = entryOf(filePath, studentId, studentName, ts);
      e.latest = "fail";
    },
    applyRunSuccess(studentId, studentName, filePath, ts) {
      const e = entryOf(filePath, studentId, studentName, ts);
      e.runOk = true;
      if (e.degraded && e.latest === "unreviewed") e.latest = "pass";   // 成功晚于降级 unreviewed 到达 → 补升级
    },
    warmUpFromReviews(rows) {
      const sorted = [...rows].sort((a, b) => a.ts - b.ts);
      for (const r of sorted) {
        const e = entryOf(r.filePath, r.studentId, r.studentName, r.ts);
        if (r.status === "unreviewed") {
          e.degraded = true;   // review_results 落行的 unreviewed 必来自评审请求
          if (e.latest !== "pass" && e.latest !== "fail") e.latest = e.runOk ? "pass" : "unreviewed";   // 与实时语义一致
        } else {
          e.latest = r.status;
        }
      }
    },
    reset() {
      files.clear();
    },
    list(dayStartMs) {
      const items: Omit<ExerciseProgressItem, "total" | "passRate">[] = [];
      for (const [id, students] of files) {
        let passed = 0, stuck = 0, unreviewed = 0;
        let active = false;
        let firstTs = Number.MAX_SAFE_INTEGER;
        let latestTs = 0;
        for (const e of students.values()) {
          if (e.lastTs < dayStartMs) continue;   // 当天口径：只统计今天动过的格子
          active = true;
          firstTs = Math.min(firstTs, e.firstTs);
          latestTs = Math.max(latestTs, e.lastTs);
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
          firstTs,
          latestTs,
          title: fileTitles.get(id) ?? (id.split(/[\\/]/).pop() ?? id),
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
