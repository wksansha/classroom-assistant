import { defineStore } from "pinia";
import { ref } from "vue";
import type { Assignment, Exercise, ReviewCompleteData, RosterEntry, Submission, SubmissionReceivedData } from "@classroom/shared";
import { assignmentsApi } from "../api/assignments";

/** A9：列表降序（服务端 submitted_at DESC），每学生首见即最新提交 */
export function latestByStudent(subs: Submission[]): Record<string, Submission> {
  const map: Record<string, Submission> = {};
  for (const s of subs) if (!map[s.studentId]) map[s.studentId] = s;
  return map;
}

export type CellState = "unsubmitted" | "reviewing" | "pass" | "fail" | "unreviewed";

export function cellState(sub: Submission | undefined): CellState {
  if (!sub) return "unsubmitted";
  if (!sub.review) return "reviewing";
  return sub.review.status;
}

export const useAssignmentsStore = defineStore("assignments", () => {
  const assignments = ref<(Assignment & { exercises: Exercise[] })[]>([]);
  const roster = ref<RosterEntry[]>([]);
  const submissionsByExercise = ref<Record<string, Submission[]>>({});

  async function fetchAll() {
    [assignments.value, roster.value] = await Promise.all([assignmentsApi.list(), assignmentsApi.roster()]);
  }

  async function fetchSubmissionsFor(assignment: Assignment & { exercises: Exercise[] }) {
    for (const ex of assignment.exercises) {
      submissionsByExercise.value[ex.id] = await assignmentsApi.submissionsByExercise(ex.id);
    }
  }

  /** SSE 双消息到达 → 只刷新对应练习（A9） */
  async function applyAssignmentMessage(msg: SubmissionReceivedData | ReviewCompleteData) {
    submissionsByExercise.value[msg.exerciseId] = await assignmentsApi.submissionsByExercise(msg.exerciseId);
  }

  async function publishAssignment(id: string, publish: boolean) {
    await assignmentsApi.publish(id, publish);
    await fetchAll();
  }

  return { assignments, roster, submissionsByExercise, fetchAll, fetchSubmissionsFor, applyAssignmentMessage, publishAssignment };
});
