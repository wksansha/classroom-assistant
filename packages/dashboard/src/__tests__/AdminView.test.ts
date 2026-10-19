import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("../api/admin", () => ({
  adminApi: {
    roster: vi.fn(async () => [{ studentId: "0001", studentName: "张三" }]),
    addRosterEntry: vi.fn(async () => ({ ok: true })),
    renameRosterEntry: vi.fn(async () => ({ ok: true, studentId: "0001", studentName: "张三" })),
    removeRosterEntry: vi.fn(async () => ({ ok: true })),
    purgeRosterEntry: vi.fn(async () => ({ ok: true })),
  },
}));

import AdminView from "../views/AdminView.vue";
import { adminApi } from "../api/admin";

describe("AdminView（#/admin，作业域退役后仅花名册面板）", () => {
  it("挂载加载花名册并渲染表格", async () => {
    const w = mount(AdminView);
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.roster).toHaveBeenCalled();
    expect(w.text()).toContain("0001");
    expect(w.text()).toContain("张三");
  });
  it("无常驻导入文本框残留（行内交互取代两段式导入，spec roster §4）", () => {
    const w = mount(AdminView);
    expect(w.find("button.import-roster").exists()).toBe(false);
    expect(adminApi.roster).toHaveBeenCalled();
  });
  it("作业列表与立即同步已退役：无相关 UI 残留", () => {
    const w = mount(AdminView);
    expect(w.find("button.sync").exists()).toBe(false);
    expect(w.find(".assignment-list").exists()).toBe(false);
    expect(w.text()).not.toContain("立即同步");
  });
});
