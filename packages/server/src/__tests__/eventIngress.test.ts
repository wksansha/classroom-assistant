import { describe, it, expect } from "vitest";
import { normalize, isDiagRunEvent } from "../eventIngress";

const base = {
  id: "diag:01J0ARZ9V8BABCDE", ts: "2026-10-16T06:31:14.754Z", surface: "diag",
  kind: "diagnostics_change",
  payload: { file: "a.py", samples: ["NameError: name 'x' is not defined"], errors: 1 },
  student_id: "2024001", student_name: "张三", class_id: "3A",
};

describe("normalize（spec §4.1 单一格式）", () => {
  it("diag：派生字段齐全，eventType=diag", () => {
    const ev = normalize(base)!;
    expect(ev.id).toBe(base.id);
    expect(ev.surface).toBe("diag");
    expect(ev.kind).toBe("diagnostics_change");
    expect(ev.studentId).toBe("2024001");
    expect(ev.eventType).toBe("diag");
    expect(ev.success).toBe(false);
    expect(ev.rawMessage).toBe("NameError: name 'x' is not defined");
    expect(ev.cacheKey).toBe("NameError: name 'x' is not defined");
  });

  it("run success（exit_code 0）：success=true、cacheKey=null", () => {
    const ev = normalize({ ...base, id: "run:01J0ARZ9V8BABCDE", surface: "run", kind: "execution_success",
      payload: { command: "python a.py", exit_code: 0 } })!;
    expect(ev.success).toBe(true);
    expect(ev.cacheKey).toBeNull();
    expect(isDiagRunEvent(ev)).toBe(true);
  });

  it("diag 清零（errors:0 无 samples）：success=true、cacheKey=null，不解释不告警", () => {
    const ev = normalize({ ...base, id: "diag:01J0ARZ9V8BABCF0",
      payload: { file: "a.py", errors: 0, warnings: 0 } })!;
    expect(ev.success).toBe(true);
    expect(ev.cacheKey).toBeNull();
    expect(ev.rawMessage).toBe("");
  });

  it("非 diag/run（chat）：eventType undefined，不派生 cacheKey/samples", () => {
    const ev = normalize({ ...base, id: "chat:01J0ARZ9V8BABCDE", surface: "chat", kind: "user_message",
      payload: { text: "你好" }, session_id: "s1" })!;
    expect(isDiagRunEvent(ev)).toBe(false);
    expect(ev.eventType).toBeUndefined();
    expect(ev.cacheKey).toBeNull();
    expect(ev.samples).toEqual([]);
    expect(ev.sessionId).toBe("s1");
  });

  it.each([
    ["缺 id", { ...base, id: undefined }],
    ["id 非 <surface>: 前缀", { ...base, id: "abc123" }],
    ["非法 surface", { ...base, surface: "hack" }],
    ["缺 kind", { ...base, kind: "" }],
  ])("%s → null", (_name, body) => {
    expect(normalize(body)).toBeNull();
  });
});
