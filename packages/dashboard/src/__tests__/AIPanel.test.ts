import { describe, it, expect, vi, afterEach } from "vitest";
import AIPanel from "../components/AIPanel.vue";
import { makeSnapshot, mountWithStore } from "./helpers";
import type { SuggestionItem } from "@classroom/shared";

const suggestions: SuggestionItem[] = [
  { id: "class-review:缺少冒号", kind: "class-review", text: "⚠️ 8 人卡在「缺少冒号」，建议全班讲评", acked: false },
  { id: "individual:stu001", kind: "individual", text: "🙋 张三 连续报错，建议单独辅导", acked: false },
  { id: "group-discuss:意外缩进", kind: "group-discuss", text: "💡 2 人遇到「意外缩进」，可小组讨论", acked: true },
];

describe("AIPanel（教学建议卡，spec dashboard-v2 §3③）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("AI 标识 + 竖排建议卡；acked 不显示", async () => {
    const { wrapper, store } = mountWithStore(AIPanel);
    store.applySnapshot(makeSnapshot({ suggestions }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("AI");
    expect(wrapper.text()).toContain("全班讲评");
    expect(wrapper.text()).toContain("🙋 张三 连续报错，建议单独辅导");
    expect(wrapper.text()).not.toContain("小组讨论");   // acked=true 不渲染
  });

  it("点击标记已处理 → POST ack + 本地立即隐藏", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper, store } = mountWithStore(AIPanel);
    store.applySnapshot(makeSnapshot({ suggestions }));
    await wrapper.vm.$nextTick();
    await wrapper.findAll("button")[0].trigger("click");
    await wrapper.vm.$nextTick();
    expect(fetchMock).toHaveBeenCalledWith("/api/suggestions/ack", expect.objectContaining({ method: "POST" }));
    expect(wrapper.text()).not.toContain("全班讲评");
  });

  it("空建议占位", async () => {
    const { wrapper, store } = mountWithStore(AIPanel);
    store.applySnapshot(makeSnapshot());
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("暂无建议");
  });
});
