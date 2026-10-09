import { describe, it, expect, vi, afterEach } from "vitest";
import StudentDrawer from "../components/StudentDrawer.vue";
import { makeSnapshot, mountWithStore } from "./helpers";
import type { StudentState, StatusColor } from "@classroom/shared";

const students: StudentState[] = [
  { studentId: "stu001", studentName: "张三", status: "red" as StatusColor, priorityScore: 70, lastActivityAt: 5 * 60_000, lastErrorAt: 5 * 60_000, errorCountTotal: 3, recentErrors: [] },
];

const detail = {
  studentId: "stu001", studentName: "张三",
  events: [
    { ts: 2000, eventType: "run", success: false, subtype: "缺少冒号", knowledge: "函数定义末尾要加冒号", rawMessage: 'SyntaxError: expected ":"' },
    { ts: 1000, eventType: "run", success: true, subtype: null, knowledge: null, rawMessage: "run success" },
  ],
  lastActivityAt: 2000, lastErrorAt: 2000,
};

describe("StudentDrawer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("打开抽屉拉取详情：姓名、错误历史（倒序，含成功事件）、停留时长", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => detail }));
    const { wrapper, store } = mountWithStore(StudentDrawer);
    store.applySnapshot(makeSnapshot({ students }));
    store.openDrawer("stu001");
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("张三");
    expect(wrapper.text()).toContain("缺少冒号");
    expect(wrapper.text()).toContain("运行成功"); // 成功事件 subtype 显示为「运行成功」
    expect(wrapper.text()).toContain("分钟前");
    // 关闭按钮
    await wrapper.find("button.close").trigger("click");
    expect(store.activeStudentId).toBeNull();
  });

  it("未打开时不渲染", () => {
    const { wrapper } = mountWithStore(StudentDrawer);
    expect(wrapper.find(".drawer").exists()).toBe(false);
  });
});