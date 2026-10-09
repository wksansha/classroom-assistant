import { describe, it, expect } from "vitest";
import { createStateManager } from "../stateManager";
import type { NormalizedEvent, Explanation } from "@classroom/shared";

const exp: Explanation = { category: "运算错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" };

function errorEvent(studentId: string, ts: number, subtype = "除数为0"): NormalizedEvent {
  return {
    studentId, studentName: `学生${studentId}`, classId: "3A", eventType: "run", success: false,
    errorType: "ZeroDivisionError", errorMessage: "division by zero", samples: [],
    rawMessage: "division by zero", cacheKey: "ZeroDivisionError: division by zero",
    exitCode: 1, ts, codeSnippet: "def divide(a, b):\n    return a / b\n\nprint(divide(10, 0))",
  };
}

function successEvent(studentId: string, ts: number): NormalizedEvent {
  return {
    studentId, studentName: `学生${studentId}`, classId: "3A", eventType: "run", success: true,
    errorType: "RunSuccess", errorMessage: "", samples: [], rawMessage: "run success",
    cacheKey: null, exitCode: 0, ts,
  };
}

describe("stateManager（内存课堂状态）", () => {
  it("首个事件自动建档", () => {
    const sm = createStateManager();
    sm.apply(errorEvent("stu001", 1000), exp);
    const r = sm.listRecords();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ studentId: "stu001", studentName: "学生stu001", consecutiveErrors: 1, lastErrorAt: 1000, lastActivityAt: 1000 });
    expect(r[0].events[0].subtype).toBe("除数为0");
    expect(r[0].events[0].category).toBe("运算错误");
    expect(r[0].events[0].codeSnippet).toBe("def divide(a, b):\n    return a / b\n\nprint(divide(10, 0))");
  });

  it("成功运行清零 consecutiveErrors（spec §5：绿色=最近有成功运行）", () => {
    const sm = createStateManager();
    sm.apply(errorEvent("stu001", 1000), exp);
    sm.apply(errorEvent("stu001", 2000), exp);
    expect(sm.listRecords()[0].consecutiveErrors).toBe(2);
    sm.apply(successEvent("stu001", 3000), null);
    const r = sm.listRecords()[0];
    expect(r.consecutiveErrors).toBe(0);
    expect(r.lastErrorAt).toBe(2000);       // 成功不清除 lastErrorAt
    expect(r.lastActivityAt).toBe(3000);
    expect(r.events[2].category).toBe("运行成功"); // success 事件 category
  });

  it("事件序列上限 200，超出保留最新", () => {
    const sm = createStateManager();
    for (let i = 0; i < 205; i++) sm.apply(errorEvent("stu001", i), exp);
    const r = sm.listRecords()[0];
    expect(r.events).toHaveLength(200);
    expect(r.events[0].ts).toBe(5);         // 最早的 5 条被丢弃
    expect(r.events[199].ts).toBe(204);
  });

  it("getStudentDetail：未知学生返回 null；返回记录含最近事件", () => {
    const sm = createStateManager();
    sm.apply(errorEvent("stu001", 1000), exp);
    expect(sm.getStudentDetail("nope")).toBeNull();
    const d = sm.getStudentDetail("stu001");
    expect(d?.events).toHaveLength(1);
    expect(d?.lastActivityAt).toBe(1000);
  });
});
