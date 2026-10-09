import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import type { Submission } from "@classroom/shared";

vi.mock("../api/assignments", () => ({
  assignmentsApi: {
    list: vi.fn(async () => [
      { id: "a1", title: "第 1 周作业", week: 1, isPublished: true, createdAt: 1, exercises: [
        { id: "e1", assignmentId: "a1", order: 1, filename: "exercise-01.py", problemStatement: "题", testCases: [], versionHash: "v", isActive: true, createdAt: 1 },
      ] },
      { id: "a2", title: "草稿作业", week: 2, isPublished: false, createdAt: 2, exercises: [] },
    ]),
    roster: vi.fn(async () => [{ studentId: "0001", studentName: "张三" }]),
    submissionsByExercise: vi.fn(async () => [
      { id: "s1", exerciseId: "e1", studentId: "0001", studentName: "张三", code: "print(1)", source: "auto", submittedAt: 1,
        review: { status: "pass", reason: "通过", reviewedAt: 1, model: "m", source: "llm" } } as Submission,
    ]),
    submissionsByStudent: vi.fn(async () => [
      { id: "s1", exerciseId: "e1", studentId: "0001", studentName: "张三", code: "print(1)", source: "auto", submittedAt: 1,
        review: { status: "pass", reason: "通过", reviewedAt: 1, model: "m", source: "llm" } } as Submission,
    ]),
  },
}));

import AssignmentsView from "../views/AssignmentsView.vue";

describe("AssignmentsView（投屏·纯展示，A23/A24）", () => {
  it("仅显示已发布作业；默认选中第一个并渲染矩阵", async () => {
    const w = mount(AssignmentsView, { global: { plugins: [createPinia()] } });
    await new Promise((r) => setTimeout(r, 0));   // 等 onMounted 的异步完成
    expect(w.text()).toContain("第 1 周作业");
    expect(w.text()).not.toContain("草稿作业");    // 草稿不上投屏（A23）
    expect(w.text()).toContain("exercise-01.py");
    expect(w.text()).toContain("0001");
  });
  it("点击格子 → 抽屉显示该生该练习代码与评审", async () => {
    const w = mount(AssignmentsView, { global: { plugins: [createPinia()] } });
    await new Promise((r) => setTimeout(r, 0));
    await w.find("td.cell").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(w.text()).toContain("print(1)");
    expect(w.text()).toContain("student-0001");
  });
});
