import { describe, it, expect } from "vitest";
import { dayStart } from "../classDay";

describe("dayStart（按天窗口起点，spec dashboard-v2 §4）", () => {
  it("任意时刻归到当天本地 00:00", () => {
    const now = new Date();
    now.setHours(15, 30, 45, 123);
    const expected = new Date(now);
    expected.setHours(0, 0, 0, 0);
    expect(dayStart(now.getTime())).toBe(expected.getTime());
  });
  it("跨午夜：00:00 前一毫秒归属前一天", () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const before = today.getTime() - 1;
    const prevDay = new Date(before);
    prevDay.setHours(0, 0, 0, 0);
    expect(dayStart(before)).toBe(prevDay.getTime());
    expect(dayStart(before)).toBeLessThan(today.getTime());
  });
  it("恰好 00:00:00.000 计入当天", () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    expect(dayStart(today.getTime())).toBe(today.getTime());
  });
});
