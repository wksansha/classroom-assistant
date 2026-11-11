import type { ActivityFeedItem, ActivityKind } from "@classroom/shared";
import { logEvent } from "./logger";

/** 课堂动态聚合（内存态，不落库）：
 * - 环形缓冲最近 30 条（新的在前），随快照全量下发
 * - 按 studentId+filePath 维护「第 N 次运行/评审」计数（run 含失败；review 含 unreviewed）
 * - 代码片段 LRU（评审输入全文 + 题面名）：/api/feed/code 懒加载，避免快照膨胀
 * - 评审 unreviewed 只计数不产生条目 → LLM 不可用时 feed 自动只剩运行类（降级语义，前端零特判）
 */

const MAX_FEED = 30;
const MAX_CODE_STASH = 200;
const REASON_MAX = 120;

export interface RunRecordArgs {
  studentId: string;
  studentName: string;
  success: boolean;
  ts: number;
  filePath: string | null;
  errorType: string | null;
  errorMessage: string | null;
}

export interface ReviewRecordArgs {
  studentId: string;
  studentName: string;
  filePath: string;
  ts: number;
  /** partial = 多任务题部分完成：整体 unreviewed 但至少一个任务有真实结论（用户 2026-11-11） */
  status: "pass" | "fail" | "unreviewed" | "partial";
  reason: string | null;
  title?: string;
}

export interface CodeStashArgs {
  studentId: string;
  filePath: string;
  code: string;
  title?: string;
}

/** 重启回放行（spec §5.3 同口径：仅窗口内）。
 * run_fail 明细未归档错误类型（events 表无 error_type 列），不回放条目，只靠 run 成功与评审行重建 */
export interface ReplayRow {
  kind: ActivityKind | "review_count";   // review_count = unreviewed：只计数不产生条目
  studentId: string;
  studentName: string;
  filePath: string;
  ts: number;
  reasonTag?: string | null;
  reason?: string | null;
  title?: string | null;
}

export interface ActivityFeed {
  recordRun(args: RunRecordArgs): void;
  recordReview(args: ReviewRecordArgs): void;
  stashCode(args: CodeStashArgs): void;
  getCode(studentId: string, filePath: string): { title: string | null; code: string } | null;
  /** 最近 30 条，新的在前 */
  list(): ActivityFeedItem[];
  reset(): void;
  replay(rows: ReplayRow[]): void;
}

/** 计数键：studentId + filePath（\u0000 分隔避免拼接歧义） */
const countKey = (studentId: string, filePath: string | null) => `${studentId}\u0000${filePath ?? "_"}`;

/** 文件名（basename）：运行事件带本机绝对路径、评审请求带相对路径，同一文件的两种上报形态 */
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function createActivityFeed(): ActivityFeed {
  const items: ActivityFeedItem[] = [];   // 新的在前
  const runCounts = new Map<string, number>();
  const reviewCounts = new Map<string, number>();
  // 代码 LRU：新写入删旧键再重插（Map 迭代序 = 插入序，队首最旧）
  const codeStash = new Map<string, { title: string | null; code: string }>();
  // 题面名记忆（评审输入提取，独立于代码 LRU）：run 条目与后续评审条目回退取用
  const titles = new Map<string, string>();
  let seq = 0;

  const bump = (m: Map<string, number>, key: string): number => {
    const n = (m.get(key) ?? 0) + 1;
    m.set(key, n);
    return n;
  };

  const rememberTitle = (studentId: string, filePath: string | null, title?: string) => {
    if (title && filePath) titles.set(countKey(studentId, filePath), title);
  };

  const prepend = (item: Omit<ActivityFeedItem, "id">) => {
    items.unshift({ ...item, id: `${item.studentId}:${item.kind}:${++seq}` });
    if (items.length > MAX_FEED) items.length = MAX_FEED;
  };

  const stashTitle = (studentId: string, filePath: string | null): string | null => {
    if (!filePath) return null;
    return codeStash.get(countKey(studentId, filePath))?.title ?? titles.get(countKey(studentId, filePath)) ?? null;
  };

  return {
    recordRun(args) {
      const attempt = bump(runCounts, countKey(args.studentId, args.filePath));
      const kind: ActivityKind = args.success ? "run_ok" : "run_fail";
      prepend({
        kind, studentId: args.studentId, studentName: args.studentName, ts: args.ts,
        attempt,
        reasonTag: args.success ? null : (args.errorType ?? "错误"),
        reason: args.success ? null : (args.errorMessage ?? "").slice(0, REASON_MAX) || null,
        title: stashTitle(args.studentId, args.filePath),
        filePath: args.filePath,
      });
    },

    recordReview(args) {
      const attempt = bump(reviewCounts, countKey(args.studentId, args.filePath));
      rememberTitle(args.studentId, args.filePath, args.title);
      if (args.status === "unreviewed") return;   // LLM 降级/瞬态：只计数不进 feed
      prepend({
        kind: args.status === "pass" ? "review_pass"
          : args.status === "fail" ? "review_fail"
          : "review_partial",   // partial = 多任务部分完成（含任务清单摘要，教师可见进度）
        studentId: args.studentId, studentName: args.studentName, ts: args.ts,
        attempt,
        reasonTag: args.status === "fail" ? "评审意见" : args.status === "partial" ? "部分完成" : null,
        reason: args.status === "pass" ? null : (args.reason ?? "").slice(0, REASON_MAX) || null,
        title: args.title ?? stashTitle(args.studentId, args.filePath),
        filePath: args.filePath,
      });
    },

    stashCode(args) {
      const key = countKey(args.studentId, args.filePath);
      rememberTitle(args.studentId, args.filePath, args.title);
      codeStash.delete(key);
      codeStash.set(key, { title: args.title ?? null, code: args.code });
      while (codeStash.size > MAX_CODE_STASH) {
        const oldest = codeStash.keys().next().value;
        if (oldest === undefined) break;
        codeStash.delete(oldest);
      }
    },

    getCode(studentId, filePath) {
      const hit = codeStash.get(countKey(studentId, filePath));
      if (hit) return hit;
      // 路径形态不一致回退：运行条目是本机绝对路径、代码缓存键是评审上报的相对路径，
      // 精确未命中时按文件名匹配同一学生的同名片（LRU ≤200 条，线性扫无压力）
      const target = baseName(filePath);
      for (const [key, val] of codeStash) {
        if (!key.startsWith(`${studentId}\u0000`)) continue;
        if (baseName(key.slice(studentId.length + 1)) === target) return val;
      }
      return null;
    },

    list: () => [...items],

    reset() {
      items.length = 0;
      runCounts.clear();
      reviewCounts.clear();
      codeStash.clear();
      titles.clear();
      logEvent({ event: "feed.reset", level: "info" });
    },

    /** 回放行按 ts 升序传入：逐行前置 → 结果天然新的在前。计数与实时路径同构 */
    replay(rows) {
      for (const r of rows) {
        if (r.kind === "run_ok") {
          const attempt = bump(runCounts, countKey(r.studentId, r.filePath));
          prepend({
            kind: r.kind, studentId: r.studentId, studentName: r.studentName, ts: r.ts,
            attempt, reasonTag: null, reason: null,
            title: r.title ?? stashTitle(r.studentId, r.filePath),
            filePath: r.filePath,
          });
        } else {
          const attempt = bump(reviewCounts, countKey(r.studentId, r.filePath));
          if (r.kind === "review_count") continue;   // unreviewed：只计数
          prepend({
            kind: r.kind, studentId: r.studentId, studentName: r.studentName, ts: r.ts,
            attempt,
            reasonTag: r.kind === "review_fail" ? "评审意见" : r.kind === "review_partial" ? "部分完成" : null,
            reason: r.kind === "review_fail" || r.kind === "review_partial" ? (r.reason ?? "").slice(0, REASON_MAX) || null : null,
            title: r.title ?? stashTitle(r.studentId, r.filePath),
            filePath: r.filePath,
          });
        }
      }
      logEvent({ event: "feed.replay", level: "info", data: { rows: rows.length, items: items.length } });
    },
  };
}

/** 评审落库行（review_results 表，多任务题每任务一行带 task_id） */
export interface ReviewResultRow {
  studentId: string;
  studentName: string;
  filePath: string;
  status: "pass" | "fail" | "unreviewed";
  reason: string | null;
  ts: number;
  taskId: string | null;
}

const VERDICT_ICON: Record<ReviewResultRow["status"], string> = { pass: "✅", fail: "❌", unreviewed: "⬜" };

/** 评审落库行 → feed 回放行（与实时路径 reviewController 同语义，用户 2026-11-11）：
 * 单任务行 1:1（unreviewed → review_count 只计数）；多任务行（task_id 非空）按 学生+文件 聚合成一条——
 * 任一 fail → review_fail（首个 fail 意见）｜全 pass → review_pass｜有结论未全过 → review_partial（任务清单摘要）｜全 unreviewed → review_count */
export function reviewRowsToFeedRows(rows: ReviewResultRow[]): ReplayRow[] {
  const out: ReplayRow[] = [];
  let group: ReviewResultRow[] = [];
  const flush = () => {
    if (!group.length) return;
    const g = group;
    group = [];
    const anyFail = g.find((r) => r.status === "fail");
    const allPass = g.every((r) => r.status === "pass");
    const anyVerdict = g.some((r) => r.status !== "unreviewed");
    const kind: ReplayRow["kind"] = anyFail ? "review_fail"
      : allPass ? "review_pass"
      : anyVerdict ? "review_partial"
      : "review_count";
    const reason = anyFail ? (anyFail.reason ?? "")
      : kind === "review_partial"
        ? g.map((r) => `${VERDICT_ICON[r.status]}${r.taskId}：${r.status === "unreviewed" ? "未开始" : r.reason ?? ""}`).join(" / ")
        : null;
    out.push({
      kind,
      studentId: g[0].studentId, studentName: g[0].studentName, filePath: g[0].filePath,
      ts: Math.max(...g.map((r) => r.ts)),
      reasonTag: kind === "review_fail" ? "评审意见" : kind === "review_partial" ? "部分完成" : null,
      reason: kind === "review_count" || kind === "review_pass" ? null : reason || null,
    });
  };
  for (const r of rows) {
    if (r.taskId == null) {
      flush();
      out.push({
        kind: r.status === "pass" ? "review_pass" : r.status === "fail" ? "review_fail" : "review_count",
        studentId: r.studentId, studentName: r.studentName, filePath: r.filePath, ts: r.ts,
        reasonTag: r.status === "fail" ? "评审意见" : null,
        reason: r.status === "fail" ? r.reason : null,
      });
      continue;
    }
    const last = group[group.length - 1];
    if (last && (last.studentId !== r.studentId || last.filePath !== r.filePath)) flush();
    group.push(r);
  }
  flush();
  return out;
}
