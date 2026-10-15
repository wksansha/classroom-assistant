// packages/server/src/__tests__/syncProject.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPersistence } from "../persistence";
import { createSyncService } from "../syncService";
import type { GitService } from "../gitService";

// 最小假 git：GitService 已瘦身为只读对齐（ensureClone/alignToRemote），写路径在接口层不存在
function makeFakeGit(): GitService {
  return {
    async ensureClone() {},
    async alignToRemote() {},
  };
}

describe("syncService 项目扫描", () => {
  let repoDir: string;
  beforeEach(() => { repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-")); });
  afterEach(() => { fs.rmSync(repoDir, { recursive: true, force: true }); });

  it("识别项目目录：入库 kind/dir/entry；无 manifest 的子目录警告；不回写", async () => {
    fs.mkdirSync(path.join(repoDir, "week-3", "weather-app", "data"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "week-3", "weather-app", "exercise.json"),
      `{ "title": "天气", "entry": "main.py" }`);
    fs.writeFileSync(path.join(repoDir, "week-3", "weather-app", "main.py"),
      "# -*- coding: utf-8 -*-\n# ===== classroom-assistant =====\n# ===============================\n# 题目：做天气\n# ===== 代码区 =====\nprint('hi')\n");
    fs.writeFileSync(path.join(repoDir, "week-3", "weather-app", "utils.py"), "def f(): pass\n");
    fs.writeFileSync(path.join(repoDir, "week-3", "weather-app", "data", "city.txt"), "BJ\n");
    fs.mkdirSync(path.join(repoDir, "week-3", "weather-app", "__pycache__"));
    fs.writeFileSync(path.join(repoDir, "week-3", "weather-app", "__pycache__", "x.pyc"), "bin");
    fs.mkdirSync(path.join(repoDir, "week-3", "notes"));   // 无 manifest：忽略+警告

    const p = createPersistence(":memory:");
    const git = makeFakeGit();
    const sync = createSyncService({ persistence: p, git, repoDir });
    const r = await sync.syncNow();

    const ex = p.getExercises(p.getAssignments()[0].id).find((e) => e.kind === "project");
    expect(ex).toBeTruthy();
    expect(ex!.filename).toBe("weather-app");
    expect(ex!.dir).toBe("weather-app");
    expect(ex!.entry).toBe("main.py");
    expect(ex!.problemStatement).toContain("做天气");
    expect(r.importedNew).toBe(1);
    expect(r.warnings.some((w) => w.includes("notes"))).toBe(true);   // 无 manifest 警告
  });

  it("manifest id 优先（exerciseId 退化为 exercises 表内部主键）；versionHash 变更计入 updated", async () => {
    fs.mkdirSync(path.join(repoDir, "week-3", "app2"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "week-3", "app2", "exercise.json"),
      `{ "exerciseId": "fixed-id", "week": 3, "entry": "main.py" }`);
    fs.writeFileSync(path.join(repoDir, "week-3", "app2", "main.py"), "print(1)\n");
    const p = createPersistence(":memory:");
    const git = makeFakeGit();
    await createSyncService({ persistence: p, git, repoDir }).syncNow();
    const ex = p.getExercises(p.getAssignments()[0].id).find((e) => e.dir === "app2")!;
    expect(ex.id).toBe("fixed-id");
    fs.writeFileSync(path.join(repoDir, "week-3", "app2", "main.py"), "print(2)\n");
    const r2 = await createSyncService({ persistence: p, git, repoDir }).syncNow();
    expect(r2.updated).toBe(1);
  });
});
