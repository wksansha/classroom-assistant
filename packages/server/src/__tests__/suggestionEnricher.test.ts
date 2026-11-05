import { afterEach, describe, expect, it, vi } from "vitest";
import { createSuggestionEnricher } from "../suggestionEnricher";

const LLM_RESPONSE = (text: string) => ({
  choices: [{ message: { content: text } }],
});

function stubLlm(content: string) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => LLM_RESPONSE(content),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("suggestionEnricher（建议文案增强：规则管触发、LLM 管内容）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("ensure → LLM 生成要点缓存，peek 可读；onDone 回调触发；重复 ensure 不再调 LLM", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    const fetchMock = stubLlm("先复习变量需先定义再使用，随后现场演示两次赋值对比");
    const enricher = createSuggestionEnricher();
    expect(enricher.peek("class-review", "缺少冒号")).toBeNull();

    const onDone = vi.fn();
    enricher.ensure("class-review", "缺少冒号", "变量要先赋值再使用", onDone);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.messages[0].content).toContain("全班讲评");
    expect(body.messages[0].content).toContain("缺少冒号");
    expect(body.messages[0].content).toContain("学员");
    expect(enricher.peek("class-review", "缺少冒号")).toBe("先复习变量需先定义再使用，随后现场演示两次赋值对比");

    enricher.ensure("class-review", "缺少冒号", "变量要先赋值再使用", onDone);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));   // 缓存命中不再触发
    expect(fetchMock).toHaveBeenCalledTimes(1);   // 同类型只调一次 LLM
  });

  it("LLM 失败：静默回退（peek 仍为 null），下次 ensure 重试", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    const fetchMock = vi.fn().mockRejectedValue(new Error("llm down"));
    vi.stubGlobal("fetch", fetchMock);
    const enricher = createSuggestionEnricher();

    enricher.ensure("group-discuss", "意外缩进", "缩进划分代码块");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));   // 等失败回调清完 pending
    expect(enricher.peek("group-discuss", "意外缩进")).toBeNull();

    stubLlm("先统一缩进风格，再对比正确与错误示例");
    enricher.ensure("group-discuss", "意外缩进", "缩进划分代码块");
    await vi.waitFor(() => expect(enricher.peek("group-discuss", "意外缩进")).not.toBeNull());
  });

  it("未配置 LLM_API_KEY：整体停用，ensure 不发起请求", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const enricher = createSuggestionEnricher();
    enricher.ensure("class-review", "缺少冒号", "k");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(enricher.peek("class-review", "缺少冒号")).toBeNull();
  });

  it("clear：课间重置后缓存清空，可重新生成", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    const fetchMock = stubLlm("先讲评高频错误的共因，再逐行演示修正过程");
    const enricher = createSuggestionEnricher();
    enricher.ensure("class-review", "缺少冒号", "k");
    await vi.waitFor(() => expect(enricher.peek("class-review", "缺少冒号")).not.toBeNull());

    enricher.clear();
    expect(enricher.peek("class-review", "缺少冒号")).toBeNull();
    enricher.ensure("class-review", "缺少冒号", "k");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
