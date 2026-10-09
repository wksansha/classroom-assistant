import type { ReviewResult, TestCase } from "@classroom/shared";
import { buildReviewPrompt } from "@classroom/shared";
import { logEvent } from "../logger";

export interface ReviewLlmOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;      // A11：默认 60s
  fetchImpl?: typeof fetch;
}

export type ParsedReview = { status: "pass" | "fail" | "unreviewed"; reason: string };

export function parseReviewResponse(raw: string): ParsedReview | null {
  const stripped = raw.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(stripped.slice(start, end + 1));
    if ((obj.status === "pass" || obj.status === "fail" || obj.status === "unreviewed")
      && typeof obj.reason === "string" && obj.reason.length > 0) {
      return { status: obj.status, reason: obj.reason.slice(0, 100) };
    }
    return null;
  } catch {
    return null;
  }
}

export function mockReview(model: string): ReviewResult {
  return { status: "unreviewed", reason: "评审服务不可用（mock 兜底）", reviewedAt: Date.now(), model, source: "mock" };
}

export async function callReviewLLM(
  input: { problemStatement: string; testCases?: TestCase[] | null; code: string },
  opts: ReviewLlmOptions = {},
): Promise<ReviewResult> {
  const apiKey = opts.apiKey ?? process.env.LLM_API_KEY ?? "";
  const baseUrl = opts.baseUrl ?? process.env.LLM_BASE_URL ?? "https://api.openrouter.ai/api/v1";
  const model = opts.model ?? process.env.LLM_MODEL ?? "openrouter/free";
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const doFetch = opts.fetchImpl ?? fetch;
  if (!apiKey) return mockReview(model);

  const prompt = buildReviewPrompt({ problemStatement: input.problemStatement, testCases: input.testCases, studentCode: input.code });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  logEvent({ event: "review.llm_started", level: "debug", data: { model, promptLen: prompt.length, timeoutMs } });
  try {
    const res = await doFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0.3, stream: false, messages: [{ role: "user", content: prompt }] }),
      signal: controller.signal,
    });
    if (!res.ok) return mockReview(model);
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const parsed = parseReviewResponse(data.choices?.[0]?.message?.content ?? "");
    if (!parsed) {
      return { status: "unreviewed", reason: "LLM 返回不可解析", reviewedAt: Date.now(), model, source: "llm" };
    }
    return { ...parsed, reviewedAt: Date.now(), model, source: "llm" };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "unreviewed", reason: "评审超时", reviewedAt: Date.now(), model, source: "timeout" };
    }
    return mockReview(model);
  } finally {
    clearTimeout(timer);
  }
}
