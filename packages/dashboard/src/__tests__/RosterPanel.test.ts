import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("../api/admin", () => ({
  adminApi: {
    roster: vi.fn(async () => []),
    addRosterEntry: vi.fn(async () => ({ ok: true })),
    renameRosterEntry: vi.fn(async () => ({ ok: true, studentId: "0001", studentName: "张三丰" })),
    removeRosterEntry: vi.fn(async () => ({ ok: true })),
    purgeRosterEntry: vi.fn(async () => ({ ok: true })),
    replaceRoster: vi.fn(async () => ({ ok: true, count: 2 })),
  },
}));

import RosterPanel from "../components/RosterPanel.vue";
import { adminApi } from "../api/admin";

const roster = [
  { studentId: "0001", studentName: "张三" },
  { studentId: "0002", studentName: "李四" },
];

beforeEach(() => vi.clearAllMocks());

describe("RosterPanel 行内优先交互（spec roster §4）", () => {
  it("无常驻导入文本框（旧两段式导入已移除）", () => {
    const w = mount(RosterPanel, { props: { roster } });
    expect(w.find("button.import-roster").exists()).toBe(false);
    expect(w.find("textarea.import-text").exists()).toBe(false);
  });
  it("行内改名：点姓名 → 输入 → 保存 → renameRosterEntry(id, 新名) + refreshed", async () => {
    const w = mount(RosterPanel, { props: { roster } });
    await w.findAll(".name-text")[0].trigger("click");
    await w.find("input.edit-name").setValue("张三丰");
    await w.find("button.save-edit").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.renameRosterEntry).toHaveBeenCalledWith("0001", "张三丰");
    expect(w.emitted("refreshed")).toBeTruthy();
  });
  it("添加行：填学号姓名 → + 添加学生 → addRosterEntry + 输入清空 + refreshed", async () => {
    const w = mount(RosterPanel, { props: { roster } });
    await w.find("input.add-id").setValue("0003");
    await w.find("input.add-name").setValue("王五");
    await w.find("button.add-entry").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.addRosterEntry).toHaveBeenCalledWith("0003", "王五");
    expect((w.find("input.add-id").element as HTMLInputElement).value).toBe("");
    expect(w.emitted("refreshed")).toBeTruthy();
  });
  it("批量添加：两行文本 → 拆行逐条 POST entry → refreshed；失败行留在批量区", async () => {
    (adminApi.addRosterEntry as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id === "0002") throw new Error("409");
      return { ok: true };
    });
    const w = mount(RosterPanel, { props: { roster } });
    await w.find("textarea.batch-text").setValue("0003 王五\n0002 张三丰\n坏行");
    await w.find("button.add-batch").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.addRosterEntry).toHaveBeenCalledTimes(2);   // 坏行不发请求
    expect(adminApi.addRosterEntry).toHaveBeenCalledWith("0003", "王五");
    expect(adminApi.addRosterEntry).toHaveBeenCalledWith("0002", "张三丰");
    expect((w.find("textarea.batch-text").element as HTMLTextAreaElement).value).toBe("0002 张三丰\n坏行");
    expect(w.text()).toContain("成功 1 条");
    expect(w.emitted("refreshed")).toBeTruthy();
  });
  it("移出（软删除）：一键执行无确认弹窗", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const w = mount(RosterPanel, { props: { roster } });
    await w.findAll("button.remove-entry")[0].trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.removeRosterEntry).toHaveBeenCalledWith("0001");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(w.emitted("refreshed")).toBeTruthy();
  });
  it("彻底清除：confirm 确认 → purge；confirm 取消 → 不调用", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const w = mount(RosterPanel, { props: { roster } });
    await w.findAll("button.purge-entry")[1].trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(confirmSpy.mock.calls[0][0]).toContain("student-0002");   // 文案明确后果
    expect(adminApi.purgeRosterEntry).toHaveBeenCalledWith("0002");

    (adminApi.purgeRosterEntry as ReturnType<typeof vi.fn>).mockClear();
    confirmSpy.mockReturnValue(false);
    await w.findAll("button.purge-entry")[1].trigger("click");
    expect(adminApi.purgeRosterEntry).not.toHaveBeenCalled();
  });
  it("整表替换：粘贴新名单 → replaceRoster（走覆盖导入）→ refreshed", async () => {
    const w = mount(RosterPanel, { props: { roster } });
    await w.find("textarea.replace-text").setValue("1001 新一\n1002 新二");
    await w.find("button.replace-roster").trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminApi.replaceRoster).toHaveBeenCalledWith("1001 新一\n1002 新二");
    expect(w.emitted("refreshed")).toBeTruthy();
  });
});
