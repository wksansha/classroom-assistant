import { describe, it, expect } from "vitest";
import StudentMatrix from "../components/StudentMatrix.vue";
import { makeSnapshot, mountWithStore } from "./helpers";
import type { StudentState, StatusColor } from "@classroom/shared";

const students: StudentState[] = [
  { studentId: "stu001", studentName: "张三", status: "red" as StatusColor, online: true, machineCount: 2, priorityScore: 70, lastActivityAt: 1, lastErrorAt: 1, errorCountTotal: 3, recentErrors: [{ ts: 1, subtype: "缺少冒号", knowledge: "k", rawMessage: "m" }] },
  { studentId: "stu002", studentName: "李四", status: "yellow" as StatusColor, online: true, machineCount: 1, priorityScore: 15, lastActivityAt: 1, lastErrorAt: 1, errorCountTotal: 1, recentErrors: [] },
  { studentId: "stu003", studentName: "王五", status: "green" as StatusColor, online: true, machineCount: 1, priorityScore: 0, lastActivityAt: 1, lastErrorAt: null, errorCountTotal: 0, recentErrors: [] },
  { studentId: "stu004", studentName: "赵六", status: "green" as StatusColor, online: false, machineCount: 0, priorityScore: 0, lastActivityAt: null, lastErrorAt: null, errorCountTotal: 0, recentErrors: [] },
];

describe("StudentMatrix", () => {
  it("渲染全部学生格子与状态色 class；悬停 title 含最近错误", async () => {
    const { wrapper, store } = mountWithStore(StudentMatrix);
    store.applySnapshot(makeSnapshot({ students }));
    await wrapper.vm.$nextTick();
    const tiles = wrapper.findAll(".tile");
    expect(tiles).toHaveLength(4);
    expect(tiles[0].classes()).toContain("red");
    expect(tiles[1].classes()).toContain("yellow");
    expect(tiles[2].classes()).toContain("green");
    expect(tiles[0].attributes("title")).toContain("缺少冒号");
    expect(wrapper.text()).toContain("张三");
  });

  it("未在线学生变暗标识（.offline，不占状态；图例含未在线计数，spec 决策 #19）", async () => {
    const { wrapper, store } = mountWithStore(StudentMatrix);
    store.applySnapshot(makeSnapshot({ students }));
    await wrapper.vm.$nextTick();
    const tiles = wrapper.findAll(".tile");
    expect(tiles[3].classes()).toContain("offline");
    expect(tiles[3].classes()).toContain("green");   // 状态不占，仍 green
    expect(wrapper.text()).toContain("未在线 1 人");
  });

  it("多机徽标：machineCount ≥ 2 显示 ×N，单机/未在线不显示（登录态在线模型）", async () => {
    const { wrapper, store } = mountWithStore(StudentMatrix);
    store.applySnapshot(makeSnapshot({ students }));
    await wrapper.vm.$nextTick();
    const tiles = wrapper.findAll(".tile");
    expect(tiles[0].find(".machine-badge").text()).toBe("×2");
    expect(tiles[1].find(".machine-badge").exists()).toBe(false);
    expect(tiles[2].find(".machine-badge").exists()).toBe(false);
    expect(tiles[3].find(".machine-badge").exists()).toBe(false);
  });

  it("点击格子打开抽屉", async () => {
    const { wrapper, store } = mountWithStore(StudentMatrix);
    store.applySnapshot(makeSnapshot({ students }));
    await wrapper.vm.$nextTick();
    await wrapper.findAll(".tile")[1].trigger("click");
    expect(store.activeStudentId).toBe("stu002");
  });

  it("空数据显示占位", async () => {
    const { wrapper, store } = mountWithStore(StudentMatrix);
    store.applySnapshot(makeSnapshot());
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("等待学生上报");
  });
});
