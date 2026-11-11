import type { ReviewResult } from "@classroom/shared";
import { buildReviewPrompt, REVIEW_CATEGORIES } from "@classroom/shared";
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

export type ParsedReview = { status: "pass" | "fail" | "unreviewed"; reason: string; category?: string; tasks?: { name: string; status: "pass" | "fail" | "unreviewed"; reason: string; category?: string }[] };

type Status = "pass" | "fail" | "unreviewed";
const STATUS_SET = new Set(["pass", "fail", "unreviewed"]);
const CATEGORY_SET = new Set<string>(REVIEW_CATEGORIES);

/** 分类白名单校验：清单外（LLM 幻觉/旧格式）→ undefined，注入层回退缺省文案 */
function categoryOf(v: unknown): string | undefined {
  return typeof v === "string" && CATEGORY_SET.has(v) ? v : undefined;
}

function verdictOf(v: unknown): { status: Status; reason: string; category?: string } | null {
  const o = v as { status?: string; reason?: string; category?: string };
  if (o && typeof o.status === "string" && STATUS_SET.has(o.status)
    && typeof o.reason === "string" && o.reason.length > 0) {
    return { status: o.status as Status, reason: o.reason.slice(0, 50), category: categoryOf(o.category) };
  }
  return null;
}

/** 多任务题逐任务结论 → 整体三态（用户 2026-11-11 定稿）：未开始任务（unreviewed）全部忽略不参与结论；
 * 剩余任务任一 fail → fail；剩余全 pass → pass；全部未开始 → unreviewed（无评审结论，feed 静默/完成度停编码中）。
 * reason 只拼失败任务意见（用户 2026-11-11 定稿：没问题的任务不拼接，避免 ✅ 前缀把 ❌ 意见挤出 feed 120 字截断线；
 * 学生弹窗/告警 knowledge 同源受益）；通过/未开始数量一句带过。逐任务完整明细以 review_results 逐任务行与完成度任务桶为准。
 * 分类取首个 fail 任务 */
function summarizeTasks(verdicts: { name: string; status: Status; reason: string; category?: string }[]):
  { status: Status; reason: string; category?: string } {
  const judged = verdicts.filter((v) => v.status !== "unreviewed");
  const status: Status = judged.some((v) => v.status === "fail") ? "fail"
    : judged.length > 0 ? "pass" : "unreviewed";
  const fails = verdicts.filter((v) => v.status === "fail");
  const reason = fails.length > 0
    ? fails.map((v) => `❌${v.name}：${v.reason}`).join(" / ").slice(0, 300)
    : `${judged.filter((v) => v.status === "pass").length}/${verdicts.length} 个任务通过`;
  const category = verdicts.find((v) => v.status === "fail")?.category;
  return { status, reason, ...(category ? { category } : {}) };
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
      return { name: t, status: (verdict?.status ?? "unreviewed") as Status, reason: verdict?.reason ?? "", category: verdict?.category };
    });
    const { status, reason, category } = summarizeTasks(verdicts);
    return { status, reason, ...(category ? { category } : {}), tasks: verdicts };
  }

  // ── 单任务（现状语义）──
  if ((obj.status === "pass" || obj.status === "fail" || obj.status === "unreviewed")
    && typeof obj.reason === "string" && obj.reason.length > 0) {
    const category = categoryOf(obj.category);
    return { status: obj.status, reason: obj.reason.slice(0, 100), ...(category ? { category } : {}) };
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
