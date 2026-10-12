import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { readExerciseContent, buildPublishedList } from "../controllers/assignmentController";
import type { GitService } from "../gitService";

function makeFakeGit(files: Record<string, string>): GitService {
  return {
    async ensureClone() {},
    async alignToRemote() {},
    async hasUnpushedMainCommits() { return false; },
    async pushMain() { return "ok"; },
    async commitAndPushMain() { return "ok"; },
    async createStudentBranches() {},
    async writeToStudentBranch() { return "ok"; },
    async readFileFromMain(rel: string) {
      if (!(rel in files)) throw new Error("not found");
      return files[rel];
    },
    async listFilesFromMain(dirRel: string) {
      return Object.keys(files).filter((k) => k.startsWith(dirRel + "/")).map((k) => k.slice(dirRel.length + 1));
    },
  } as unknown as GitService;
}

describe("content 端点 + published 清单（项目）", () => {
  function seed() {
    const p = createPersistence(":memory:");
    p.replaceRoster([{ studentId: "2025001", studentName: "张三" }]);
    p.upsertAssignment({ id: "a1", title: "第 3 周", week: 3, isPublished: true, createdAt: 1, publishedAt: 1 });
    p.upsertExercise({ id: "ef", assignmentId: "a1", order: 1, filename: "01.py",
      problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1 });
    p.upsertExercise({ id: "ep", assignmentId: "a1", order: 2, filename: "weather-app",
      problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1,
      kind: "project", dir: "weather-app", entry: "main.py" });
    return p;
  }
  const repoFiles: Record<string, string> = {
    "week-03/weather-app/main.py": "# main",
    "week-03/weather-app/utils.py": "# utils",
    "week-03/weather-app/data/city.txt": "BJ",
    "week-03/01.py": "# single",
  };

  it("项目题返回 files 数组（含子目录路径与 entry）", async () => {
    const p = seed();
    const r = await readExerciseContent(p, "", makeFakeGit(repoFiles), "ep");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("project");
    if (r.kind !== "project") return;
    expect(r.dir).toBe("weather-app");
    expect(r.entry).toBe("main.py");
    expect(r.files.map((f) => f.path).sort()).toEqual(["data/city.txt", "main.py", "utils.py"]);
  });
  it("单文件题返回 kind file（响应结构升级）", async () => {
    const p = seed();
    const r = await readExerciseContent(p, "", makeFakeGit(repoFiles), "ef");
    expect(r).toEqual({ ok: true, kind: "file", filename: "01.py", content: "# single" });
  });
  it("published 清单携带 kind/dir/entry", () => {
    const p = seed();
    const list = buildPublishedList(p);
    const proj = list[0].exercises.find((e) => e.id === "ep")!;
    expect(proj.kind).toBe("project");
    expect(proj.dir).toBe("weather-app");
    expect(list[0].exercises.find((e) => e.id === "ef")!.kind ?? "file").toBe("file");
  });
  it("入口文件缺失 → 404", async () => {
    const p = seed();
    const r = await readExerciseContent(p, "", makeFakeGit({ "week-03/weather-app/utils.py": "# u" }), "ep");
    expect(r).toEqual({ ok: false, status: 404, error: "入口文件不存在" });
  });
});
