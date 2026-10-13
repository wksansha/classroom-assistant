// packages/server/src/__tests__/weekDir.test.ts
// week 目录名宽容归一：非补零目录名（如 week-5）→ week_dir 落库，content/归档/发布清单使用实际目录名
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPersistence } from "../persistence";
import { createSyncService } from "../syncService";
import { createGitService } from "../gitService";
import type { GitService } from "../gitService";
import { readExerciseContent, buildPublishedList } from "../controllers/assignmentController";

// 内容读取假 git：Record<string,string> 内存仓（同 contentProject.test.ts）
function makeContentGit(files: Record<string, string>): GitService {
  return {
    async ensureClone() {},
    async alignToRemote() {},
    async hasUnpushedMainCommits() { return false; },
    async pushMain() { return "ok" as const; },
    async commitAndPushMain() { return "ok" as const; },
    async createStudentBranches() {},
    async writeToStudentBranch() { return "ok" as const; },
    async readFileFromMain(rel: string) {
      if (!(rel in files)) throw new Error("not found");
      return files[rel];
    },
    async listFilesFromMain(dirRel: string) {
      return Object.keys(files).filter((k) => k.startsWith(dirRel + "/")).map((k) => k.slice(dirRel.length + 1));
    },
  } as unknown as GitService;
}

// 同步假 git：记录注入回写（同 syncProject.test.ts）
function makeSyncGit(): GitService & { injections: { path: string; content: string }[][] } {
  const g = {
    injections: [] as { path: string; content: string }[][],
    async ensureClone() {},
    async alignToRemote() {},
    async hasUnpushedMainCommits() { return false; },
    async pushMain() { return "ok" as const; },
    async commitAndPushMain(files: { path: string; content: string }[]) { g.injections.push(files); return "ok" as const; },
    async createStudentBranches() {},
    async writeToStudentBranch() { return "ok" as const; },
    async readFileFromMain() { return ""; },
    async listFilesFromMain() { return []; },
  };
  return g as unknown as GitService & typeof g;
}

const makeRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), "weekdir-repo-"));
// 合法可解析的入口文件（同 syncProject.test.ts 头部约定）
const ENTRY = "# -*- coding: utf-8 -*-\n# ===== classroom-assistant =====\n# ===============================\n# 题目：做天气\n# ===== 代码区 =====\nprint('hi')\n";

function seedProject(repoDir: string, weekDirName: string) {
  fs.mkdirSync(path.join(repoDir, weekDirName, "app"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, weekDirName, "app", "exercise.json"), `{ "title": "天气", "entry": "main.py" }`);
  fs.writeFileSync(path.join(repoDir, weekDirName, "app", "main.py"), ENTRY);
}

describe("week 目录名宽容归一（week_dir 落库）", () => {
  it("非补零目录 week-5 → 同步后 assignment.weekDir = week-5，项目练习正常导入", async () => {
    const repoDir = makeRepo();
    seedProject(repoDir, "week-5");
    const p = createPersistence(":memory:");
    const r = await createSyncService({ persistence: p, git: makeSyncGit(), repoDir }).syncNow();

    const a = p.getAssignments()[0];
    expect(a.week).toBe(5);
    expect(a.weekDir).toBe("week-5");
    const ex = p.getExercises(a.id).find((e) => e.kind === "project");
    expect(ex).toBeTruthy();
    expect(ex!.dir).toBe("app");
    expect(r.importedNew).toBe(1);
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("content 读取按实际目录名 week-5 取文件（补零路径会 404）", async () => {
    const p = createPersistence(":memory:");
    p.upsertAssignment({ id: "a1", title: "第 5 周作业", week: 5, isPublished: true, createdAt: 1, publishedAt: 1 });
    p.setAssignmentWeekDir("a1", "week-5");
    p.upsertExercise({ id: "ep", assignmentId: "a1", order: 1, filename: "app",
      problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1,
      kind: "project", dir: "app", entry: "main.py" });
    const git = makeContentGit({ "week-5/app/main.py": "# main" });

    const r = await readExerciseContent(p, "", git, "ep");
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== "project") return;
    expect(r.files).toEqual([{ path: "main.py", content: "# main" }]);
  });

  it("published 清单行携带 weekDir", () => {
    const p = createPersistence(":memory:");
    p.upsertAssignment({ id: "a1", title: "t", week: 5, isPublished: true, createdAt: 1 });
    p.setAssignmentWeekDir("a1", "week-5");
    const list = buildPublishedList(p);
    expect(list).toHaveLength(1);
    expect(list[0].weekDir).toBe("week-5");
  });

  it("week_dir 缺省（DB-only 周）→ content 回退补零名 week-05", async () => {
    const p = createPersistence(":memory:");
    p.upsertAssignment({ id: "a1", title: "t", week: 5, isPublished: true, createdAt: 1, publishedAt: 1 });
    p.upsertExercise({ id: "ef", assignmentId: "a1", order: 1, filename: "01.py",
      problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1 });
    const git = makeContentGit({ "week-05/01.py": "# single" });
    const r = await readExerciseContent(p, "", git, "ef");
    expect(r).toEqual({ ok: true, kind: "file", filename: "01.py", content: "# single" });
  });
});

describe("week_dir 归档路径（writeToStudentBranch）", () => {
  let base: string;
  let remoteUrl: string;
  let teacherDir: string;
  const run = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "weekdir-git-"));
    remoteUrl = path.join(base, "remote.git");
    teacherDir = path.join(base, "teacher");
    run(["init", "--bare", "-b", "main", remoteUrl], base);
    run(["clone", remoteUrl, teacherDir], base);
    run(["-c", "user.name=teacher", "-c", "user.email=t@x", "commit", "--allow-empty", "-m", "init"], teacherDir);
    run(["push", "origin", "main"], teacherDir);
  });
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  it("项目归档 + 单文件归档均落在 week-5/ 下，提交信息含 week-5/", async () => {
    const git = createGitService({ repoDir: path.join(base, "server-clone"), remoteUrl, authorEmailDomain: "classroom" });
    await git.ensureClone();
    await git.createStudentBranches(["0001"]);

    const proj = await git.writeToStudentBranch({
      studentId: "0001", studentName: "张三", week: 5, weekDir: "week-5",
      filename: "app", content: "print('hi')\n",
      files: [{ path: "main.py", content: "print('hi')\n" }],
    });
    expect(proj).toBe("ok");
    run(["fetch", "origin"], teacherDir);
    expect(run(["show", "origin/student-0001:week-5/app/main.py"], teacherDir)).toContain("hi");
    const projLog = run(["log", "-1", "--format=%s", "origin/student-0001"], teacherDir);
    expect(projLog).toContain("week-5/app/");

    const single = await git.writeToStudentBranch({
      studentId: "0001", studentName: "张三", week: 5, weekDir: "week-5",
      filename: "01.py", content: "print('single')\n",
    });
    expect(single).toBe("ok");
    run(["fetch", "origin"], teacherDir);
    expect(run(["show", "origin/student-0001:week-5/01.py"], teacherDir)).toContain("single");
    const singleLog = run(["log", "-1", "--format=%s", "origin/student-0001"], teacherDir);
    expect(singleLog).toContain("week-5/01.py");
  }, 60_000);
});

describe("week 目录名重复检测", () => {
  it("week-5 与 week-05 并存 → 警告推送，补零名 week-05 优先落库", async () => {
    const repoDir = makeRepo();
    seedProject(repoDir, "week-5");
    seedProject(repoDir, "week-05");
    const p = createPersistence(":memory:");
    const r = await createSyncService({ persistence: p, git: makeSyncGit(), repoDir }).syncNow();

    expect(r.warnings.some((w) => w.includes("week-5") && w.includes("week-05") && w.includes("重复"))).toBe(true);
    const a = p.getAssignments()[0];
    expect(a.week).toBe(5);
    expect(a.weekDir).toBe("week-05");
    fs.rmSync(repoDir, { recursive: true, force: true });
  });
});
