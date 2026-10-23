import { describe, it, expect, vi, afterEach } from "vitest";
import StatusBar from "../components/StatusBar.vue";
import { makeSnapshot, mountWithStore } from "./helpers";

describe("StatusBar（顶栏，spec dashboard-v2 §3①）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("统计大数字渲染（在线/急需帮助/运行次数，决策 #18 无已通过评审）", async () => {
    const { wrapper, store } = mountWithStore(StatusBar);
    store.applySnapshot(makeSnapshot({
      stats: { online: 8, total: 10, needHelp: 2, runs: 42 },
    }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("课堂教学实时助教");
    expect(wrapper.text()).toContain("42");
    expect(wrapper.text()).toContain("2");
    expect(wrapper.text()).not.toContain("已通过评审");
    wrapper.unmount();   // 清理时钟 interval，避免泄漏到环境拆除
  });

  it("日期 + 时钟显示", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 23, 14, 30, 45));
    const { wrapper } = mountWithStore(StatusBar);
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("月");   // toLocaleDateString("zh-CN") 含「月」
    expect(wrapper.text()).toContain(":");    // 时钟 HH:MM:SS
    wrapper.unmount();
  });
});
