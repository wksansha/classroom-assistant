import fs from "node:fs";
import path from "node:path";
import type { Assignment, Exercise, PublishedAssignment, SubmissionFile } from "@classroom/shared";
import type { Persistence } from "../persistence";
import type { GitService } from "../gitService";

export type AssignmentWithExercises = Assignment & { exercises: Exercise[] };

export function listAssignmentsWithExercises(p: Persistence): AssignmentWithExercises[] {
  return p.getAssignments().map((a) => ({ ...a, exercises: p.getExercises(a.id) }));
}

export function getAssignmentDetail(p: Persistence, id: string): AssignmentWithExercises | null {
  const a = p.getAssignment(id);
  return a ? { ...a, exercises: p.getExercises(a.id) } : null;
}

/** 学生端拉取清单（A26/A30：携带 versionHash 供更新检测） */
export function buildPublishedList(p: Persistence): PublishedAssignment[] {
  return p.getAssignments()
    .filter((a) => a.isPublished)
    .map((a) => ({
      id: a.id, title: a.title, week: a.week, dueAt: a.dueAt, weekDir: a.weekDir,
      exercises: p.getExercises(a.id)
        .filter((e) => e.isActive)
        .map((e) => ({ id: e.id, filename: e.filename, versionHash: e.versionHash,
          kind: e.kind ?? "file", dir: e.dir, entry: e.entry })),
    }));
}

/** /content：未发布/下线 404（A20）；内容读自 main ref（T7-2：git show 规避工作树检出竞态），无 git 时读工作树兜底；
 *  V2.0 起返回联合 JSON（单文件 kind=file；项目题 kind=project 携带 dir/entry/files） */
export type ExerciseContentResult =
  | { ok: true; kind: "file"; filename: string; content: string }
  | { ok: true; kind: "project"; filename: string; dir: string; entry: string; files: SubmissionFile[] }
  | { ok: false; status: 404; error: string };

export async function readExerciseContent(p: Persistence, repoDir: string, git: GitService | null, exerciseId: string):
  Promise<ExerciseContentResult> {
  const exercise = p.getExercise(exerciseId);
  if (!exercise || !exercise.isActive) return { ok: false, status: 404, error: "练习不存在或已下线" };
  const assignment = p.getAssignment(exercise.assignmentId);
  if (!assignment || !assignment.isPublished) return { ok: false, status: 404, error: "练习未发布" };
  // relPath 用 POSIX 分隔符（与 gitService.writeToStudentBranch 的构造方式一致）
  // 宽容归一：优先使用磁盘实际目录名（week_dir），缺省回退补零 week-XX
  const weekDir = assignment.weekDir ?? `week-${String(assignment.week).padStart(2, "0")}`;

  if ((exercise.kind ?? "file") === "project" && exercise.dir) {
    const dirRel = `${weekDir}/${exercise.dir}`;
    const entry = exercise.entry ?? "main.py";
    const files: SubmissionFile[] = [];
    if (git) {
      let paths: string[];
      try {
        paths = await git.listFilesFromMain(dirRel);
      } catch {
        return { ok: false, status: 404, error: "项目目录不存在" };
      }
      if (!paths.includes(entry)) return { ok: false, status: 404, error: "入口文件不存在" };
      for (const rel of paths) {
        files.push({ path: rel, content: await git.readFileFromMain(`${dirRel}/${rel}`) });
      }
    } else {
      // 无 git 兜底：读工作树目录（fs.existsSync 校验，风格同单文件分支）
      const absRoot = path.join(repoDir, dirRel);
      if (!fs.existsSync(absRoot)) return { ok: false, status: 404, error: "项目目录不存在" };
      const walk = (absDir: string, relDir: string) => {
        for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
          const abs = path.join(absDir, ent.name);
          const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
          if (ent.isDirectory()) walk(abs, rel);
          else files.push({ path: rel, content: fs.readFileSync(abs, "utf8") });
        }
      };
      walk(absRoot, "");
      if (!files.some((f) => f.path === entry)) return { ok: false, status: 404, error: "入口文件不存在" };
    }
    return { ok: true, kind: "project", filename: exercise.dir, dir: exercise.dir, entry, files };
  }

  const rel = `${weekDir}/${exercise.filename}`;
  if (git) {
    try {
      return { ok: true, kind: "file", filename: exercise.filename, content: await git.readFileFromMain(rel) };
    } catch {
      return { ok: false, status: 404, error: "文件不存在" };
    }
  }
  const abs = path.join(repoDir, rel);
  if (!fs.existsSync(abs)) return { ok: false, status: 404, error: "文件不存在" };
  return { ok: true, kind: "file", filename: exercise.filename, content: fs.readFileSync(abs, "utf8") };
}

/** 发布/取消发布（A18）：置位 + 按名册预建学生分支（A16） */
export async function publishAssignment(p: Persistence, git: GitService | null, id: string, publish: boolean):
  Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!p.getAssignment(id)) return { ok: false, status: 404, error: "作业不存在" };
  if (publish && !git) return { ok: false, status: 503, error: "git 未配置" };
  p.setAssignmentPublished(id, publish, publish ? Date.now() : null);
  if (publish && git) await git.createStudentBranches(p.getRoster().map((r) => r.studentId));
  return { ok: true };
}
