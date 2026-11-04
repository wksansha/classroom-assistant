import type { Explanation, NormalizedEvent } from "@classroom/shared";
import { callLLM, fallbackSubtype } from "./llm";
import type { Cache } from "./cache";
import { logEvent } from "../logger";

export interface ExplainService {
  explain(ev: NormalizedEvent): Promise<Explanation & { source: "llm" | "mock" }>;
}

export function createExplainService(cache: Cache): ExplainService {
  return {
    async explain(ev) {
      const startTime = Date.now();
      // 成功事件不解释（调用方也不会调）；无 cacheKey 的畸形错误事件直接用事件自身报错兜底（绝无「未知错误」）
      if (ev.success || !ev.cacheKey) {
        logEvent({ event: "explain.skipped", level: "debug", data: {
          studentId: ev.studentId,
          eventType: ev.eventType,
          success: ev.success,
          hasCacheKey: !!ev.cacheKey,
        } });
        return {
          category: "其他",
          subtype: fallbackSubtype(ev.errorType, ev.rawMessage),
          knowledge: "请检查代码与输入是否正确",
          source: "mock" as const,
        };
      }
      const { exp, source } = await cache.getExplanation(ev.cacheKey, () =>
        callLLM({
          errorType: ev.errorType ?? "DiagnosticError",
          errorMessage: ev.rawMessage || ev.errorMessage || "",
          codeSnippet: ev.codeSnippet,
        }),
      );
      // 消毒：历史缓存/任何路径漏出的「未知错误」一律改用 L1 事件自身报错（约束：绝对不允许出现）
      const safeExp: Explanation = exp.subtype === "未知错误"
        ? { ...exp, subtype: fallbackSubtype(ev.errorType, ev.rawMessage) }
        : exp;
      // 分类完全由 LLM 决定（run/diag 同构；LLM 挂时由关键词规则兜底，category 仅展示标签无逻辑依赖）
      const result: Explanation & { source: "llm" | "mock" } = { ...safeExp, source };
      logEvent({ event: "explain.completed", level: "debug", data: {
        studentId: ev.studentId,
        eventType: ev.eventType,
        cacheKey: ev.cacheKey,
        result,
        durationMs: Date.now() - startTime,
      } });
      return result;
    },
  };
}