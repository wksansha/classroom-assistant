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
  it("fail 带 category：清单内透传，清单外/非字符串丢弃（防幻觉）", () => {
    expect(parseReviewResponse('{"status":"fail","reason":"空列表崩溃","category":"空值未处理"}'))
      .toEqual({ status: "fail", reason: "空列表崩溃", category: "空值未处理" });
    expect(parseReviewResponse('{"status":"fail","reason":"x","category":"我不存在的分类"}'))
      .toEqual({ status: "fail", reason: "x" });
    expect(parseReviewResponse('{"status":"pass","reason":"ok","category":"边界未处理"}'))
      .toEqual({ status: "pass", reason: "ok", category: "边界未处理" });
  });
  it("多任务：整体分类取首个 fail 任务的 category", () => {
    const raw = JSON.stringify({ tasks: [
      { name: "任务一", status: "pass", reason: "对" },
      { name: "任务二", status: "fail", reason: "越界", category: "边界未处理" },
    ] });
    const r = parseReviewResponse(raw, ["任务一", "任务二"]);
    expect(r).toMatchObject({ status: "fail", category: "边界未处理" });
    expect(r?.tasks?.[1]).toMatchObject({ status: "fail", category: "边界未处理" });
  });
  it("多任务聚合（用户 2026-11-11 定稿）：未开始任务忽略——部分完成全过 → pass；全未开始 → unreviewed", () => {
    const partial = JSON.stringify({ tasks: [
      { name: "任务一", status: "pass", reason: "对" },
      { name: "任务二", status: "unreviewed", reason: "未开始" },
    ] });
    expect(parseReviewResponse(partial, ["任务一", "任务二"])).toMatchObject({ status: "pass" });
    const none = JSON.stringify({ tasks: [
      { name: "任务一", status: "unreviewed", reason: "未开始" },
      { name: "任务二", status: "unreviewed", reason: "未开始" },
    ] });
    expect(parseReviewResponse(none, ["任务一", "任务二"])).toMatchObject({ status: "unreviewed" });
  });
});

describe("callReviewLLM（A4/A11）", () => {
  const input = { code: "print(1)" };
  it("无 apiKey → not_configured（区分「未配置」与「失败」，学生端静默不提示重试）", async () => {
    const r = await callReviewLLM(input, { apiKey: "" });
    expect(r.status).toBe("unreviewed");
    expect(r.source).toBe("not_configured");
    expect(r.reason).toBe("评审服务未配置");
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
