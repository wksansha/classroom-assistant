import { describe, it, expect } from "vitest";
import ErrorAggPanel from "../components/ErrorAggPanel.vue";
import { makeSnapshot, mountWithStore } from "./helpers";

const aggregates = [
  { subtype: "缺少冒号", category: "语法错误", knowledge: "函数定义末尾要加冒号", count: 8, students: [{ studentId: "stu001", studentName: "张三" }, { studentId: "stu002", studentName: "李四" }] },
  { subtype: "意外缩进", category: "运算错误", knowledge: "缩进规则：Python 靠缩进划分代码块", count: 5, students: [{ studentId: "stu003", studentName: "王五" }] },
];

describe("ErrorAggPanel", () => {
  it("按 subtype 渲染分组：人数 + knowledge 文案", async () => {
    const { wrapper, store } = mountWithStore(ErrorAggPanel);
    store.applySnapshot(makeSnapshot({ aggregates }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("缺少冒号");
    expect(wrapper.text()).toContain("8 人");
    expect(wrapper.text()).toContain("函数定义末尾要加冒号");
    expect(wrapper.text()).toContain("意外缩进");
  });

  it("点击组行展开学生名单，再点收起", async () => {
    const { wrapper, store } = mountWithStore(ErrorAggPanel);
    store.applySnapshot(makeSnapshot({ aggregates }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".names").exists()).toBe(false);
    await wrapper.findAll(".bar-row")[0].trigger("click");
    expect(wrapper.find(".names").text()).toContain("张三");
    await wrapper.findAll(".bar-row")[0].trigger("click");
    expect(wrapper.find(".names").exists()).toBe(false);
  });

  it("空数据占位", async () => {
    const { wrapper, store } = mountWithStore(ErrorAggPanel);
    store.applySnapshot(makeSnapshot());
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("暂无聚合数据");
  });
});