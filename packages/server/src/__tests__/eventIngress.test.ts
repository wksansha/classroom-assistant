import { describe, it, expect } from "vitest";
import { normalize } from "../eventIngress";

const TS = "2026-09-17T02:00:00.000Z";

describe("normalize：L1 / flat 双格式 → NormalizedEvent", () => {
  it("L1 run 报错：cacheKey = error_type + error_message", () => {
    const ev = normalize({
      surface: "run", kind: "execution_error", ts: TS,
      payload: {
        student_id: "stu001", student_name: "张三", class_id: "3A",
        source: "terminal", command: "python a.py", exit_code: 1,
        error_type: "ZeroDivisionError", error_message: "division by zero",
        file: "a.py", line: 30,
        code_snippet: "def divide(a, b):\\n    return a / b\\n\\nprint(divide(10, 0))",
      },
    });
    expect(ev).toMatchObject({
      studentId: "stu001", studentName: "张三", classId: "3A",
      eventType: "run", success: false, errorType: "ZeroDivisionError",
      cacheKey: "ZeroDivisionError: division by zero",
      filePath: "a.py", lineNo: 30,
      codeSnippet: "def divide(a, b):\\n    return a / b\\n\\nprint(divide(10, 0))",
      ts: Date.parse(TS),
    });
  });

  it("L1 diag：errorType 为 null，cacheKey 取最短样本", () => {
    const ev = normalize({
      surface: "diag", kind: "diagnostic", ts: TS,
      payload: {
        student_id: "stu001", student_name: "张三", class_id: "3A",
        file: "a.py", errors: 1, warnings: 0,
        samples: ["name 'x' is not defined", "x"],
        code_snippet: "result = totl + 1\\nreturn result",
      },
    });
    expect(ev).toMatchObject({
      eventType: "diag", success: false, errorType: null,
      cacheKey: "x", rawMessage: "name 'x' is not defined",
      codeSnippet: "result = totl + 1\\nreturn result",
    });
  });

  it("flat run 报错（reporter.ts 格式）", () => {
    const ev = normalize({
      student_id: "stu002", student_name: "李四", class_id: "3A",
      timestamp: TS, event_type: "run",
      raw_message: "division by zero", error_type: "ZeroDivisionError",
      error_message: "division by zero", command: "python a.py",
      exit_code: 1, file_path: "a.py", line_no: 30, source: "terminal",
      code_snippet: "def divide(a, b):\\n    return a / b\\n\\nprint(divide(10, 0))",
    });
    expect(ev).toMatchObject({
      studentId: "stu002", eventType: "run", success: false,
      cacheKey: "ZeroDivisionError: division by zero",
      codeSnippet: "def divide(a, b):\\n    return a / b\\n\\nprint(divide(10, 0))",
    });
  });

  it("flat runSuccess（error_type=RunSuccess, exit_code=0）：success=true，cacheKey=null", () => {
    const ev = normalize({
      student_id: "stu002", student_name: "李四", class_id: "3A",
      timestamp: TS, event_type: "run", raw_message: "run success",
      error_type: "RunSuccess", error_message: "", exit_code: 0,
      code_snippet: "print(\"Hello\")",
    });
    expect(ev).toMatchObject({ eventType: "run", success: true, cacheKey: null, codeSnippet: "print(\"Hello\")" });
  });

  it("flat 格式 student_id 缺失 → studentId 为 null（让路由层返回 400），studentName 兜底 unknown", () => {
    const ev = normalize({ event_type: "run", raw_message: "x", error_type: "NameError", error_message: "x" });
    expect(ev).toMatchObject({ studentId: null, studentName: "unknown", classId: "default" });
  });

  it("L1 格式 student_id 缺失 → studentId 为 null（让路由层返回 400）", () => {
    const ev = normalize({ surface: "run", kind: "execution_error", ts: TS, payload: { error_type: "NameError", error_message: "x" } });
    expect(ev).toMatchObject({ studentId: null, classId: "default" });
  });

  it("无效上报（无 surface/payload 也无 event_type）：返回 null", () => {
    expect(normalize({ foo: 1 })).toBeNull();
    expect(normalize(null)).toBeNull();
  });
});
