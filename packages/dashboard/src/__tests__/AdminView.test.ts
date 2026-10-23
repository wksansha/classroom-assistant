import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("../api/admin", () => ({
  ADMIN_TOKEN_KEY: "pylearner.admin.token",
  adminApi: {
    verifySession: vi.fn(),
    roster: vi.fn(async () => [{ studentId: "0001", studentName: "张三" }]),
    addRosterEntry: vi.fn(async () => ({ ok: true })),
    renameRosterEntry: vi.fn(async () => ({ ok: true, studentId: "0001", studentName: "张三" })),
    removeRosterEntry: vi.fn(async () => ({ ok: true })),
    purgeRosterEntry: vi.fn(async () => ({ ok: true })),
  },
}));

import AdminView from "../views/AdminView.vue";
import { adminApi, ADMIN_TOKEN_KEY } from "../api/admin";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(adminApi.verifySession).mockReset();
  vi.mocked(adminApi.roster).mockClear();
  // 缺省：服务端未启用管理鉴权 → 直进面板（既有花名册用例的前提）
  vi.mocked(adminApi.verifySession).mockResolvedValue({ adminProtected: false });
});

describe("AdminView（#/admin，作业域退役后仅花名册面板）", () => {
  it("挂载加载花名册并渲染表格", async () => {
    const w = mount(AdminView);
    await flush();
    expect(adminApi.roster).toHaveBeenCalled();
    expect(w.text()).toContain("0001");
    expect(w.text()).toContain("张三");
  });
  it("无常驻导入文本框残留（行内交互取代两段式导入，spec roster §4）", async () => {
    const w = mount(AdminView);
    await flush();
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

describe("管理登录门（ADMIN_PASSWORD 保护时，spec 2026-10-23）", () => {
  it("受保护且无令牌 → 登录框，不加载花名册", async () => {
    vi.mocked(adminApi.verifySession).mockResolvedValue({ adminProtected: true });
    const w = mount(AdminView);
    await flush();
    expect(w.find("input[type='password']").exists()).toBe(true);
    expect(adminApi.roster).not.toHaveBeenCalled();
  });

  it("已持有令牌 → 直接进面板并加载花名册", async () => {
    localStorage.setItem(ADMIN_TOKEN_KEY, "s3cret");
    vi.mocked(adminApi.verifySession).mockResolvedValue({ adminProtected: true, ok: true });
    const w = mount(AdminView);
    await flush();
    expect(w.find("input[type='password']").exists()).toBe(false);
    expect(adminApi.roster).toHaveBeenCalled();
  });

  it("密码错误 → 提示密码不正确，令牌被清除留在登录框", async () => {
    vi.mocked(adminApi.verifySession)
      .mockResolvedValueOnce({ adminProtected: true })   // checkSession
      .mockRejectedValueOnce(new Error("401"));          // login 提交
    const w = mount(AdminView);
    await flush();
    await w.find("input[type='password']").setValue("bad");
    await w.find("form.login-card").trigger("submit");
    await flush();
    expect(w.text()).toContain("密码不正确");
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull();
    expect(adminApi.roster).not.toHaveBeenCalled();
  });

  it("密码正确 → 进入面板并加载花名册", async () => {
    vi.mocked(adminApi.verifySession)
      .mockResolvedValueOnce({ adminProtected: true })   // checkSession
      .mockResolvedValueOnce({ adminProtected: true, ok: true }); // login 提交
    const w = mount(AdminView);
    await flush();
    await w.find("input[type='password']").setValue("s3cret");
    await w.find("form.login-card").trigger("submit");
    await flush();
    expect(w.find("input[type='password']").exists()).toBe(false);
    expect(adminApi.roster).toHaveBeenCalled();
  });
});
