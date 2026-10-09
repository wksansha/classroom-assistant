import { describe, it, expect } from "vitest";
import AlertPanel from "../components/AlertPanel.vue";
import { makeSnapshot, mountWithStore } from "./helpers";

const alerts = [
  { studentId: "stu001", studentName: "张三", score: 70, reason: "同一错误 5 分钟内 3 次", subtype: "缺少冒号", knowledge: "函数定义末尾要加冒号", lastErrorAt: 1 },
  { studentId: "stu002", studentName: "李四", score: 35, reason: "连续报错 5 次", subtype: "未定义变量", knowledge: "变量要先赋值再使用", lastErrorAt: 1 },
];

describe("AlertPanel", () => {
  it("渲染告警（序号/姓名/reason/subtype）与 alertSummary，不显示分数", async () => {
    const { wrapper, store } = mountWithStore(AlertPanel);
    store.applySnapshot(makeSnapshot({ alerts, alertSummary: "其余 3 人正常" }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("张三");
    const seqs = wrapper.findAll(".seq").map((n) => n.text());
    expect(seqs).toEqual(["1", "2"]); // 按排序显示序号 1、2…
    expect(wrapper.text()).not.toContain("70"); // 不再显示原始分数
    expect(wrapper.text()).toContain("同一错误 5 分钟内 3 次");
    expect(wrapper.text()).toContain("缺少冒号");
    expect(wrapper.text()).toContain("其余 3 人正常");
  });

  it("[查看] 打开抽屉；[发提示] 禁用（V2）", async () => {
    const { wrapper, store } = mountWithStore(AlertPanel);
    store.applySnapshot(makeSnapshot({ alerts }));
    await wrapper.vm.$nextTick();
    const buttons = wrapper.findAll("button");
    await buttons[0].trigger("click"); // 第一个按钮是 [查看]
    expect(store.activeStudentId).toBe("stu001");
    const disabled = buttons.filter((b) => (b.element as HTMLButtonElement).disabled);
    expect(disabled.length).toBeGreaterThanOrEqual(1);
  });
});