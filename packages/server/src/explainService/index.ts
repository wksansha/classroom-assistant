import { categoryFor, type Explanation, type NormalizedEvent } from "@classroom/shared";
import { callLLM } from "./llm";
import type { Cache } from "./cache";

export interface ExplainService {
  explain(ev: NormalizedEvent): Promise<Explanation>;
}

export function createExplainService(cache: Cache): ExplainService {
  return {
    async explain(ev) {
      // 成功事件不解释（调用方也不会调）；无 cacheKey 的畸形错误事件直接兜底
      if (ev.success || !ev.cacheKey) {
        return { category: "其他", subtype: "未知错误", knowledge: "请检查代码与输入是否正确" };
      }
      const llm = await cache.getExplanation(ev.cacheKey, () =>
        callLLM({ errorType: ev.errorType ?? "DiagnosticError", errorMessage: ev.rawMessage || ev.errorMessage || "" }),
      );
      if (ev.eventType === "run") {
        // run：category 静态映射覆盖（确定性高），subtype/knowledge 采纳 LLM
        return { ...llm, category: categoryFor(ev.errorType) };
      }
      // diag：三字段全采纳 LLM
      return llm;
    },
  };
}