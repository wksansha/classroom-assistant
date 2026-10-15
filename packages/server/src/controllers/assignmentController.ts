import type { Assignment, Exercise } from "@classroom/shared";
import type { Persistence } from "../persistence";

export type AssignmentWithExercises = Assignment & { exercises: Exercise[] };

export function listAssignmentsWithExercises(p: Persistence): AssignmentWithExercises[] {
  return p.getAssignments().map((a) => ({ ...a, exercises: p.getExercises(a.id) }));
}

export function getAssignmentDetail(p: Persistence, id: string): AssignmentWithExercises | null {
  const a = p.getAssignment(id);
  return a ? { ...a, exercises: p.getExercises(a.id) } : null;
}
