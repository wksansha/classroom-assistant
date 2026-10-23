import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useClassroom } from "../stores/classroom";
import type { TeacherSnapshot } from "@classroom/shared";

export function makeSnapshot(overrides: Partial<TeacherSnapshot> = {}): TeacherSnapshot {
  return {
    ts: 1, classId: "3A", students: [], alerts: [],
    alertSummary: "其余 0 人正常", aggregates: [], suggestions: [],
    exerciseProgress: [], trend: [],
    stats: { online: 0, total: 0, needHelp: 0, runs: 0 },
    ...overrides,
  };
}

export function mountWithStore(component: any): {
  wrapper: VueWrapper;
  store: ReturnType<typeof useClassroom>;
} {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(component, { global: { plugins: [pinia] } });
  return { wrapper, store: useClassroom() };
}