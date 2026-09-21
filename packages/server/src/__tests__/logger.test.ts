import { describe, it, expect, vi, afterEach } from "vitest";
import { logger, logEvent } from "../logger";

describe("logEvent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("事件名不被 data 里的 event 字段覆盖", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    logEvent({ event: "state.event_applied", data: { studentId: "s1", event: { ts: 1 } } });
    const arg = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.event).toBe("state.event_applied");
  });

  it("data 与 durationMs 透传；timestamp/service 由 winston 注入而非调用参数", () => {
    const spy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    logEvent({ event: "x.y", level: "warn", data: { a: 1 }, durationMs: 5 });
    const arg = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.event).toBe("x.y");
    expect(arg.a).toBe(1);
    expect(arg.durationMs).toBe(5);
    expect(arg.timestamp).toBeUndefined();
    expect(arg.service).toBeUndefined();
  });
});
