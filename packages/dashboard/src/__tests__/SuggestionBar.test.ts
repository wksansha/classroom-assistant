import { describe, it, expect, vi, afterEach } from "vitest";
import SuggestionBar from "../components/SuggestionBar.vue";
import { makeSnapshot, mountWithStore } from "./helpers";
import type { SuggestionItem, SuggestionKind } from "@classroom/shared";

const suggestions: SuggestionItem[] = [
  { id: "class-review:缺少冒号", kind: "class-review" as SuggestionKind, text: "⚠️ 8 人卡在「缺少冒号」，建议全班讲评", acked: false },
  { id: "individual:stu001", kind: "individual" as SuggestionKind, text: "🙋 张三 连续报错，建议单独辅导", acked: false },
  { id: "group-discuss:意外缩进", kind: "group-discuss" as SuggestionKind, text: "💡 2 人遇到「意外缩进」，可小组讨论", acked: true },
];

describe("SuggestionBar", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("渲染未处理建议，已处理（acked）不显示", async () => {
    const { wrapper, store } = mountWithStore(SuggestionBar);
    store.applySnapshot(makeSnapshot({ suggestions }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("全班讲评");
    expect(wrapper.text()).toContain("单独辅导");
    expect(wrapper.text()).not.toContain("小组讨论"); // acked=true 的不渲染
  });

  it("[标记已处理] 调 ack API 并本地隐藏", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper, store } = mountWithStore(SuggestionBar);
    store.applySnapshot(makeSnapshot({ suggestions }));
    await wrapper.vm.$nextTick();
    await wrapper.findAll("button")[0].trigger("click");
    await wrapper.vm.$nextTick();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/suggestions/ack",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ id: "class-review:缺少冒号" }),
      }),
    );
    expect(wrapper.text()).not.toContain("全班讲评");
  });
});