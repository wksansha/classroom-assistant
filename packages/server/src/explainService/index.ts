import { categoryFor, type Explanation, type NormalizedEvent } from "@classroom/shared";
import { callLLM } from "./llm";
import type { Cache } from "./cache";
import { logEvent } from "../logger";

export interface ExplainService {
  explain(ev: NormalizedEvent): Promise<Explanation>;
}

export function createExplainService(cache: Cache): ExplainService {
  return {
    async explain(ev) {
      const startTime = Date.now();
      // 成功事件不解释（调用方也不会调）；无 cacheKey 的畸形错误事件直接兜底
      if (ev.success || !ev.cacheKey) {
        logEvent({ event: "explain.skipped", level: "debug", data: {
          studentId: ev.studentId,
          eventType: ev.eventType,
          success: ev.success,
          hasCacheKey: !!ev.cacheKey,
        } });
        return { category: "其他", subtype: "未知错误", knowledge: "请检查代码与输入是否正确" };
      }
      const llm = await cache.getExplanation(ev.cacheKey, () =>
        callLLM({
          errorType: ev.errorType ?? "DiagnosticError",
          errorMessage: ev.rawMessage || ev.errorMessage || "",
          codeSnippet: ev.codeSnippet,
        }),
      );
      const result = ev.eventType === "run"
        ? { ...llm, category: categoryFor(ev.errorType) }
        : llm;
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