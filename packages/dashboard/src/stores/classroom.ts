import { defineStore } from "pinia";
import type { TeacherSnapshot } from "@classroom/shared";

export const useClassroom = defineStore("classroom", {
  state: () => ({
    snapshot: null as TeacherSnapshot | null,
    sseConnected: false,
    activeStudentId: null as string | null,
  }),
  actions: {
    applySnapshot(s: TeacherSnapshot) { this.snapshot = s; },
    applyUpdate(s: TeacherSnapshot) { this.snapshot = s; }, // V1：全量替换（见 Task 12 取舍）
    openDrawer(id: string) { this.activeStudentId = id; },
    closeDrawer() { this.activeStudentId = null; },
  },
  getters: {
    activeStudent(state) {
      return state.snapshot?.students.find((s) => s.studentId === state.activeStudentId) ?? null;
    },
  },
});