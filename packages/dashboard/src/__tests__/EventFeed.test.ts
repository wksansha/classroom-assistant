import { describe, it, expect, vi, afterEach } from "vitest";
import EventFeed from "../components/EventFeed.vue";
import { makeSnapshot, mountWithStore } from "./helpers";
import type { ActivityFeedItem } from "@classroom/shared";

const feed = (over: Partial<ActivityFeedItem> & { id: string }): ActivityFeedItem => ({
  kind: "run_ok", studentId: "s1", studentName: "张三", ts: 1000,
  attempt: 1, reasonTag: null, reason: null, title: null, filePath: "l1/a.py",
  ...over,
});

describe("EventFeed（课堂动态，V4 行流）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("空 feed：占位文案 + AI在线评审徽章", async () => {
    const { wrapper, store } = mountWithStore(EventFeed);
    store.applySnapshot(makeSnapshot({ activityFeed: [], reviewOnline: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("等待学员动态…");
    expect(wrapper.text()).toContain("AI在线评审");
  });

  it("渲染四态条目：学生名/事件/第N次/时间/失败原因", async () => {
    const { wrapper, store } = mountWithStore(EventFeed);
    store.applySnapshot(makeSnapshot({
      activityFeed: [
        feed({ id: "f1", kind: "run_fail", attempt: 2, reasonTag: "ZeroDivisionError", reason: "division by zero" }),
        feed({ id: "f2", kind: "review_fail", studentId: "s2", studentName: "李四", attempt: 3, reasonTag: "评审意见", reason: "循环条件错误" }),
      ],
    }));
    await wrapper.vm.$nextTick();
    const text = wrapper.text();
    expect(text).toContain("张三");
    expect(text).toContain("运行失败");
    expect(text).toContain("第2次运行");
    expect(text).toContain("ZeroDivisionError");
    expect(text).toContain("李四");
    expect(text).toContain("AI 评审未通过");
    expect(text).toContain("第3次评审");
    expect(text).toContain("评审意见");
    // 心跳条：每行 1 格（各自首条）
    expect(wrapper.findAll(".hb i").length).toBe(2);
  });

  it("快照更新：新条目前置 + 打进入动画；重复 id 不重复渲染", async () => {
    vi.useFakeTimers();
    const { wrapper, store } = mountWithStore(EventFeed);
    store.applySnapshot(makeSnapshot({ activityFeed: [feed({ id: "f1", ts: 1000 })] }));
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll(".lb-row")).toHaveLength(1);

    store.applyUpdate(makeSnapshot({ activityFeed: [feed({ id: "f2", ts: 2000 }), feed({ id: "f1", ts: 1000 })] }));
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll(".lb-row")).toHaveLength(2);
    expect(wrapper.findAll(".lb-row")[0].text()).toContain("第1次运行");   // 新条目在前
    expect(wrapper.findAll(".lb-row.entering").length).toBeGreaterThan(0);   // 进入动画

    vi.advanceTimersByTime(1700);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll(".lb-row.entering")).toHaveLength(0);   // 动画类已摘除
    vi.useRealTimers();
  });

  it("reviewOnline=false：降级徽章", async () => {
    const { wrapper, store } = mountWithStore(EventFeed);
    store.applySnapshot(makeSnapshot({ reviewOnline: false }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("AI降级 · 仅显示运行");
  });
});
