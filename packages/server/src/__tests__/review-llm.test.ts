import { describe, it, expect } from "vitest";
import { callReviewLLM, parseReviewResponse } from "../reviewService/llm";

const okFetch = (content: string) =>
  (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })) as unknown as typeof fetch;

describe("parseReviewResponse", () => {
  it("裸 JSON / 围栏 JSON 均可解析", () => {
    expect(parseReviewResponse('{"status":"pass","reason":"ok"}')).toEqual({ status: "pass", reason: "ok" });
    expect(parseReviewResponse('```json\n{"status":"fail","reason":"未处理空列表"}\n```')).toEqual({ status: "fail", reason: "未处理空列表" });
  });
  it("LLM 输出 unreviewed 是合法解析结果", () => {
    expect(parseReviewResponse('{"status":"unreviewed","reason":"无法确定"}')?.status).toBe("unreviewed");
  });
  it("非法输入返回 null", () => {
    expect(parseReviewResponse("废话")).toBeNull();
    expect(parseReviewResponse('{"status":"maybe"}')).toBeNull();
  });
});

describe("callReviewLLM（A4/A11）", () => {
  const input = { problemStatement: "题", code: "print(1)" };
  it("无 apiKey → mock unreviewed", async () => {
    const r = await callReviewLLM(input, { apiKey: "" });
    expect(r.status).toBe("unreviewed");
    expect(r.source).toBe("mock");
    expect(r.reason).toContain("评审服务不可用");
  });
  it("正常返回 → 三态透传，source=llm", async () => {
    const r = await callReviewLLM(input, { apiKey: "k", fetchImpl: okFetch('{"status":"pass","reason":"代码通过所有测试用例"}') });
    expect(r).toMatchObject({ status: "pass", reason: "代码通过所有测试用例", source: "llm" });
  });
  it("不可解析 → unreviewed + reason=LLM 返回不可解析", async () => {
    const r = await callReviewLLM(input, { apiKey: "k", fetchImpl: okFetch("垃圾") });
    expect(r).toMatchObject({ status: "unreviewed", reason: "LLM 返回不可解析", source: "llm" });
  });
  it("超时 → unreviewed + source=timeout", async () => {
    const hang: typeof fetch = (_u, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener("abort", () =>
        rej(Object.assign(new Error("aborted"), { name: "AbortError" })))) as never;
    const r = await callReviewLLM(input, { apiKey: "k", timeoutMs: 30, fetchImpl: hang });
    expect(r).toMatchObject({ status: "unreviewed", reason: "评审超时", source: "timeout" });
  });
});
