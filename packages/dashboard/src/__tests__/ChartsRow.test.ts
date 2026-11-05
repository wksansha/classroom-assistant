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
  it("四卡标题渲染（完成度在第一张）", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({ students, aggregates, exerciseProgress, trend: [{ tStart: 1, runs: 2, errors: 1 }] }));
    await wrapper.vm.$nextTick();
    const titles = wrapper.findAll("h2").map((h) => h.text());
    expect(titles).toEqual(["作业完成度", "错误类型TOP3", "课堂节奏"]);
  });

  it("完成度卡单题水桶模式：锁定最新进行中题，题面名+已完成/待完成人数+完成率", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({ students, aggregates, exerciseProgress, trend: [{ tStart: 1, runs: 2, errors: 1 }] }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("输出问候语");              // 焦点题题面名（最新进行中题）
    expect(wrapper.text()).toContain("已通过 2 人");             // 焦点题已通过
    expect(wrapper.text()).toContain("编码中 2 人");             // 其余学员（含报错中/未提交，总 4 - 通过 2）
    expect(wrapper.text()).toContain("50%");                    // 焦点题完成率 2/4
    expect(wrapper.text()).not.toContain("报错中");              // 完成度卡不再细分报错（由全班状态/错误TOP3表达）
    expect(wrapper.text()).not.toContain("未提交");
    expect(wrapper.text()).not.toContain("全班通过率");          // 单题口径，不再展示跨题汇总
    expect(wrapper.text()).not.toContain("done.py");            // 已通关题折叠不显示
  });

  it("切题规则：锁定最新涌现（firstTs 最大）的进行中题——旧题再报错也不抢桶", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({
      students, aggregates,
      exerciseProgress: [
        { id: "old.py", displayName: "old.py", isProject: false, passed: 1, stuck: 1, unreviewed: 0, total: 4, passRate: 0.25, firstTs: 100, latestTs: 999, title: "旧题" },
        { id: "new.py", displayName: "new.py", isProject: false, passed: 0, stuck: 2, unreviewed: 0, total: 4, passRate: 0, firstTs: 200, latestTs: 300, title: "新题" },
      ],
      trend: [{ tStart: 1, runs: 2, errors: 1 }],
    }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("新题");     // firstTs 200 > 100 → 新题为焦点
    expect(wrapper.text()).not.toContain("旧题"); // 旧题 latestTs 更高也不切换
  });

  it("全部作业已全员通过：显示完成文案", async () => {
    const { wrapper, store } = mountWithStore(ChartsRow);
    store.applySnapshot(makeSnapshot({
      students, aggregates,
      exerciseProgress: [{ id: "a.py", displayName: "a.py", isProject: false, passed: 4, stuck: 0, unreviewed: 0, total: 4, passRate: 1, firstTs: 100, latestTs: 200, title: "a.py" }],
      trend: [{ tStart: 1, runs: 2, errors: 1 }],
    }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("全员通过，干得漂亮");
  });

  it("有数据时渲染两块 canvas（完成度卡为 DOM 进度条；chart.js 已 mock）；无数据卡片显示空态文案", async () => {
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
