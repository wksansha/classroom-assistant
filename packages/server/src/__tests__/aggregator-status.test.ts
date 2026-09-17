import { describe, it, expect } from "vitest";
import { computeStatus, computeScore } from "../aggregator";
import type { StudentRecord, StoredEvent } from "../stateManager";

const NOW = Date.parse("2026-09-17T04:00:00.000Z");
const MIN = 60_000;

function record(overrides: Partial<StudentRecord> & { events: StoredEvent[] }): StudentRecord {
  return {
    studentId: "stu001", studentName: "张三", classId: "3A",
    lastActivityAt: NOW, lastErrorAt: null, consecutiveErrors: 0,
    ...overrides,
  };
}

function err(ts: number, subtype: string): StoredEvent {
  return { ts, eventType: "run", success: false, subtype, category: "其他", knowledge: "k", rawMessage: "m" };
}

describe("computeStatus（spec §5 状态色）", () => {
  it("无错误 → 绿（V1 无离线判定，从未上报也是绿）", () => {
    const r = record({ events: [] });
    expect(computeStatus(r, NOW)).toBe("green");
  });
  it("2 分钟内 1 次错误 → 黄", () => {
    const r = record({ events: [err(NOW - 1 * MIN, "缺少冒号")], lastErrorAt: NOW - 1 * MIN, consecutiveErrors: 1 });
    expect(computeStatus(r, NOW)).toBe("yellow");
  });
  it("错误超过 2 分钟前 → 绿（未达红）", () => {
    const r = record({ events: [err(NOW - 3 * MIN, "缺少冒号")], lastErrorAt: NOW - 3 * MIN, consecutiveErrors: 1 });
    expect(computeStatus(r, NOW)).toBe("green");
  });
  it("同一 subtype 5 分钟内 3 次 → 红", () => {
    const ts = [NOW - 4 * MIN, NOW - 3 * MIN, NOW - 2 * MIN];
    const r = record({
      events: ts.map(t => err(t, "缺少冒号")),
      lastErrorAt: NOW - 2 * MIN, consecutiveErrors: 3,
    });
    expect(computeStatus(r, NOW)).toBe("red");
  });
  it("5 分钟窗口外的重复不计入：3 次中有 1 次在 6 分钟前 → 黄", () => {
    const ts = [NOW - 6 * MIN, NOW - 3 * MIN, NOW - 2 * MIN];
    const r = record({
      events: ts.map(t => err(t, "缺少冒号")),
      lastErrorAt: NOW - 2 * MIN, consecutiveErrors: 3,
    });
    expect(computeStatus(r, NOW)).toBe("yellow");
  });
  it("不同 subtype 各 1 次（窗口内重复不足 3）但连续 ≥5 → 红（走连续错误路径）", () => {
    const ts = [1, 2, 3, 4, 5].map(i => NOW - i * MIN);
    const r = record({
      events: ts.map((t, i) => err(t, `子类${i}`)),
      lastErrorAt: NOW - 1 * MIN, consecutiveErrors: 5,
    });
    expect(computeStatus(r, NOW)).toBe("red");
  });
});

describe("computeScore（spec §5 优先级分）", () => {
  it("无错误 → 0", () => {
    expect(computeScore(record({ events: [] }), NOW)).toBe(0);
  });
  it("3 次重复 + 距上次报错 4 分钟 + 距上次事件>3 分钟且未解决 = 30+20+20 = 70", () => {
    // 3 次同类错误都落在 5 分钟窗口内（4.9/4.5/4 分钟前）
    const ts = [NOW - 4.9 * MIN, NOW - 4.5 * MIN, NOW - 4 * MIN];
    const r = record({
      events: ts.map(t => err(t, "缺少冒号")),
      lastActivityAt: NOW - 4 * MIN, // 最后一次事件就是那次错误
      lastErrorAt: NOW - 4 * MIN,
      consecutiveErrors: 3,
    });
    expect(computeScore(r, NOW)).toBe(70);
  });
  it("连续错误 ≥5 额外 +30", () => {
    const ts = [1, 2, 3, 4, 5].map(i => NOW - i * MIN);
    const r = record({
      events: ts.map((t, i) => err(t, `子类${i}`)), // 每种 subtype 仅 1 次 → 重复分 1×10
      lastActivityAt: NOW - 1 * MIN, lastErrorAt: NOW - 1 * MIN,
      consecutiveErrors: 5,
    });
    // 重复 1×10 + 距上次报错 1 分钟×5=5 + 未解决加分（距上次事件仅 1 分钟 <3，不加）+ 连续 30 = 45
    expect(computeScore(r, NOW)).toBe(45);
  });
  it("成功运行后（最后事件是成功）：不加「未解决」20 分", () => {
    const ts = [NOW - 9 * MIN, NOW - 8 * MIN, NOW - 7 * MIN];
    const events = ts.map(t => err(t, "缺少冒号"));
    events.push({ ts: NOW - 5 * MIN, eventType: "run", success: true, subtype: null, category: "运行成功", knowledge: null, rawMessage: "ok" });
    const r = record({
      events,
      lastActivityAt: NOW - 5 * MIN, lastErrorAt: NOW - 7 * MIN,
      consecutiveErrors: 0,
    });
    // 3 次重复(5 分钟窗口内? 9/8/7 分钟前都超窗 → 0) 0×10 + floor(7 分钟)×5=35，无未解决加分 = 35
    expect(computeScore(r, NOW)).toBe(35);
  });
});
