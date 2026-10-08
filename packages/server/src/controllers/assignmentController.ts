import fs from "node:fs";
import path from "node:path";
import type { Assignment, Exercise, PublishedAssignment } from "@classroom/shared";
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
      id: a.id, title: a.title, week: a.week, dueAt: a.dueAt,
      exercises: p.getExercises(a.id)
        .filter((e) => e.isActive)
        .map((e) => ({ id: e.id, filename: e.filename, versionHash: e.versionHash })),
    }));
}

/** /content：未发布/下线 404（A20）；内容读自工作克隆 main 检出（A29） */
export function readExerciseContent(p: Persistence, repoDir: string, exerciseId: string):
  { ok: true; filename: string; content: string } | { ok: false; status: 404; error: string } {
  const exercise = p.getExercise(exerciseId);
  if (!exercise || !exercise.isActive) return { ok: false, status: 404, error: "练习不存在或已下线" };
  const assignment = p.getAssignment(exercise.assignmentId);
  if (!assignment || !assignment.isPublished) return { ok: false, status: 404, error: "练习未发布" };
  const abs = path.join(repoDir, `week-${String(assignment.week).padStart(2, "0")}`, exercise.filename);
  if (!fs.existsSync(abs)) return { ok: false, status: 404, error: "文件不存在" };
  return { ok: true, filename: exercise.filename, content: fs.readFileSync(abs, "utf8") };
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
