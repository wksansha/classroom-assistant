import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Persistence } from "./persistence";
import type { GitService } from "./gitService";
import { parseExerciseFile, computeExerciseVersionHash, isProjectIgnoredEntry, parseExerciseManifest, computeProjectVersionHash } from "./assignmentFiles";
import type { Assignment } from "@classroom/shared";
import { logEvent } from "./logger";

export interface SyncResult {
  importedNew: number;
  updated: number;
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

export function createSyncService(deps: SyncServiceDeps): SyncService {
  const { persistence, git, repoDir } = deps;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** 一级子目录内容特征识别（spec §2.1）：含 .py 或含 exercise.json 的子目录 = 作业目录；. / _ 开头或无特征 = 排除 */
  function isAssignmentDir(name: string): boolean {
    if (name.startsWith(".") || name.startsWith("_")) return false;
    const abs = path.join(repoDir, name);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name.endsWith(".py"))) return true;
    return entries.some((e) => e.isDirectory() && fs.existsSync(path.join(abs, e.name, "exercise.json")));
  }

  /** 新作业目录 → week 键：目录名含 week-N 取 N；否则自增；冲突时兜底自增 */
  function deriveWeek(dirName: string): number {
    const all = persistence.getAssignments();
    const maxWeek = all.reduce((mx, a) => Math.max(mx, a.week), 0);
    const m = dirName.match(/^week-(\d+)$/i);
    const wanted = m ? parseInt(m[1], 10) : maxWeek + 1;
    return all.some((a) => a.week === wanted) ? maxWeek + 1 : wanted;
  }

  /** 对账扫描：维护 assignments/exercises 表（评审依赖题面锚点），只读教师仓库不回写（spec §6.3） */
  function scanOnce(result: SyncResult): void {
    // week-N 目录优先处理（week 取 N），其余目录自增派生，保证 week 键派生与目录序无关
    const weekNum = (n: string) => { const m = n.match(/^week-(\d+)$/i); return m ? Number(m[1]) : Number.POSITIVE_INFINITY; };
    const dirNames = fs.readdirSync(repoDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isAssignmentDir(e.name))
      .map((e) => e.name)
      .sort((a, b) => weekNum(a) - weekNum(b) || a.localeCompare(b));
    for (const dirName of dirNames) {
      let assignment = persistence.getAssignments().find((a) => a.weekDir === dirName);
      if (!assignment) {
        // 教师放好目录 push 即布置：建行即已布置，标题默认 = 目录名（管理页可改）
        assignment = { id: randomUUID(), title: dirName, week: deriveWeek(dirName), createdAt: Date.now() };
        persistence.upsertAssignment(assignment);
      }
      if (assignment.weekDir !== dirName) persistence.setAssignmentWeekDir(assignment.id, dirName);
      const activeBefore = persistence.getExercises(assignment.id).filter((e) => e.isActive).map((e) => e.id);
      const seenIds = scanSingleFileExercises(dirName, assignment, result);
      seenIds.push(...scanProjectExercises(dirName, assignment, result, seenIds.length));
      result.deactivated += activeBefore.filter((id) => !seenIds.includes(id)).length;
      persistence.deactivateMissingExercises(assignment.week, seenIds);
    }
    // 磁盘目录已删 / DB-only 作业（week_dir 未落或目录缺失）→ 练习全下线
    for (const a of persistence.getAssignments()) {
      if (a.weekDir && dirNames.includes(a.weekDir)) continue;
      const activeIds = persistence.getExercises(a.id).filter((e) => e.isActive).map((e) => e.id);
      if (activeIds.length === 0) continue;
      persistence.deactivateMissingExercises(a.week, []);
      result.deactivated += activeIds.length;
    }
  }

  /** 单文件练习：目录一级 .py（排序），对账优先头部 id（存量注入头仍有效），无 id 按 (作业目录, filename) 查 DB */
  function scanSingleFileExercises(dirName: string, assignment: Assignment, result: SyncResult): string[] {
    const seenIds: string[] = [];
    const files = fs.readdirSync(path.join(repoDir, dirName)).filter((f) => f.endsWith(".py")).sort();
    files.forEach((filename, idx) => {
      const content = fs.readFileSync(path.join(repoDir, dirName, filename), "utf8");
      const parsed = parseExerciseFile(content);
      let exercise = parsed.exerciseId ? persistence.getExercise(parsed.exerciseId) : null;
      if (!exercise) exercise = persistence.getExercisesByDir(dirName).find((e) => e.filename === filename) ?? null;
      const versionHash = computeExerciseVersionHash(parsed.problemStatement, [], parsed.starterCode);
      if (!exercise) {
        const id = parsed.exerciseId ?? randomUUID();
        persistence.upsertExercise({
          id, assignmentId: assignment.id, order: idx + 1, filename,
          problemStatement: parsed.problemStatement, starterCode: parsed.starterCode,
          testCases: [], versionHash, isActive: true, createdAt: Date.now(),
        });
        result.importedNew++;
        seenIds.push(id);
      } else {
        if (exercise.versionHash !== versionHash) {
          result.updated++;
          if (persistence.getSubmissionsByExercise(exercise.id).length > 0) {
            result.warnings.push(`${dirName}/${filename} 已有提交，内容已变更——评审基准已切换，请通知学生（A30）`);
          }
        }
        persistence.upsertExercise({
          ...exercise, order: idx + 1, problemStatement: parsed.problemStatement,
          starterCode: parsed.starterCode, versionHash, isActive: true,
        });
        seenIds.push(exercise.id);
      }
    });
    return seenIds;
  }

  /** 项目练习：子目录含 exercise.json = 一个 exercise（spec §3），filename = 目录名；startOrder 接续单文件练习排序 */
  function scanProjectExercises(dirName: string, assignment: Assignment, result: SyncResult, startOrder: number): string[] {
    const seenIds: string[] = [];
    const subdirs = fs.readdirSync(path.join(repoDir, dirName), { withFileTypes: true })
      .filter((e) => e.isDirectory());
    let dirOrder = startOrder;
    for (const sd of subdirs) {
      if (isProjectIgnoredEntry(sd.name, true)) continue;
      const manifestRel = `${dirName}/${sd.name}/exercise.json`;
      const manifestAbs = path.join(repoDir, manifestRel);
      if (!fs.existsSync(manifestAbs)) {
        result.warnings.push(`${dirName}/${sd.name} 不是项目练习（缺 exercise.json），已忽略`);
        continue;
      }
      const manifest = parseExerciseManifest(fs.readFileSync(manifestAbs, "utf8"));
      if (!manifest) {
        result.warnings.push(`${dirName}/${sd.name}/exercise.json 不是合法 JSON，已忽略`);
        continue;
      }
      // 递归收集项目文件（忽略清单），路径相对项目目录
      const projFiles: { path: string; content: string }[] = [];
      const walk = (relDir: string) => {
        for (const ent of fs.readdirSync(path.join(repoDir, relDir), { withFileTypes: true })) {
          if (isProjectIgnoredEntry(ent.name, ent.isDirectory())) continue;
          const rel = `${relDir}/${ent.name}`;
          if (ent.isDirectory()) walk(rel);
          else projFiles.push({ path: rel.slice(`${dirName}/${sd.name}/`.length), content: fs.readFileSync(path.join(repoDir, rel), "utf8") });
        }
      };
      walk(`${dirName}/${sd.name}`);
      const entryAbs = path.join(repoDir, dirName, sd.name, manifest.entry ?? "main.py");
      if (!fs.existsSync(entryAbs)) {
        result.warnings.push(`${dirName}/${sd.name} 入口文件 ${manifest.entry} 不存在，已忽略`);
        continue;
      }
      const entryParsed = parseExerciseFile(fs.readFileSync(entryAbs, "utf8"));
      const versionHash = computeProjectVersionHash(projFiles);
      dirOrder += 1;
      // 对账双轨：manifest id 优先，回退 (作业目录, 目录名)——filename = 目录名
      let exercise = manifest.exerciseId ? persistence.getExercise(manifest.exerciseId) : null;
      if (!exercise) exercise = persistence.getExercisesByDir(dirName).find((e) => e.filename === sd.name) ?? null;
      if (!exercise) {
        const id = manifest.exerciseId ?? randomUUID();
        persistence.upsertExercise({
          id, assignmentId: assignment.id, order: dirOrder, filename: sd.name,
          problemStatement: entryParsed.problemStatement, starterCode: entryParsed.starterCode,
          testCases: [], versionHash, isActive: true, createdAt: Date.now(),
          kind: "project", dir: sd.name, entry: manifest.entry,
        });
        result.importedNew++;
        seenIds.push(id);
      } else {
        if (exercise.versionHash !== versionHash) {
          result.updated++;
          if (persistence.getSubmissionsByExercise(exercise.id).length > 0) {
            result.warnings.push(`${dirName}/${sd.name} 已有提交，内容已变更——评审基准已切换，请通知学生（A30）`);
          }
        }
        persistence.upsertExercise({
          ...exercise, order: dirOrder, problemStatement: entryParsed.problemStatement,
          starterCode: entryParsed.starterCode, versionHash, isActive: true,
          kind: "project", dir: sd.name, entry: manifest.entry,
        });
        seenIds.push(exercise.id);
      }
    }
    return seenIds;
  }

  async function syncNow(): Promise<SyncResult> {
    const result: SyncResult = { importedNew: 0, updated: 0, deactivated: 0, warnings: [] };
    await git.ensureClone();
    // 只读对齐（spec §6.3：注入回写退役，服务端对教师仓库只读；alignToRemote 的 reset 顺带丢弃历史遗留本地 commit）
    await git.alignToRemote();
    scanOnce(result);
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
