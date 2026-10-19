import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("../api/admin", () => ({
  adminApi: {
    roster: vi.fn(async () => []),
    addRosterEntry: vi.fn(async () => ({ ok: true })),
    renameRosterEntry: vi.fn(async () => ({ ok: true, studentId: "0001", studentName: "张三丰" })),
    removeRosterEntry: vi.fn(async () => ({ ok: true })),
    purgeRosterEntry: vi.fn(async () => ({ ok: true })),
  },
}));

import RosterPanel from "../components/RosterPanel.vue";
import Toast from "../components/Toast.vue";
import { adminApi } from "../api/admin";

const roster = [
  { studentId: "0001", studentName: "张三" },
  { studentId: "0002", studentName: "李四" },
];

/** Toast 为模块级单例，跨用例累积；断言只做正向 contains，避免相互干扰 */
function mountPanel() {
  return mount(RosterPanel, { props: { roster } });
}

beforeEach(() => vi.clearAllMocks());

describe("RosterPanel 行内优先交互", () => {
  it("批量添加/整表替换入口已移除", () => {
    const w = mountPanel();
    expect(w.find("textarea.batch-text").exists()).toBe(false);
    expect(w.find("button.add-batch").exists()).toBe(false);
    expect(w.find("textarea.replace-text").exists()).toBe(false);
    expect(w.find("button.replace-roster").exists()).toBe(false);
  });

  it("行内改名：点姓名 → 输入 → 保存 → renameRosterEntry(id, 新名) + refreshed", async () => {
    const w = mountPanel();
    await w.findAll(".name-text")[0].trigger("click");
    await w.find("input.edit-name").setValue("张三丰");
    await w.find("button.save-edit").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.renameRosterEntry).toHaveBeenCalledWith("0001", "张三丰");
    expect(w.emitted("refreshed")).toBeTruthy();
  });

  it("添加行：填学号姓名 → + 添加学生 → addRosterEntry + 输入清空 + refreshed + 焦点回学号框", async () => {
    const w = mountPanel();
    const focusSpy = vi.spyOn(w.find("input.add-id").element as HTMLInputElement, "focus");
    await w.find("input.add-id").setValue("0003");
    await w.find("input.add-name").setValue("王五");
    await w.find("button.add-entry").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.addRosterEntry).toHaveBeenCalledWith("0003", "王五");
    expect((w.find("input.add-id").element as HTMLInputElement).value).toBe("");
    expect(w.emitted("refreshed")).toBeTruthy();
    expect(focusSpy).toHaveBeenCalled();
  });

  it("保存前提：学号姓名任一为空 → toast 提示，不发请求", async () => {
    const w = mountPanel();
    const tw = mount(Toast);
    await w.find("input.add-name").setValue("王五");   // 学号留空
    await w.find("button.add-entry").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.addRosterEntry).not.toHaveBeenCalled();
    expect(tw.text()).toContain("请填写学号和姓名");
  });

  it("学号框 Enter → 焦点跳姓名框（不触发保存）", async () => {
    const w = mountPanel();
    const focusSpy = vi.spyOn(w.find("input.add-name").element as HTMLInputElement, "focus");
    await w.find("input.add-id").setValue("0003");
    await w.find("input.add-id").trigger("keyup", { key: "Enter" });
    expect(focusSpy).toHaveBeenCalled();
    expect(adminApi.addRosterEntry).not.toHaveBeenCalled();
  });

  it("移出（软删除）：一键执行无确认弹窗", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const w = mountPanel();
    await w.findAll("button.remove-entry")[0].trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.removeRosterEntry).toHaveBeenCalledWith("0001");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(w.emitted("refreshed")).toBeTruthy();
  });

  it("彻底清除：自定义确认框（非原生 confirm）→ 确认才执行 purge", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const w = mountPanel();
    await w.findAll("button.purge-entry")[1].trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(w.find(".dialog").exists()).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();          // 不再使用原生 confirm
    expect(adminApi.purgeRosterEntry).not.toHaveBeenCalled();
    expect(w.text()).toContain("student-0002");          // 文案明确后果
    await w.find("button.dialog-confirm").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.purgeRosterEntry).toHaveBeenCalledWith("0002");
    expect(w.find(".dialog").exists()).toBe(false);
    expect(w.emitted("refreshed")).toBeTruthy();
  });

  it("彻底清除：点取消 → 关闭确认框且不调用 purge", async () => {
    const w = mountPanel();
    await w.findAll("button.purge-entry")[0].trigger("click");
    await w.find("button.dialog-cancel").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.purgeRosterEntry).not.toHaveBeenCalled();
    expect(w.find(".dialog").exists()).toBe(false);
  });

  describe("批量移除（勾选模式，软移出）", () => {
    it("进入勾选模式：行复选框出现、行操作隐藏、未勾选时对钩禁用；✕ 退出不发起请求", async () => {
      const w = mountPanel();
      expect(w.find("input.check-one").exists()).toBe(false);
      await w.find("button.batch-remove").trigger("click");
      expect(w.findAll("input.check-one").length).toBe(2);
      expect(w.find("button.remove-entry").exists()).toBe(false);   // 勾选模式隐藏行操作
      expect(w.find("button.purge-entry").exists()).toBe(false);
      expect((w.find("button.batch-remove-confirm").element as HTMLButtonElement).disabled).toBe(true);
      await w.findAll("input.check-one")[0].trigger("change");
      expect(w.find("button.batch-remove-confirm").text()).toContain("(1)");
      await w.find("button.batch-remove-exit").trigger("click");
      expect(w.find("input.check-one").exists()).toBe(false);
      await new Promise((r) => setTimeout(r, 0));
      expect(adminApi.removeRosterEntry).not.toHaveBeenCalled();
    });

    it("全选框：全选 → (2)；取消一个 → 半选态 → 再点全选框补齐", async () => {
      const w = mountPanel();
      await w.find("button.batch-remove").trigger("click");
      await w.find("input.check-all").trigger("change");
      expect(w.find("button.batch-remove-confirm").text()).toContain("(2)");
      await w.findAll("input.check-one")[0].trigger("change");
      expect(w.find("button.batch-remove-confirm").text()).toContain("(1)");
      expect((w.find("input.check-all").element as HTMLInputElement).indeterminate).toBe(true);
      await w.find("input.check-all").trigger("change");
      expect(w.find("button.batch-remove-confirm").text()).toContain("(2)");
    });

    it("确认移除：逐条软移出 + refreshed + 退出勾选模式 + toast 汇总", async () => {
      const tw = mount(Toast);
      const w = mountPanel();
      await w.find("button.batch-remove").trigger("click");
      await w.find("input.check-all").trigger("change");
      await w.find("button.batch-remove-confirm").trigger("click");
      await new Promise((r) => setTimeout(r, 0));
      expect(adminApi.removeRosterEntry).toHaveBeenCalledTimes(2);
      expect(adminApi.removeRosterEntry).toHaveBeenCalledWith("0001");
      expect(adminApi.removeRosterEntry).toHaveBeenCalledWith("0002");
      expect(w.emitted("refreshed")).toBeTruthy();
      expect(w.find("input.check-one").exists()).toBe(false);
      expect(tw.text()).toContain("已移出 2 人");
    });
  });
});
