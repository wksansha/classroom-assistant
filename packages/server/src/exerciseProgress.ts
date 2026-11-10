import type { ExerciseProgressItem, ExerciseStatus, TaskBucket } from "@classroom/shared";

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
  /** 多任务题的任务名（spec 2026-11-09 §5）；NULL = 旧整文件行/单任务行 */
  taskId?: string | null;
}

/** 内部桶 key：任务桶 = `${filePath}::${taskName}`，文件级（单任务/整文件）= filePath；
 * taskName 未注册（无任务清单/不在清单）→ 回退文件级（防御：评审入口总是先 registerTasks） */
const bucketKeyOf = (filePath: string, taskName?: string | null, registry?: Map<string, string[]>) => {
  const tasks = registry?.get(filePath);
  return taskName && tasks && tasks.includes(taskName) ? `${filePath}::${taskName}` : filePath;
};

export interface ExerciseProgressTracker {
  /** 多任务题注册（评审入口调用，spec 2026-11-09 §5）：tasks ≥2 才生效；注册后 run 失败不再判整文件 fail */
  registerTasks(filePath: string, tasks: string[]): void;
  /** 评审结果驱动：fail → latest=fail；pass → latest=pass；title 为题面名；taskName 缺省 = 文件级单桶 */
  applyReview(studentId: string, studentName: string, filePath: string, status: "pass" | "fail", ts: number, title?: string, taskName?: string): void;
  /** 评审请求无有效结论（LLM 未配置/挂/mock 兜底/不确定，spec 决策 #14）：latest=unreviewed；
   * pass/fail 强信号不覆盖；若当前桶有 run 成功 → 降级计通过（桶不被 LLM 故障卡死） */
  applyUnreviewed(studentId: string, studentName: string, filePath: string, ts: number, title?: string, taskName?: string): void;
  /** run 失败驱动：单任务桶 latest=fail（强负面信号）；多任务题仅推进涌现（任务状态权威源 = 逐任务评审） */
  applyRunFailure(studentId: string, studentName: string, filePath: string, ts: number): void;
  /** run 成功驱动：记录当前桶「代码能跑」弱信号；若此前有 LLM 无结论的降级 unreviewed → 升级为通过 */
  applyRunSuccess(studentId: string, studentName: string, filePath: string, ts: number): void;
  /** 服务端重启回放（spec §5.3）：仅传当天行；按 ts 升序回放 latest（unreviewed 不覆盖 pass/fail）；带 taskId 行重建任务注册表 */
  warmUpFromReviews(rows: ReviewResultRow[]): void;
  /** 课间重置（大屏重置）：清空内存格子，从零统计新课 */
  reset(): void;
  /** 当天涌现题（spec 决策 #18）：任一格 lastTs >= dayStartMs 的题才输出；多任务题输出 tasks[] 桶数组；
   * 文件级 top-level = 学生聚合（全部任务 pass → passed / 任一 fail → stuck / 其余 unreviewed）。
   * isOnline 缺省 = 全量（回放/测试）；传入时离线学生的格子不计入 passed/stuck/unreviewed（在线口径） */
  list(dayStartMs: number, isOnline?: (studentId: string) => boolean): Omit<ExerciseProgressItem, "total" | "passRate">[];
}

export function createExerciseProgressTracker(): ExerciseProgressTracker {
  // 桶 key（文件级或任务级）→ 学生 id → 格子（仅服务端内存计数用，决策 #18 涌现口径）
  const buckets = new Map<string, Map<string, Entry>>();
  // filePath → 任务名清单（多任务注册表；评审入口 registerTasks / 回放 taskId 行重建）
  const fileTasks = new Map<string, string[]>();
  // bucket key → 桶题面名（评审输入解析；首个非空生效）
  const bucketTitles = new Map<string, string>();
  // filePath → 文件题面名（任一桶带 title 时首个非空生效）
  const fileTitles = new Map<string, string>();

  const setTitle = (key: string, filePath: string, title?: string) => {
    if (!title) return;
    if (!bucketTitles.has(key)) bucketTitles.set(key, title);
    if (!fileTitles.has(filePath)) fileTitles.set(filePath, title);
  };

  const entryOf = (key: string, studentId: string, studentName: string, ts: number): Entry => {
    let m = buckets.get(key);
    if (!m) { m = new Map(); buckets.set(key, m); }
    let e = m.get(studentId);
    if (!e) { e = { studentName, latest: "unreviewed" as ExerciseStatus, lastTs: ts, firstTs: ts, runOk: false, degraded: false }; m.set(studentId, e); }
    e.studentName = studentName;
    e.lastTs = Math.max(e.lastTs, ts);
    e.firstTs = Math.min(e.firstTs, ts);
    return e;
  };

  return {
    registerTasks(filePath, tasks) {
      if (tasks.length >= 2) fileTasks.set(filePath, [...tasks]);
    },

    applyReview(studentId, studentName, filePath, status, ts, title, taskName) {
      const key = bucketKeyOf(filePath, taskName, fileTasks);
      const e = entryOf(key, studentId, studentName, ts);
      setTitle(key, filePath, title);
      e.latest = status;   // pass / fail（强信号，覆盖降级态）
    },
    applyUnreviewed(studentId, studentName, filePath, ts, title, taskName) {
      const key = bucketKeyOf(filePath, taskName, fileTasks);
      const e = entryOf(key, studentId, studentName, ts);
      setTitle(key, filePath, title);
      e.degraded = true;   // 该 unreviewed 来自评审请求（LLM 无有效结论），非「从未提交」
      if (e.latest !== "pass" && e.latest !== "fail") {
        e.latest = e.runOk ? "pass" : "unreviewed";   // 降级：当前题代码能跑 → 计通过，桶不被 LLM 故障卡死
      }
    },
    applyRunFailure(studentId, studentName, filePath, ts) {
      const tasks = fileTasks.get(filePath);
      if (tasks && tasks.length >= 2) {
        // 多任务题（spec §5 语义修正）：run 是文件级信号，失败不判任何任务 fail，仅推进涌现时间
        for (const t of tasks) entryOf(`${filePath}::${t}`, studentId, studentName, ts);
        return;
      }
      const e = entryOf(filePath, studentId, studentName, ts);
      e.latest = "fail";
    },
    applyRunSuccess(studentId, studentName, filePath, ts) {
      const tasks = fileTasks.get(filePath);
      const keys = tasks && tasks.length >= 2 ? tasks.map((t) => `${filePath}::${t}`) : [filePath];
      for (const key of keys) {
        const e = entryOf(key, studentId, studentName, ts);
        e.runOk = true;
        if (e.degraded && e.latest === "unreviewed") e.latest = "pass";   // 成功晚于降级 unreviewed 到达 → 补升级
      }
    },
    warmUpFromReviews(rows) {
      // 先按行序重建任务注册表（回放行已按 ts 升序；taskId 去重保序，≥2 才注册）
      const byFile = new Map<string, string[]>();
      for (const r of rows) {
        if (!r.taskId) continue;
        const list = byFile.get(r.filePath) ?? [];
        if (!list.includes(r.taskId)) list.push(r.taskId);
        byFile.set(r.filePath, list);
      }
      for (const [filePath, tasks] of byFile) this.registerTasks(filePath, tasks);

      const sorted = [...rows].sort((a, b) => a.ts - b.ts);
      for (const r of sorted) {
        const key = bucketKeyOf(r.filePath, r.taskId, fileTasks);
        const e = entryOf(key, r.studentId, r.studentName, r.ts);
        if (r.status === "unreviewed") {
          e.degraded = true;   // review_results 落行的 unreviewed 必来自评审请求
          if (e.latest !== "pass" && e.latest !== "fail") e.latest = e.runOk ? "pass" : "unreviewed";   // 与实时语义一致
        } else {
          e.latest = r.status;
        }
      }
    },
    reset() {
      buckets.clear();
      fileTasks.clear();
      bucketTitles.clear();
      fileTitles.clear();
    },
    list(dayStartMs, isOnline) {
      // 桶 key 按 filePath 分组
      const groups = new Map<string, { keys: string[]; taskNames: Map<string, string> }>();
      for (const key of buckets.keys()) {
        const idx = key.lastIndexOf("::");
        const filePath = idx >= 0 ? key.slice(0, idx) : key;
        const taskName = idx >= 0 ? key.slice(idx + 2) : null;
        let g = groups.get(filePath);
        if (!g) { g = { keys: [], taskNames: new Map() }; groups.set(filePath, g); }
        g.keys.push(key);
        if (taskName) g.taskNames.set(taskName, key);
      }

      const items: Omit<ExerciseProgressItem, "total" | "passRate">[] = [];
      for (const [filePath, g] of groups) {
        const taskNames = fileTasks.get(filePath);
        const isMulti = !!(taskNames && taskNames.length >= 2);

        // 单任务/整文件桶：现状逻辑
        if (!isMulti) {
          const students = buckets.get(filePath);
          if (!students) continue;
          let passed = 0, stuck = 0, unreviewed = 0;
          let active = false;
          let firstTs = Number.MAX_SAFE_INTEGER;
          let latestTs = 0;
          for (const [studentId, e] of students) {
            if (e.lastTs < dayStartMs) continue;   // 当天口径：只统计今天动过的格子
            if (isOnline && !isOnline(studentId)) continue;   // 在线口径：离线学生不计入人数
            active = true;
            firstTs = Math.min(firstTs, e.firstTs);
            latestTs = Math.max(latestTs, e.lastTs);
            if (e.latest === "pass") passed++;
            else if (e.latest === "fail") stuck++;
            else unreviewed++;
          }
          if (!active) continue;   // 题目筛选：当天无提交/运行记录的题不显示
          items.push({
            id: filePath,
            displayName: filePath.split(/[\\/]/).pop() ?? filePath,
            isProject: !filePath.endsWith(".py"),
            passed, stuck, unreviewed,
            firstTs, latestTs,
            title: bucketTitles.get(filePath) ?? fileTitles.get(filePath) ?? (filePath.split(/[\\/]/).pop() ?? filePath),
          });
          continue;
        }

        // 多任务题：逐任务桶 + 文件级学生聚合
        const taskBuckets: TaskBucket[] = [];
        const perStudent = new Map<string, { name: string; statuses: ExerciseStatus[]; firstTs: number; latestTs: number; active: boolean }>();
        let anyActive = false;
        let firstTs = Number.MAX_SAFE_INTEGER;
        let latestTs = 0;
        for (const t of taskNames!) {
          const key = `${filePath}::${t}`;   // isMulti 已确认注册表存在，直接拼任务桶 key
          const students = buckets.get(key) ?? new Map<string, Entry>();
          const b: TaskBucket = { taskId: t, passed: 0, stuck: 0, unreviewed: 0, firstTs: Number.MAX_SAFE_INTEGER, latestTs: 0 };
          let bucketActive = false;
          for (const [studentId, e] of students) {
            if (e.lastTs < dayStartMs) continue;
            if (isOnline && !isOnline(studentId)) continue;   // 在线口径：离线学生不计入人数
            bucketActive = true;
            b.firstTs = Math.min(b.firstTs, e.firstTs);
            b.latestTs = Math.max(b.latestTs, e.lastTs);
            if (e.latest === "pass") b.passed++;
            else if (e.latest === "fail") b.stuck++;
            else b.unreviewed++;
            const s = perStudent.get(studentId) ?? { name: e.studentName, statuses: [], firstTs: Number.MAX_SAFE_INTEGER, latestTs: 0, active: false };
            s.statuses.push(e.latest);
            s.firstTs = Math.min(s.firstTs, e.firstTs);
            s.latestTs = Math.max(s.latestTs, e.lastTs);
            s.active = true;
            perStudent.set(studentId, s);
          }
          if (bucketActive) { anyActive = true; firstTs = Math.min(firstTs, b.firstTs); latestTs = Math.max(latestTs, b.latestTs); }
          taskBuckets.push(b);
        }
        if (!anyActive) continue;

        let passed = 0, stuck = 0, unreviewed = 0;
        for (const s of perStudent.values()) {
          // 学生未涉及的桶 = unreviewed（未开始）；全部 pass → passed；任一 fail → stuck
          const statuses = taskNames!.map((t) => {
            const idx = taskNames!.indexOf(t);
            return s.statuses[idx] ?? "unreviewed";
          });
          if (statuses.every((st) => st === "pass")) passed++;
          else if (statuses.some((st) => st === "fail")) stuck++;
          else unreviewed++;
        }

        items.push({
          id: filePath,
          displayName: filePath.split(/[\\/]/).pop() ?? filePath,
          isProject: !filePath.endsWith(".py"),
          passed, stuck, unreviewed,
          firstTs, latestTs,
          title: fileTitles.get(filePath) ?? (filePath.split(/[\\/]/).pop() ?? filePath),
          tasks: taskBuckets.map((b) => ({
            taskId: b.taskId,
            passed: b.passed, stuck: b.stuck, unreviewed: b.unreviewed,
            firstTs: b.firstTs === Number.MAX_SAFE_INTEGER ? 0 : b.firstTs,
            latestTs: b.latestTs,
          })),
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
