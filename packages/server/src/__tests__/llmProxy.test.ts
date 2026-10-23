import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import request from "supertest";
import { createApp } from "../index";
import { logger } from "../logger";

// 假上游：记录收到的请求，按 stream 与否回 SSE 或 JSON
let seen: { auth?: string; studentId?: string; body?: Record<string, unknown> } = {};
let upstreamPort = 0;
let upstream: http.Server;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen = {
        auth: req.headers.authorization,
        studentId: req.headers["x-student-id"] as string | undefined,
        body: JSON.parse(raw || "{}") as Record<string, unknown>,
      };
      if (seen.body?.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as { port: number }).port;
});

afterAll(() => upstream.close());

function appWithProxy() {
  return createApp({
    dbPath: ":memory:",
    staticDir: null,
    llmConfig: { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "test-key", model: "test-model" },
  }).app;
}

describe("POST /api/llm/chat/completions（LLM 聊天代理）", () => {
  afterEach(() => vi.restoreAllMocks());

  it("非流式：转发请求，model 改写为服务器配置，返回上游 JSON；X-Student-Id 记入日志（不转发上游）", async () => {
    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => logger);
    const res = await request(appWithProxy())
      .post("/api/llm/chat/completions")
      .set("X-Student-Id", "20240101")
      .send({ model: "rogue-model", messages: [{ role: "user", content: "hi" }] })
      .expect(200);
    expect(res.body.choices[0].message.content).toBe("ok");
    expect(seen.auth).toBe("Bearer test-key");
    expect(seen.body?.model).toBe("test-model"); // 客户端指定的 model 被覆盖
    expect(seen.body?.messages).toEqual([{ role: "user", content: "hi" }]);
    // 学生 ID 只用于服务端日志（谁在用模型）
    const started = debugSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((arg) => arg?.event === "llm_proxy.request_started");
    expect(started?.studentId).toBe("20240101");
    expect(seen.studentId).toBeUndefined(); // 不转发给上游
  });

  it("流式：透传 SSE 分块，content-type 为 event-stream", async () => {
    const res = await request(appWithProxy())
      .post("/api/llm/chat/completions")
      .send({ stream: true, messages: [{ role: "user", content: "hi" }] })
      .expect(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain('{"choices":[{"delta":{"content":"你"}}]}');
    expect(res.text).toContain('{"choices":[{"delta":{"content":"好"}}]}');
    expect(res.text).toContain("[DONE]");
  });

  it("未配置大模型（llmConfig: null）→ 代理不启用，404", async () => {
    const app = createApp({ dbPath: ":memory:", staticDir: null, llmConfig: null }).app;
    await request(app).post("/api/llm/chat/completions").send({ messages: [] }).expect(404);
  });
});

describe("LLM 代理门禁（X-Student-Id 名册校验 + 按学号限流，spec 2026-10-23）", () => {
  afterEach(() => vi.restoreAllMocks());

  async function appWithRoster() {
    const { app } = createApp({
      dbPath: ":memory:",
      staticDir: null,
      llmConfig: { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "test-key", model: "test-model" },
    });
    // 名册导入本身走管理门禁，但测试未配置 ADMIN_PASSWORD → 直接可达
    await request(app).post("/api/roster").send({ text: "0001 张三\n0002 李四" }).expect(200);
    return app;
  }

  it("名册为空 → 不校验学号放行（教师未导入名册/本地开发兼容）", async () => {
    await request(appWithProxy())
      .post("/api/llm/chat/completions")
      .send({ messages: [{ role: "user", content: "hi" }] })
      .expect(200);
  });

  it("名册已导入：缺 X-Student-Id → 403 中文提示", async () => {
    const app = await appWithRoster();
    const res = await request(app)
      .post("/api/llm/chat/completions")
      .send({ messages: [{ role: "user", content: "hi" }] })
      .expect(403);
    expect(res.body.error).toContain("身份页");
  });

  it("名册已导入：学号不在名册 → 403", async () => {
    const app = await appWithRoster();
    await request(app)
      .post("/api/llm/chat/completions")
      .set("X-Student-Id", "9999")
      .send({ messages: [{ role: "user", content: "hi" }] })
      .expect(403);
  });

  it("名册学号 → 放行到代理", async () => {
    const app = await appWithRoster();
    await request(app)
      .post("/api/llm/chat/completions")
      .set("X-Student-Id", "0001")
      .send({ messages: [{ role: "user", content: "hi" }] })
      .expect(200);
  });

  it("同 学号超出 20 次/分钟 → 429", async () => {
    const app = await appWithRoster();
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        request(app)
          .post("/api/llm/chat/completions")
          .set("X-Student-Id", "0002")
          .send({ messages: [{ role: "user", content: "hi" }] }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(20);
    expect(statuses).toContain(429);
    const limited = results.find((r) => r.status === 429)!;
    expect(limited.body.error).toContain("频繁");
  });

  it("限流按学号隔离：0001 被限不影响 0002", async () => {
    const app = await appWithRoster();
    await Promise.all(
      Array.from({ length: 25 }, () =>
        request(app)
          .post("/api/llm/chat/completions")
          .set("X-Student-Id", "0001")
          .send({ messages: [{ role: "user", content: "hi" }] }),
      ),
    );
    await request(app)
      .post("/api/llm/chat/completions")
      .set("X-Student-Id", "0002")
      .send({ messages: [{ role: "user", content: "hi" }] })
      .expect(200);
  });
});
