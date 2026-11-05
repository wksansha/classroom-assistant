import { logEvent } from "./logger";

// ── 配置（create 时读取，便于测试注入环境变量）─────────────────
export interface SuggestionEnricher {
  /** 已缓存的增强要点（无则 null）——buildSnapshot 组装建议文本时拼接 */
  peek(kind: string, subtype: string): string | null;
  /** 异步生成并缓存要点（进行中去重）；LLM 未配置/失败均静默回退原文案；成功后回调 onDone 触发快照重推 */
  ensure(kind: "class-review" | "group-discuss", subtype: string, knowledge: string, onDone?: () => void): void;
  /** 课间重置：清空缓存与进行中标记 */
  clear(): void;
}

/** 建议文案增强（方案 A：规则管触发、LLM 管内容）：按「动作:错误类型」缓存，
 * 同类型一天（至课间重置）只调一次 LLM；未配置 LLM_API_KEY 时整体停用 */
export function createSuggestionEnricher(): SuggestionEnricher {
  const API_KEY = process.env.LLM_API_KEY || "";
  const BASE_URL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
  const MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

  const cache = new Map<string, string>();
  const pending = new Set<string>();
  const keyOf = (kind: string, subtype: string) => `${kind}:${subtype}`;

  function buildPrompt(kind: "class-review" | "group-discuss", subtype: string, knowledge: string): string {
    const action = kind === "class-review" ? "全班讲评" : "小组讨论";
    return [
      `你是 Python 教学助手。全班多名学员报了同一个错误，教师准备进行${action}。`,
      `错误类型：${subtype}`,
      knowledge ? `相关知识点：${knowledge}` : "",
      `要求：只输出一句话（25 到 45 字），给出${action}的教学要点（先讲什么、怎么演示）；`,
      "措辞统一用「学员」，不要出现「学生」；不要输出引号、序号或任何解释。",
    ].filter(Boolean).join("\n");
  }

  async function generate(kind: "class-review" | "group-discuss", subtype: string, knowledge: string): Promise<string | null> {
    const startTime = Date.now();
    const resp = await fetch(`${BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: buildPrompt(kind, subtype, knowledge) }],
        stream: false,
        temperature: 0.3,
      }),
    });
    if (!resp.ok) throw new Error(`LLM API error (${resp.status})`);
    const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
    const tip = (data.choices?.[0]?.message?.content ?? "")
      .trim()
      .replace(/^["「『]+|["」』]+$/g, "")
      .split("\n")[0]
      .trim();
    if (tip.length < 8 || tip.length > 120) return null;   // 明显异常的输出不采用
    logEvent({ event: "suggestion.enriched", level: "debug", data: {
      kind, subtype, tip, model: MODEL, durationMs: Date.now() - startTime,
    } });
    return tip;
  }

  return {
    peek(kind, subtype) {
      return cache.get(keyOf(kind, subtype)) ?? null;
    },
    ensure(kind, subtype, knowledge, onDone) {
      const k = keyOf(kind, subtype);
      if (!API_KEY || cache.has(k) || pending.has(k)) return;
      pending.add(k);
      logEvent({ event: "suggestion.enrich_started", level: "debug", data: { kind, subtype, model: MODEL } });
      void generate(kind, subtype, knowledge)
        .then((tip) => {
          pending.delete(k);
          if (tip) {
            cache.set(k, tip);
            logEvent({ event: "suggestion.enrich_cached", level: "debug", data: { kind, subtype } });
            onDone?.();
          }
        })
        .catch((err) => {
          pending.delete(k);
          logEvent({ event: "suggestion.enrich_failed", level: "warn", data: {
            kind, subtype, error: err instanceof Error ? err.message : String(err),
          } });
        });
    },
    clear() {
      cache.clear();
      pending.clear();
    },
  };
}
