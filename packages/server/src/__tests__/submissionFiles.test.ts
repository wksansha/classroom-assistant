// packages/server/src/__tests__/submissionFiles.test.ts
import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { createSubmission, validateFiles, type SubmissionDeps } from "../controllers/submissionController";
import type { GitService } from "../gitService";
import type { SSEMessage } from "@classroom/shared";

function makeDeps(p = createPersistence(":memory:")) {
  const sse: SSEMessage[] = [];
  const gitArgs: unknown[] = [];
  const git = {
    async ensureClone() {}, async alignToRemote() {}, async hasUnpushedMainCommits() { return false; },
    async pushMain() { return "ok"; }, async commitAndPushMain() { return "ok"; },
    async createStudentBranches() {},
    async writeToStudentBranch(args: unknown) { gitArgs.push(args); return "ok"; },
    async readFileFromMain() { return ""; }, async listFilesFromMain() { return []; },
  } as unknown as GitService;
  const deps: SubmissionDeps = { persistence: p, git, publish: (m) => sse.push(m) };
  return { p, deps, sse, gitArgs };
}

function seed(p: ReturnType<typeof createPersistence>) {
  p.replaceRoster([{ studentId: "2025001", studentName: "张三" }]);
  p.upsertAssignment({ id: "a1", title: "t", week: 3, isPublished: true, createdAt: 1, publishedAt: 1 });
  p.upsertExercise({ id: "ef", assignmentId: "a1", order: 1, filename: "01.py",
    problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1 });
  p.upsertExercise({ id: "ep", assignmentId: "a1", order: 2, filename: "weather-app",
    problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1,
    kind: "project", dir: "weather-app", entry: "main.py" });
}

describe("提交纯归档（files）", () => {
  it("项目题提交：入库 files + git 归档传 files + SSE + review 为 null", () => {
    const { p, deps, sse, gitArgs } = makeDeps();
    seed(p);
    const files = [{ path: "main.py", content: "m" }, { path: "utils.py", content: "u" }];
    const r = createSubmission(deps, {
      exerciseId: "ep", studentId: "2025001", studentName: "张三",
      code: "m", filePath: "week-03/weather-app/main.py", source: "manual", files,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.submission.review).toBeNull();   // 纯归档
    expect(r.submission.files).toEqual(files);
    expect(sse.some((m) => m.type === "submission_received")).toBe(true);
    expect(gitArgs.length).toBe(1);
    expect((gitArgs[0] as { files?: unknown }).files).toEqual(files);
  });

  it("项目题幂等：同 files 重复提交 created=false 且不再归档", () => {
    const { p, deps, gitArgs } = makeDeps();
    seed(p);
    const files = [{ path: "main.py", content: "m" }];
    const input = { exerciseId: "ep" as const, studentId: "2025001", studentName: "张三",
      code: "m", filePath: "x", source: "manual" as const, files };
    const first = createSubmission(deps, input);
    expect(first.ok ? first.created : false).toBe(true);      // 等价于 created ?? false（TS 需按 ok 收窄）
    const second = createSubmission(deps, input);
    expect(second.ok ? second.created : true).toBe(false);    // 等价于 created ?? true
    expect(gitArgs.length).toBe(1);
  });

  it("校验链：项目缺 files / code 与入口不一致 / 路径穿越 / 单文件带 files 均拒绝", () => {
    const { p, deps } = makeDeps();
    seed(p);
    expect(createSubmission(deps, { exerciseId: "ep", studentId: "2025001", studentName: "张三",
      code: "m", source: "manual" } as never).ok).toBe(false);
    expect(createSubmission(deps, { exerciseId: "ep", studentId: "2025001", studentName: "张三",
      code: "WRONG", source: "manual", files: [{ path: "main.py", content: "m" }] }).ok).toBe(false);
    expect(createSubmission(deps, { exerciseId: "ep", studentId: "2025001", studentName: "张三",
      code: "m", source: "manual", files: [{ path: "../evil.py", content: "x" }, { path: "main.py", content: "m" }] }).ok).toBe(false);
    expect(createSubmission(deps, { exerciseId: "ef", studentId: "2025001", studentName: "张三",
      code: "s", source: "manual", files: [{ path: "01.py", content: "s" }] }).ok).toBe(false);
  });

  it("validateFiles 边界：空/超50个/超100KB/超500KB", () => {
    expect(validateFiles([])).toBeTruthy();
    expect(validateFiles(Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.py`, content: "x" })))).toBeTruthy();
    expect(validateFiles([{ path: "big.py", content: "a".repeat(101 * 1024) }])).toBeTruthy();
    expect(validateFiles(Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.py`, content: "a".repeat(90 * 1024) })))).toBeTruthy();
    expect(validateFiles([{ path: "ok.py", content: "x" }])).toBeNull();
  });

  it("单文件题旧行为完全保留（无 files）", () => {
    const { p, deps } = makeDeps();
    seed(p);
    const r = createSubmission(deps, { exerciseId: "ef", studentId: "2025001", studentName: "张三",
      code: "print(1)", source: "manual" });
    expect(r.ok && r.created).toBe(true);
  });
});
