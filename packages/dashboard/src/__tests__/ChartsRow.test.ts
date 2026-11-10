import { describe, it, expect, vi } from "vitest";
import ChartsRow from "../components/ChartsRow.vue";
import { makeSnapshot, mountWithStore } from "./helpers";
import type { AggItem, ExerciseProgressItem, StudentState, StatusColor } from "@classroom/shared";

/** jsdom 无原生 canvas，chart.js 初始化会抛错；测试只断言 DOM，mock 掉 chart.js */
vi.mock("chart.js", () => {
  class MockChart {
    static register = vi.fn();
    static defaults: Record<string, unknown> = {};
    /** 对齐真实 chart.js：实例持有构造时传入的 canvas（供组件失绑校验 chart.canvas === ref.value） */
    canvas = {} as HTMLCanvasElement;
    data = { labels: [] as string[], datasets: [{ data: [] as number[] }] };
    options: Record<string, unknown> = {};
    update = vi.fn();
    destroy = vi.fn();
    /** 对齐真实 chart.js：实例 data 取自构造参数（否则组件写 datasets[1]/[2] 会踩空） */
    constructor(_el: unknown, config?: { data?: { labels: string[]; datasets: { data: number[] }[] } }) {
      if (_el) this.canvas = _el as HTMLCanvasElement;
      if (config?.data) this.data = config.data;
    }
  }
  const stub = class {};
  return {
    Chart: MockChart,
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
  { id: "week1/hello.py", displayName: "hello.py", isProject: false, passed: 2, stuck: 1, unreviewed: 1, total: 4, passRate: 0.5, firstTs: 100, latestTs: 400, title: "输出问候语" },
  { id: "week2/done.py", displayName: "done.py", isProject: false, passed: 4, stuck: 0, unreviewed: 0, total: 4, passRate: 1, firstTs: 200, latestTs: 300, title: "成绩判断" },
];

describe("ChartsRow（底部图表行，spec 2026-11-04 §5）", () => {
  it("三卡标题渲染（课堂节奏在第一张，与主区矩阵列对齐）", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({ students, aggregates, exerciseProgress, trend: [{ tStart: 1, runs: 2, errors: 1 }] }));
    await wrapper.vm.$nextTick();
    const titles = wrapper.findAll("h2").map((h) => h.text());
    expect(titles).toEqual(["课堂节奏", "作业完成度", "错误类型TOP3"]);
  });

  it("完成度卡单题水桶模式（无预选）：锁定最新进行中题，显示文件名+已完成/待完成人数+完成率", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({ students, aggregates, exerciseProgress, trend: [{ tStart: 1, runs: 2, errors: 1 }] }));
    await wrapper.vm.$nextTick();
    const text = wrapper.find(".completion").text();
    expect(text).toContain("hello.py");            // 无预选 → 原下拉位置显示当前焦点文件名（用户 2026-11-10）
    expect(text).not.toContain("输出问候语");       // 题面名不再展示
    expect(text).toContain("已通过 2 人");
    expect(text).toContain("编码中 2 人");
    expect(text).toContain("50%");
    expect(text).not.toContain("报错中");
    expect(text).not.toContain("done.py");
  });

  it("全部作业已全员通过：显示完成文案", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({
      exerciseProgress: [{ id: "week2/done.py", displayName: "done.py", isProject: false, passed: 4, stuck: 0, unreviewed: 0, total: 4, passRate: 1, firstTs: 200, latestTs: 300, title: "成绩判断" }],
    }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".completion").text()).toContain("全员通过，干得漂亮");
  });

  it("有数据时渲染两块 canvas（课堂节奏/错误TOP3；完成度为 DOM 水桶；chart.js 已 mock）；无数据卡片显示空态文案", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({ students, aggregates, exerciseProgress, trend: [{ tStart: 1, runs: 2, errors: 1 }] }));
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("canvas")).toHaveLength(2);
    const empty = mountWithStore(ChartsRow);
    empty.store.applySnapshot(makeSnapshot());
    await empty.wrapper.vm.$nextTick();
    expect(empty.wrapper.text()).toContain("暂无题目数据");
    expect(empty.wrapper.text()).toContain("暂无错误数据");
    expect(empty.wrapper.text()).toContain("暂无运行数据");
  });

  it("空态→有数据→空态→再有数据往返：图表实例随 canvas 重建不失绑", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    const snapWithData = () => makeSnapshot({
      students,
      aggregates,
      exerciseProgress,
      trend: [{ tStart: 1, runs: 2, errors: 1 }],
    });
    store.applySnapshot(snapWithData());
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("canvas")).toHaveLength(2);
    store.applySnapshot(makeSnapshot());               // → 空态（canvas 卸载）
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("canvas")).toHaveLength(0);
    store.applySnapshot(snapWithData());               // → 再有数据（canvas 重建）
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("canvas")).toHaveLength(2); // 修复前：此断言失败（旧实例跳过 init）
  });
});
