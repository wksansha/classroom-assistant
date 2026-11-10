import type { ReviewResult } from "@classroom/shared";
import { buildReviewPrompt } from "@classroom/shared";
import { logEvent } from "../logger";

export interface ReviewLlmOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;      // A11：默认 60s
  fetchImpl?: typeof fetch;
  /** 首次 LLM 失败后的重试等待（ms，数字或返回 ms 的函数）；缺省随机 5~15 秒（评审繁忙/抖动自愈），测试传 0 */
  retryDelayMs?: number | (() => number);
}

export type ParsedReview = { status: "pass" | "fail" | "unreviewed"; reason: string; tasks?: { name: string; status: "pass" | "fail" | "unreviewed"; reason: string }[] };

type Status = "pass" | "fail" | "unreviewed";
const STATUS_SET = new Set(["pass", "fail", "unreviewed"]);
const ICON: Record<Status, string> = { pass: "✅", fail: "❌", unreviewed: "⬜" };

function verdictOf(v: unknown): { status: Status; reason: string } | null {
  const o = v as { status?: string; reason?: string };
  if (o && typeof o.status === "string" && STATUS_SET.has(o.status)
    && typeof o.reason === "string" && o.reason.length > 0) {
    return { status: o.status as Status, reason: o.reason.slice(0, 50) };
  }
  return null;
}

/** 多任务题逐任务结论 → 整体三态 + 拼接摘要（spec 2026-11-09 §4） */
function summarizeTasks(verdicts: { name: string; status: Status; reason: string }[]):
  { status: Status; reason: string } {
  const status: Status = verdicts.some((v) => v.status === "fail") ? "fail"
    : verdicts.every((v) => v.status === "pass") ? "pass" : "unreviewed";
  const reason = verdicts
    .map((v) => `${ICON[v.status]}${v.name}：${v.status === "unreviewed" ? "未开始" : v.reason}`)
    .join(" / ")
    .slice(0, 300);
  return { status, reason };
}

export function parseReviewResponse(raw: string, declaredTasks?: string[]): ParsedReview | null {
  const stripped = raw.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }

  // ── 多任务题（声明 ≥2）：逐任务清单，宽松匹配声明名；缺任务 = unreviewed 未开始 ──
  if (declaredTasks && declaredTasks.length >= 2) {
    const rawTasks = Array.isArray(obj.tasks) ? (obj.tasks as unknown[]) : null;
    const verdicts = declaredTasks.map((t) => {
      const matched = rawTasks
        ?.map((v) => (typeof v === "object" && v !== null ? (v as { name?: string }) : null))
        .find((v) => typeof v?.name === "string"
          && (v.name === t || v.name.includes(t) || t.includes(v.name)));
      const verdict = matched ? verdictOf(matched) : null;
      return { name: t, status: (verdict?.status ?? "unreviewed") as Status, reason: verdict?.reason ?? "" };
    });
    const { status, reason } = summarizeTasks(verdicts);
    return { status, reason, tasks: verdicts };
  }

  // ── 单任务（现状语义）──
  if ((obj.status === "pass" || obj.status === "fail" || obj.status === "unreviewed")
    && typeof obj.reason === "string" && obj.reason.length > 0) {
    return { status: obj.status, reason: obj.reason.slice(0, 100) };
  }
  return null;
}

export function mockReview(model: string): ReviewResult {
  return { status: "unreviewed", reason: "评审服务不可用（mock 兜底）", reviewedAt: Date.now(), model, source: "mock" };
}

/** 未配置 LLM（如云上练习环境）：与「配置了但失败」区分——学生端对此静默，不提示重试 */
export function notConfiguredReview(model: string): ReviewResult {
  return { status: "unreviewed", reason: "评审服务未配置", reviewedAt: Date.now(), model, source: "not_configured" };
}

export async function callReviewLLM(
  input: { code: string; tasks?: string[] },
  opts: ReviewLlmOptions = {},
): Promise<ReviewResult> {
  const apiKey = opts.apiKey ?? process.env.LLM_API_KEY ?? "";
  const baseUrl = opts.baseUrl ?? process.env.LLM_BASE_URL ?? "https://api.openrouter.ai/api/v1";
  const model = opts.model ?? process.env.LLM_MODEL ?? "openrouter/free";
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const doFetch = opts.fetchImpl ?? fetch;
  if (!apiKey) return notConfiguredReview(model);

  const prompt = buildReviewPrompt({ studentCode: input.code, tasks: input.tasks });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  logEvent({ event: "review.llm_started", level: "debug", data: { model, promptLen: prompt.length, timeoutMs, tasks: input.tasks?.length ?? 0 } });
  try {
    const res = await doFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0.3, stream: false, messages: [{ role: "user", content: prompt }] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      logEvent({ event: "review.llm_http_error", level: "warn", data: { status: res.status, body: bodyText.slice(0, 200) } });
      return mockReview(model);
    }
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const parsed = parseReviewResponse(data.choices?.[0]?.message?.content ?? "", input.tasks);
    if (!parsed) {
      return { status: "unreviewed", reason: "LLM 返回不可解析", reviewedAt: Date.now(), model, source: "llm" };
    }
    return { ...parsed, reviewedAt: Date.now(), model, source: "llm" };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "unreviewed", reason: "评审超时", reviewedAt: Date.now(), model, source: "timeout" };
    }
    logEvent({ event: "review.llm_failed", level: "warn", data: { error: err instanceof Error ? err.message : String(err) } });
    return mockReview(model);
  } finally {
    clearTimeout(timer);
  }
}
