import { describe, it, expect } from "vitest";
import StudentMatrix from "../components/StudentMatrix.vue";
import { makeSnapshot, mountWithStore } from "./helpers";

const students = [
  { studentId: "stu001", studentName: "张三", status: "red", priorityScore: 70, lastActivityAt: 1, lastErrorAt: 1, errorCountTotal: 3, recentErrors: [{ ts: 1, subtype: "缺少冒号", knowledge: "k", rawMessage: "m" }] },
  { studentId: "stu002", studentName: "李四", status: "yellow", priorityScore: 15, lastActivityAt: 1, lastErrorAt: 1, errorCountTotal: 1, recentErrors: [] },
  { studentId: "stu003", studentName: "王五", status: "green", priorityScore: 0, lastActivityAt: 1, lastErrorAt: null, errorCountTotal: 0, recentErrors: [] },
];

describe("StudentMatrix", () => {
  it("渲染全部学生格子与状态色 class；悬停 title 含最近错误", async () => {
    const { wrapper, store } = mountWithStore(StudentMatrix);
    store.applySnapshot(makeSnapshot({ students }));
    await wrapper.vm.$nextTick();
    const tiles = wrapper.findAll(".tile");
    expect(tiles).toHaveLength(3);
    expect(tiles[0].classes()).toContain("red");
    expect(tiles[1].classes()).toContain("yellow");
    expect(tiles[2].classes()).toContain("green");
    expect(tiles[0].attributes("title")).toContain("缺少冒号");
    expect(wrapper.text()).toContain("张三");
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