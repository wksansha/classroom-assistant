import { buildExplainPrompt, type ExplainInput, type Explanation } from "@classroom/shared";
import { logEvent } from "../logger";

// ── 配置（沿用 demo 环境变量）─────────────────────────
const API_KEY = process.env.LLM_API_KEY || "";
const BASE_URL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

// ── mock 关键词表（spec §8：LLM 失败时同结构兜底）─────
const MOCK_RULES: { keywords: string[]; exp: Explanation }[] = [
  { keywords: ["indentation", "tab", "syntax", "expected", "应为", "冒号", "缩进"], exp: { category: "语法错误", subtype: "缩进或标点错误", knowledge: "缩进规则：Python 靠缩进划分代码块" } },
  { keywords: ["name", "未定义"], exp: { category: "名称错误", subtype: "未定义变量", knowledge: "变量要先赋值再使用，检查拼写" } },
  { keywords: ["type", "value", "operand"], exp: { category: "类型错误", subtype: "类型不匹配", knowledge: "运算前确认两边类型一致" } },
  { keywords: ["division", "zero", "overflow"], exp: { category: "运算错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" } },
  { keywords: ["index", "key", "range"], exp: { category: "容器访问错误", subtype: "索引或键越界", knowledge: "访问前确认容器长度和键名" } },
  { keywords: ["attribute", "import", "module"], exp: { category: "属性导入错误", subtype: "属性或模块不存在", knowledge: "检查拼写，确认模块已安装" } },
  { keywords: ["file", "permission"], exp: { category: "文件权限错误", subtype: "文件不可用", knowledge: "检查文件路径与权限" } },
];
const MOCK_FALLBACK: Explanation = { category: "其他", subtype: "未知错误", knowledge: "请检查代码与输入是否正确" };

export function mockExplain(input: ExplainInput): Explanation {
  const s = `${input.errorType} ${input.errorMessage}`.toLowerCase();
  return MOCK_RULES.find((r) => r.keywords.some((k) => s.includes(k.toLowerCase())))?.exp ?? MOCK_FALLBACK;
}

export function parseLLMResponse(text: string): Explanation | null {
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o.category !== "string" || typeof o.subtype !== "string" || typeof o.knowledge !== "string") return null;
    return { category: o.category, subtype: o.subtype, knowledge: o.knowledge };
  } catch {
    return null;
  }
}

async function callRealLLM(input: ExplainInput): Promise<Explanation> {
  const startTime = Date.now();
  const prompt = buildExplainPrompt(input); // 只构建一次（日志长度与请求体共用）
  logEvent({ event: "llm.request_started", level: "debug", data: {
    model: MODEL,
    promptLength: prompt.length,
    hasCodeSnippet: !!input.codeSnippet,
    errorType: input.errorType,
    errorMessageLength: input.errorMessage?.length ?? 0,
  } });

  const resp = await fetch(`${BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      temperature: 0.3,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    logEvent({ event: "llm.api_error", level: "error", data: {
      status: resp.status,
      body: body.slice(0, 200),
      model: MODEL,
    }, durationMs: Date.now() - startTime });
    throw new Error(`LLM API error (${resp.status}): ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content || "";
  const parsed = parseLLMResponse(content);

  if (!parsed) {
    logEvent({ event: "llm.parse_failed", level: "error", data: {
      model: MODEL,
      responsePreview: content.slice(0, 200),
    }, durationMs: Date.now() - startTime });
    throw new Error("LLM 输出无法解析为三字段 JSON");
  }

  logEvent({ event: "llm.request_completed", level: "debug", data: {
    model: MODEL,
    result: parsed,
  }, durationMs: Date.now() - startTime });

  return parsed;
}

export async function callLLM(input: ExplainInput): Promise<Explanation> {
  if (!API_KEY) {
    logEvent({ event: "llm.mock_fallback", level: "debug", data: { reason: "no_api_key" } });
    return mockExplain(input);
  }

  try {
    return await callRealLLM(input);
  } catch (err) {
    logEvent({ event: "llm.mock_fallback", level: "warn", data: {
      reason: "api_error",
      error: err instanceof Error ? err.message : String(err),
      model: MODEL,
    } });
    return mockExplain(input);
  }
}
