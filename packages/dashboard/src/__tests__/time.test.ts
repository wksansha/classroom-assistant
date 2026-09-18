import { describe, it, expect } from "vitest";
import { fmtTime, fmtAgo } from "../composables/time";

describe("时间工具（spec §7：zh-CN 24 小时制，本地时区）", () => {
  it("fmtTime 输出 HH:mm:ss", () => {
    expect(fmtTime(Date.parse("2026-09-17T04:05:06.000Z"))).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
  it("fmtAgo：刚刚 / N 分钟前 / 占位", () => {
    const now = Date.parse("2026-09-17T04:00:00.000Z");
    expect(fmtAgo(now - 30_000, now)).toBe("刚刚");
    expect(fmtAgo(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(fmtAgo(null, now)).toBe("—");
  });
});