import { describe, it, expect } from "vitest";
import { createExplainService } from "../explainService/index";
import type { Cache } from "../explainService/cache";
import type { NormalizedEvent, Explanation } from "@classroom/shared";

function stubCache(answers: Record<string, Explanation>): Cache {
  return {
    async getExplanation(key, fn) {
      if (key in answers) return answers[key];
      return fn();
    },
    getStats: () => ({ memoryCacheSize: 0, pendingRequestsSize: 0 }),
  };
}

function runErrorEvent(cacheKey: string): NormalizedEvent {
  return {
    studentId: "s", studentName: "s", classId: "3A", eventType: "run", success: false,
    errorType: "ZeroDivisionError", errorMessage: "division by zero", samples: [],
    rawMessage: "division by zero", cacheKey, command: undefined, exitCode: 1,
    filePath: undefined, lineNo: undefined, ts: Date.now(),
  };
}

describe("explain 分类取用规则（spec §5）", () => {
  it("run 事件：category 以静态映射为准（即使 LLM 给错），subtype/knowledge 采纳 LLM", async () => {
    // LLM 故意返回错误 category，静态映射应覆盖为「运算错误」
    const svc = createExplainService(stubCache({
      "ZeroDivisionError: division by zero":
        { category: "类型错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" },
    }));
    const r = await svc.explain(runErrorEvent("ZeroDivisionError: division by zero"));
    expect(r).toEqual({ category: "运算错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" });
  });

  it("diag 事件：三字段全部采纳 LLM（error_type 是写死的占位）", async () => {
    const llmResult = { category: "语法错误", subtype: "缺少冒号", knowledge: "函数定义末尾要加冒号" };
    const svc = createExplainService(stubCache({ "应为 \":\"": llmResult }));
    const ev: NormalizedEvent = {
      studentId: "s", studentName: "s", classId: "3A", eventType: "diag", success: false,
      errorType: null, errorMessage: "应为 \":\"", samples: ["应为 \":\""], rawMessage: "应为 \":\"",
      cacheKey: "应为 \":\"", ts: Date.now(),
    };
    expect(await svc.explain(ev)).toEqual(llmResult);
  });

  it("cacheKey 为 null 的边界（如无样本 diag）：直接兜底，不调 LLM", async () => {
    let called = false;
    const svc = createExplainService({
      async getExplanation(_k, fn) { called = true; return fn(); },
      getStats: () => ({ memoryCacheSize: 0, pendingRequestsSize: 0 }),
    });
    const ev = { ...runErrorEvent("ignored"), cacheKey: null } as NormalizedEvent;
    const r = await svc.explain(ev);
    expect(called).toBe(false);
    expect(r.category).toBe("其他");
  });
});
