import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";

vi.mock("../api/assignments", () => ({
  assignmentsApi: {
    list: vi.fn(async () => [
      { id: "a1", title: "第 1 周作业", week: 1, isPublished: false, createdAt: 1, exercises: [
        { id: "e1", assignmentId: "a1", order: 1, filename: "exercise-01.py", problemStatement: "题", testCases: [], versionHash: "v", isActive: true, createdAt: 1 },
      ] },
    ]),
    roster: vi.fn(async () => [{ studentId: "0001", studentName: "张三" }]),
    submissionsByExercise: vi.fn(async () => []),
    submissionsByStudent: vi.fn(async () => []),
    importRoster: vi.fn(async () => ({ ok: true, count: 2 })),
    sync: vi.fn(async () => ({ importedNew: 3, updated: 0, injected: 3, deactivated: 0, warnings: ["week-01/x 已发布且有提交——评审基准已切换，请通知学生（A30）"] })),
    patch: vi.fn(async () => ({})),
    publish: vi.fn(async () => ({ ok: true })),
  },
}));

import AdminView from "../views/AdminView.vue";
import { assignmentsApi } from "../api/assignments";

describe("AdminView（#/admin，A23/A16/A18/A30）", () => {
  it("立即同步 → 显示导入结果与 A30 警示", async () => {
    const w = mount(AdminView, { global: { plugins: [createPinia()] } });
    await new Promise((r) => setTimeout(r, 0));
    await w.find("button.sync").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(w.text()).toContain("新增 3");
    expect(w.text()).toContain("注入 ID 3");
    expect(w.text()).toContain("评审基准已切换");            // A30 警示
  });
  it("发布按钮调用 publish；名册面板导入调用 importRoster", async () => {
    const w = mount(AdminView, { global: { plugins: [createPinia()] } });
    await new Promise((r) => setTimeout(r, 0));
    await w.find("button.publish").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(assignmentsApi.publish).toHaveBeenCalledWith("a1", true);
    await w.find("textarea").setValue("0001 张三\n0002 李四");
    await w.find("button.import-roster").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(assignmentsApi.importRoster).toHaveBeenCalledWith("0001 张三\n0002 李四");
    expect(w.text()).toContain("已导入 2 人");
  });
  it("作业行显示草稿状态与题数、截止时间编辑", async () => {
    const w = mount(AdminView, { global: { plugins: [createPinia()] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.text()).toContain("草稿");
    expect(w.text()).toContain("1 题");
    expect(w.find("input.due-at").exists()).toBe(true);
  });
});
