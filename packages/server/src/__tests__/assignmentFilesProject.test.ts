// packages/server/src/__tests__/assignmentFilesProject.test.ts
import { describe, it, expect } from "vitest";
import {
  isProjectIgnoredEntry, parseExerciseManifest,
  computeProjectVersionHash,
} from "../assignmentFiles";

describe("项目 manifest", () => {
  it("解析教师 manifest（title/entry，缺 id/week）", () => {
    const m = parseExerciseManifest(`{ "title": "天气", "entry": "main.py" }`);
    expect(m).toEqual({ exerciseId: null, week: null, title: "天气", entry: "main.py" });
  });
  it("entry 缺省 main.py；含注入 id", () => {
    const m = parseExerciseManifest(`{ "exerciseId": "id-1", "week": 3 }`);
    expect(m!.entry).toBe("main.py");
    expect(m!.exerciseId).toBe("id-1");
  });
  it("非法 JSON → null", () => {
    expect(parseExerciseManifest("not json")).toBeNull();
  });
  it("忽略清单", () => {
    expect(isProjectIgnoredEntry("__pycache__", true)).toBe(true);
    expect(isProjectIgnoredEntry(".venv", true)).toBe(true);
    expect(isProjectIgnoredEntry("venv", true)).toBe(true);
    expect(isProjectIgnoredEntry(".git", true)).toBe(true);
    expect(isProjectIgnoredEntry("x.pyc", false)).toBe(true);
    expect(isProjectIgnoredEntry(".DS_Store", false)).toBe(true);
    expect(isProjectIgnoredEntry("main.py", false)).toBe(false);
    expect(isProjectIgnoredEntry("data", true)).toBe(false);
  });
  it("项目哈希与顺序无关", () => {
    const a = [{ path: "a.py", content: "1" }, { path: "b.py", content: "2" }];
    const b = [{ path: "b.py", content: "2" }, { path: "a.py", content: "1" }];
    expect(computeProjectVersionHash(a)).toBe(computeProjectVersionHash(b));
    expect(computeProjectVersionHash(a)).toMatch(/^[0-9a-f]{16}$/);
  });
});
