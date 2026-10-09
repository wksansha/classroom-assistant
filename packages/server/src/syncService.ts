import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Persistence } from "./persistence";
import type { GitService } from "./gitService";
import { parseExerciseFile, injectExerciseId, computeExerciseVersionHash } from "./assignmentFiles";
import { logEvent } from "./logger";

export interface SyncResult {
  importedNew: number;
  updated: number;
  injected: number;
  deactivated: number;
  warnings: string[];
}

export interface SyncService {
  syncNow(): Promise<SyncResult>;
  start(): void;
  stop(): void;
}

export interface SyncServiceDeps {
  persistence: Persistence;
  git: GitService;
  repoDir: string;
  intervalMs?: number;
}

/** Phase 4：补推 git_synced=0 的提交到学生分支（独立导出，提交链失败时也可调用） */
export async function retryFailedPushes(persistence: Persistence, git: GitService): Promise<void> {
  for (const sub of persistence.getUnsyncedSubmissions()) {
    const exercise = persistence.getExercise(sub.exerciseId);
    const assignment = exercise ? persistence.getAssignment(exercise.assignmentId) : null;
    if (!exercise || !assignment) continue;
    const r = await git.writeToStudentBranch({
      studentId: sub.studentId, studentName: sub.studentName,
      week: assignment.week, filename: exercise.filename, content: sub.code,
    });
    if (r === "ok") {
      persistence.setSubmissionGitSynced(sub.id);
    } else {
      logEvent({ event: "git.push_failed", level: "error", data: { submissionId: sub.id, result: r } });
    }
  }
}

export function createSyncService(deps: SyncServiceDeps): SyncService {
  const { persistence, git, repoDir } = deps;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** Phase 2：扫描 week-N/*.py 与 DB 对账；返回待注入文件 */
  function scanOnce(result: SyncResult): { path: string; content: string }[] {
    const injections: { path: string; content: string }[] = [];
    // 磁盘上的 week 目录（教师整目录删除后 git 不留空目录 → 磁盘缺失，但 DB 周仍需对账下线）
    const diskWeeks = new Map<number, string>();
    for (const entry of fs.readdirSync(repoDir, { withFileTypes: true })) {
      const m = entry.isDirectory() ? entry.name.match(/^week-(\d+)$/) : null;
      if (m) diskWeeks.set(parseInt(m[1], 10), entry.name);
    }
    const dbWeeks = persistence.getAssignments().map((a) => a.week);
    const weeks = new Set<number>([...diskWeeks.keys(), ...dbWeeks]);
    for (const week of weeks) {
      const dirName = diskWeeks.get(week);
      let assignment = persistence.getAssignments().find((a) => a.week === week);
      if (!assignment) {
        assignment = { id: randomUUID(), title: `第 ${week} 周作业`, week, isPublished: false, createdAt: Date.now() };
        persistence.upsertAssignment(assignment);
      }
      const activeBefore = persistence.getExercises(assignment.id).filter((e) => e.isActive).map((e) => e.id);
      const files = dirName
        ? fs.readdirSync(path.join(repoDir, dirName)).filter((f) => f.endsWith(".py")).sort()
        : [];
      const seenIds: string[] = [];
      files.forEach((filename, idx) => {
        const rel = `${dirName}/${filename}`;
        const content = fs.readFileSync(path.join(repoDir, rel), "utf8");
        const parsed = parseExerciseFile(content);
        // 对账（A28）：优先头部 id；无 id 按 (week, filename) 查 DB——ID 以 DB 为准
        let exercise = parsed.exerciseId ? persistence.getExercise(parsed.exerciseId) : null;
        if (!exercise) exercise = persistence.findExerciseByPath(week, filename);
        const versionHash = computeExerciseVersionHash(parsed.problemStatement, [], parsed.starterCode);
        if (!exercise) {
          const id = parsed.exerciseId ?? randomUUID();
          persistence.upsertExercise({
            id, assignmentId: assignment!.id, order: idx + 1, filename,
            problemStatement: parsed.problemStatement, starterCode: parsed.starterCode,
            testCases: [], versionHash, isActive: true, createdAt: Date.now(),
          });
          result.importedNew++;
          seenIds.push(id);
          if (!parsed.exerciseId) injections.push({ path: rel, content: injectExerciseId(content, id, week) });
        } else {
          if (exercise.versionHash !== versionHash) {
            result.updated++;
            if (assignment!.isPublished && persistence.getSubmissionsByExercise(exercise.id).length > 0) {
              result.warnings.push(`week-${week}/${filename} 已发布且有提交，内容已变更——评审基准已切换，请通知学生（A30）`);
            }
          }
          persistence.upsertExercise({
            ...exercise, order: idx + 1, problemStatement: parsed.problemStatement,
            starterCode: parsed.starterCode, versionHash, isActive: true,
          });
          seenIds.push(exercise.id);
          if (!parsed.exerciseId) injections.push({ path: rel, content: injectExerciseId(content, exercise.id, week) });
        }
      });
      result.deactivated += activeBefore.filter((id) => !seenIds.includes(id)).length;
      persistence.deactivateMissingExercises(week, seenIds);
    }
    return injections;
  }

  async function syncNow(): Promise<SyncResult> {
    const result: SyncResult = { importedNew: 0, updated: 0, injected: 0, deactivated: 0, warnings: [] };
    await git.ensureClone();
    // Phase 0：清算上轮遗留（A28——丢弃安全：注入 ID 以 DB 为准，本轮会重注入）
    if (await git.hasUnpushedMainCommits()) {
      if (await git.pushMain() !== "ok") await git.alignToRemote();
    }
    // Phase 1：对齐远端
    await git.alignToRemote();
    // Phase 2 + 3：扫描对账 + 注入回写（rejected 时重扫重注入一次，A28）
    let injections = scanOnce(result);
    if (injections.length > 0) {
      let r = await git.commitAndPushMain(injections, `inject: exercise-id for ${injections.length} file(s)`);
      if (r === "rejected") {
        await git.alignToRemote();
        injections = scanOnce(result);
        if (injections.length > 0) {
          r = await git.commitAndPushMain(injections, `inject: exercise-id for ${injections.length} file(s)`);
        }
      }
      if (r === "ok") result.injected = injections.length;
      else result.warnings.push("git 注入回写失败，已保留本地 commit，下轮同步自动重试");
    }
    // Phase 4：补推未同步提交
    await retryFailedPushes(persistence, git);
    logEvent({ event: "sync.completed", level: "info", data: { ...result } });
    return result;
  }

  return {
    syncNow,
    start() {
      const envMs = Number(process.env.GIT_SYNC_INTERVAL_MS);
      const intervalMs = deps.intervalMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : 60_000);
      void syncNow().catch((err) => logEvent({ event: "sync.failed", level: "error", data: { error: String(err) } }));
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        void syncNow().catch((err) => logEvent({ event: "sync.failed", level: "error", data: { error: String(err) } }));
      }, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
