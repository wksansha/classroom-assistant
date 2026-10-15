import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("../api/admin", () => ({
  adminApi: {
    roster: vi.fn(async () => [{ studentId: "0001", studentName: "张三" }]),
    importRoster: vi.fn(async () => ({ ok: true, count: 2 })),
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
  it("名册面板导入调用 importRoster 并刷新", async () => {
    const w = mount(AdminView);
    await new Promise((r) => setTimeout(r, 0));
    (adminApi.roster as ReturnType<typeof vi.fn>).mockClear();
    await w.find("textarea").setValue("0001 张三\n0002 李四");
    await w.find("button.import-roster").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.importRoster).toHaveBeenCalledWith("0001 张三\n0002 李四");
    expect(w.text()).toContain("已导入 2 人");
    expect(adminApi.roster).toHaveBeenCalled();   // refreshed → 重载
  });
  it("作业列表与立即同步已退役：无相关 UI 残留", () => {
    const w = mount(AdminView);
    expect(w.find("button.sync").exists()).toBe(false);
    expect(w.find(".assignment-list").exists()).toBe(false);
    expect(w.text()).not.toContain("立即同步");
  });
});
