import { describe, it, expect, vi, afterEach } from "vitest";
import App from "../App.vue";
import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";

class FakeES {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe("App", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("挂载：标题渲染、四组件 + 抽屉就位", async () => {
    const emptySnapshot = {
      ts: 1, classId: "3A", students: [], alerts: [],
      alertSummary: "其余 0 人正常", aggregates: [], suggestions: [],
    };
    vi.stubGlobal("EventSource", vi.fn().mockImplementation(() => new FakeES()));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => emptySnapshot }));
    const wrapper = mount(App, { global: { plugins: [createPinia()] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(wrapper.text()).toContain("课堂教学实时助教");
    expect(wrapper.text()).toContain("优先帮助");
    expect(wrapper.text()).toContain("全班状态");
    expect(wrapper.text()).toContain("错误聚合");
    expect(wrapper.text()).toContain("等待学生上报");
  });
});