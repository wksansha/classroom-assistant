import { describe, it, expect, beforeEach } from "vitest";
import { createPersistence, type EventRow } from "../persistence";

const exp = { category: "运算错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" };

const errorRow: EventRow = {
  studentId: "stu001", classId: "3A", eventType: "run",
  rawMessage: "division by zero", category: "运算错误",
  subtype: "除数为0", knowledge: "除法运算：除数不能为 0",
  filePath: "a.py", lineNo: 30, exitCode: 1,
  timestamp: "2026-09-17T02:00:00.000Z", codeSnippet: "def divide(a, b):\n    return a / b\n\nprint(divide(10, 0))",
};

describe("persistence（SQLite，:memory:）", () => {
  let p: ReturnType<typeof createPersistence>;
  beforeEach(() => { p = createPersistence(":memory:"); });

  it("insertEvent → getRecentEvents 读回，字段完整（含 code_snippet）", () => {
    p.insertEvent(errorRow);
    const rows = p.getRecentEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].student_id).toBe("stu001");
    expect(rows[0].category).toBe("运算错误");
    expect(rows[0].subtype).toBe("除数为0");
    expect(rows[0].exit_code).toBe(1);
    expect(rows[0].code_snippet).toBe("def divide(a, b):\n    return a / b\n\nprint(divide(10, 0))");
  });

  it("code_snippet 为 undefined 时落库为 null", () => {
    const row = { ...errorRow, codeSnippet: undefined };
    p.insertEvent(row);
    const rows = p.getRecentEvents(1);
    expect(rows[0].code_snippet).toBeNull();
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

describe("花名册单条 CRUD（spec roster §1.2）", () => {
  it("upsertRosterEntry：新增插入；已存在则仅改姓名（主键不变）", () => {
    const p = createPersistence(":memory:");
    p.upsertRosterEntry("0001", "张三");
    expect(p.getRosterEntry("0001")).toEqual({ studentId: "0001", studentName: "张三" });
    p.upsertRosterEntry("0001", "张叁");
    expect(p.getRosterEntry("0001")).toEqual({ studentId: "0001", studentName: "张叁" });
    expect(p.getRoster()).toHaveLength(1);
  });
  it("updateRosterEntry：改姓名；学号不存在返回 false", () => {
    const p = createPersistence(":memory:");
    p.upsertRosterEntry("0001", "张三");
    expect(p.updateRosterEntry("0001", "李四")).toBe(true);
    expect(p.getRosterEntry("0001")).toEqual({ studentId: "0001", studentName: "李四" });
    expect(p.updateRosterEntry("9999", "王五")).toBe(false);
  });
  it("deleteRosterEntry：软删仅移出名册，student_tokens 保留（spec §1.1 关键语义）", () => {
    const p = createPersistence(":memory:");
    p.upsertRosterEntry("0001", "张三");
    p.saveStudentToken("0001", "tok-1");
    expect(p.deleteRosterEntry("0001")).toBe(true);
    expect(p.getRosterEntry("0001")).toBeNull();
    expect(p.getStudentToken("0001")).toBe("tok-1");   // 凭证保留：重新导入时 F4 幂等跳过建号
    expect(p.deleteRosterEntry("0001")).toBe(false);
  });
  it("purgeRosterEntry：名册行 + student_tokens 一并清除，幂等可重复", () => {
    const p = createPersistence(":memory:");
    p.upsertRosterEntry("0001", "张三");
    p.saveStudentToken("0001", "tok-1");
    p.purgeRosterEntry("0001");
    expect(p.getRosterEntry("0001")).toBeNull();
    expect(p.getStudentToken("0001")).toBeNull();
    expect(() => p.purgeRosterEntry("0001")).not.toThrow();   // 幂等
  });
});
