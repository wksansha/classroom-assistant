import { describe, it, expect, vi } from "vitest";
import ChartsRow from "../components/ChartsRow.vue";
import { makeSnapshot, mountWithStore } from "./helpers";
import type { AggItem, ExerciseProgressItem, StudentState, StatusColor } from "@classroom/shared";

/** jsdom 无原生 canvas，chart.js 初始化会抛错；测试只断言 DOM，mock 掉 chart.js */
vi.mock("chart.js", () => {
  class MockChart {
    static register = vi.fn();
    static defaults: Record<string, unknown> = {};
    data = { labels: [] as string[], datasets: [{ data: [] as number[] }] };
    options: Record<string, unknown> = {};
    update = vi.fn();
    destroy = vi.fn();
    /** 对齐真实 chart.js：实例 data 取自构造参数（否则组件写 datasets[1]/[2] 会踩空） */
    constructor(_el: unknown, config?: { data?: { labels: string[]; datasets: { data: number[] }[] } }) {
      if (config?.data) this.data = config.data;
    }
  }
  const stub = class {};
  return {
    Chart: MockChart,
    DoughnutController: stub, ArcElement: stub,
    BarController: stub, BarElement: stub,
    LineController: stub, LineElement: stub, PointElement: stub, Filler: stub,
    CategoryScale: stub, LinearScale: stub,
    Tooltip: stub, Legend: stub,
  };
});

const students: StudentState[] = [
  { studentId: "s1", studentName: "张三", status: "red" as StatusColor, online: true, machineCount: 1, priorityScore: 70, lastActivityAt: 1, lastErrorAt: 1, errorCountTotal: 1, recentErrors: [] },
  { studentId: "s2", studentName: "李四", status: "yellow" as StatusColor, online: true, machineCount: 1, priorityScore: 15, lastActivityAt: 1, lastErrorAt: 1, errorCountTotal: 1, recentErrors: [] },
  { studentId: "s3", studentName: "王五", status: "green" as StatusColor, online: true, machineCount: 1, priorityScore: 0, lastActivityAt: 1, lastErrorAt: null, errorCountTotal: 0, recentErrors: [] },
  { studentId: "s4", studentName: "赵六", status: "green" as StatusColor, online: false, machineCount: 0, priorityScore: 0, lastActivityAt: null, lastErrorAt: null, errorCountTotal: 0, recentErrors: [] },
];
const aggregates: AggItem[] = [
  { subtype: "缺少冒号", category: "语法错误", knowledge: "k", count: 8, students: [] },
];
const exerciseProgress: ExerciseProgressItem[] = [
  { id: "week1/hello.py", displayName: "hello.py", isProject: false, passed: 2, stuck: 1, unreviewed: 1, total: 4, passRate: 0.5 },
  { id: "week2/done.py", displayName: "done.py", isProject: false, passed: 4, stuck: 0, unreviewed: 0, total: 4, passRate: 1 },
];

describe("ChartsRow（底部图表行，spec 2026-11-04 §5）", () => {
  it("四卡标题渲染（完成度在第一张）", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({ students, aggregates, exerciseProgress, trend: [{ tStart: 1, runs: 2, errors: 1 }] }));
    await wrapper.vm.$nextTick();
    const titles = wrapper.findAll("h2").map((h) => h.text());
    expect(titles).toEqual(["作业完成度", "错误类型分布", "全班状态占比", "课堂节奏"]);
  });

  it("完成度卡关注集（spec 决策 #5/#16）：未全员通过的题入柱 + 通过率头部大数字；已全员通过折叠摘要", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({ students, aggregates, exerciseProgress, trend: [{ tStart: 1, runs: 2, errors: 1 }] }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("全班通过率");
    expect(wrapper.text()).toContain("50%");                    // 关注集仅 hello.py：2/4
    expect(wrapper.text()).toContain("另有 1 题已全部通过");      // done.py 折叠
    expect(wrapper.text()).toContain("hello.py");               // DOM 暴露关注集题名（canvas fallback，现代浏览器不渲染、jsdom textContent 可见）
  });

  it("全部作业已全员通过：显示完成文案", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({
      students, aggregates,
      exerciseProgress: [{ id: "a.py", displayName: "a.py", isProject: false, passed: 4, stuck: 0, unreviewed: 0, total: 4, passRate: 1 }],
      trend: [{ tStart: 1, runs: 2, errors: 1 }],
    }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("全部作业已完成");
  });

  it("有数据时渲染四块 canvas（chart.js 已 mock）；无数据卡片显示空态文案", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({ students, aggregates, exerciseProgress, trend: [{ tStart: 1, runs: 2, errors: 1 }] }));
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("canvas")).toHaveLength(4);
    const empty = mountWithStore(ChartsRow);
    empty.store.applySnapshot(makeSnapshot());
    await empty.wrapper.vm.$nextTick();
    expect(empty.wrapper.text()).toContain("暂无题目数据");
    expect(empty.wrapper.text()).toContain("暂无错误数据");
    expect(empty.wrapper.text()).toContain("暂无学生数据");
    expect(empty.wrapper.text()).toContain("暂无运行数据");
  });
});
