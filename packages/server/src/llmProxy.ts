/**
 * LLM 聊天代理：学生端扩展以 "teacher" provider 调用本端点，
 * 服务器用自己的 .env 大模型配置转发（学生端零 LLM 配置）。
 *
 * - OpenAI 兼容协议，SSE 流式透传
 * - model 一律改写为服务器配置（防止请求体指定任意模型）
 * - X-Student-Id 请求头仅用于日志（不记聊天内容）
 */
import type { Express, Request, Response } from "express";
import { logEvent } from "./logger";

export interface LlmProxyConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 与 explainService/llm.ts 同名环境变量；无 API key 时返回 null（代理不启用） */
export function readLlmConfigFromEnv(): LlmProxyConfig | null {
  const apiKey = process.env.LLM_API_KEY || "";
  if (!apiKey) return null;
  return {
    baseUrl: (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey,
    model: process.env.LLM_MODEL || "gpt-4o-mini",
  };
}

/** 上游请求超时（本地大模型长回复可能较慢） */
const UPSTREAM_TIMEOUT_MS = 300_000;

export function registerLlmProxy(app: Express, config: LlmProxyConfig | null): void {
  if (!config) {
    logEvent({ event: "llm_proxy.disabled", level: "info", data: { reason: "no_api_key" } });
    return;
  }

  app.post("/api/llm/chat/completions", async (req: Request, res: Response) => {
    const startTime = Date.now();
    const body = req.body as { stream?: boolean; messages?: unknown[] } | undefined;
    const stream = body?.stream === true;
    const messageCount = Array.isArray(body?.messages) ? body.messages.length : 0;
    const studentId = req.header("x-student-id") || undefined;
    logEvent({ event: "llm_proxy.request_started", level: "debug", data: {
      studentId, stream, messageCount,
    } });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    // 客户端断开 → 取消上游请求（监听 socket 而非 req：Node 新版 req 的 close
    // 在请求体接收完毕时就会触发，会误杀还没发出的上游请求）
    req.socket.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const upstream = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ ...req.body, model: config.model }),
        signal: controller.signal,
      });

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        logEvent({ event: "llm_proxy.upstream_error", level: "error", data: {
          status: upstream.status, studentId, body: text.slice(0, 200),
        }, durationMs: Date.now() - startTime });
        res.status(upstream.status).json({ error: `上游模型错误 (${upstream.status})` });
        return;
      }

      if (stream && upstream.body) {
        res.status(200);
        res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
          logEvent({ event: "llm_proxy.request_completed", level: "debug", data: {
            studentId, stream: true,
          }, durationMs: Date.now() - startTime });
        } catch (err) {
          // 流中断：通常是客户端主动取消，记 debug 即可
          logEvent({ event: "llm_proxy.stream_interrupted", level: "debug", data: {
            studentId,
            error: err instanceof Error ? err.message : String(err),
          }, durationMs: Date.now() - startTime });
        }
        res.end();
        return;
      }

      const data = await upstream.json();
      logEvent({ event: "llm_proxy.request_completed", level: "debug", data: {
        studentId, stream: false,
      }, durationMs: Date.now() - startTime });
      res.status(200).json(data);
    } catch (err) {
      const aborted = controller.signal.aborted;
      logEvent({ event: "llm_proxy.request_error", level: aborted ? "debug" : "error", data: {
        studentId,
        error: err instanceof Error ? err.message : String(err),
        aborted,
      }, durationMs: Date.now() - startTime });
      if (!res.headersSent) {
        res.status(502).json({ error: aborted ? "请求已取消" : "代理上游失败" });
      } else {
        res.end(); // 流中途失败，结束响应让客户端收尾
      }
    } finally {
      clearTimeout(timeout);
    }
  });
}
