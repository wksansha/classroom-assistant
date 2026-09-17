import { describe, it, expect, beforeEach } from "vitest";
import { createPersistence, type EventRow } from "../persistence";

const exp = { category: "运算错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" };

const errorRow: EventRow = {
  studentId: "stu001", classId: "3A", eventType: "run",
  rawMessage: "division by zero", category: "运算错误",
  subtype: "除数为0", knowledge: "除法运算：除数不能为 0",
  filePath: "a.py", lineNo: 30, exitCode: 1,
  timestamp: "2026-09-17T02:00:00.000Z",
};

describe("persistence（SQLite，:memory:）", () => {
  let p: ReturnType<typeof createPersistence>;
  beforeEach(() => { p = createPersistence(":memory:"); });

  it("upsertStudent 幂等，重复调用不报错", () => {
    p.upsertStudent("stu001", "张三", "3A");
    p.upsertStudent("stu001", "张三", "3A");
  });

  it("insertEvent → getRecentEvents 读回，字段完整", () => {
    p.insertEvent(errorRow);
    const rows = p.getRecentEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].student_id).toBe("stu001");
    expect(rows[0].category).toBe("运算错误");
    expect(rows[0].subtype).toBe("除数为0");
    expect(rows[0].exit_code).toBe(1);
  });

  it("runSuccess 事件：category 存「运行成功」，subtype/knowledge 为空", () => {
    p.insertEvent({ ...errorRow, rawMessage: "run success", category: "运行成功", subtype: null, knowledge: null, exitCode: 0 });
    const row = p.getRecentEvents(1)[0];
    expect(row.category).toBe("运行成功");
    expect(row.subtype).toBeNull();
  });

  it("error_cache：save → 命中读回 → 命中计数累计", () => {
    p.saveCache("hash1", "ZeroDivisionError: division by zero", exp, "llm");
    expect(p.getCachedExplanation("hash1")).toEqual(exp);
    p.getCachedExplanation("hash1");
    expect(p.getCacheStats().totalHits).toBe(2);
    expect(p.getCachedExplanation("nope")).toBeNull();
  });

  it("getEventStats 按 category 分组降序", () => {
    p.insertEvent(errorRow);
    p.insertEvent({ ...errorRow, rawMessage: "x", category: "语法错误", subtype: "缺少冒号", knowledge: "k" });
    p.insertEvent({ ...errorRow, rawMessage: "y", category: "运算错误", subtype: "除数为0", knowledge: "k" });
    const stats = p.getEventStats();
    expect(stats.total).toBe(3);
    expect(stats.byCategory[0]).toEqual({ category: "运算错误", count: 2 });
  });
});
