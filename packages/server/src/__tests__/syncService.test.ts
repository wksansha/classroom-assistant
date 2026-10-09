import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPersistence } from "../persistence";
import { createGitService } from "../gitService";
import { createSyncService } from "../syncService";

let base: string;
let remoteUrl: string;
let teacherDir: string;

const run = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });
const teacherCommit = (msg: string) => {
  run(["add", "-A"], teacherDir);
  run(["-c", "user.name=teacher", "-c", "user.email=t@x", "commit", "-m", msg], teacherDir);
  // 上一个用例的 server 注入可能已推进远端 → push 前先 rebase 同步（测试间共享裸仓）
  run(["pull", "--rebase"], teacherDir);
  run(["push", "origin", "main"], teacherDir);
};
const teacherPull = () => run(["pull", "--rebase"], teacherDir);
const writeTeacher = (rel: string, content: string) => {
  const abs = path.join(teacherDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
};

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "ca-sync-"));
  remoteUrl = path.join(base, "remote.git");
  teacherDir = path.join(base, "teacher");
  run(["init", "--bare", "-b", "main", remoteUrl], base);
  run(["clone", remoteUrl, teacherDir], base);
  run(["-c", "user.name=teacher", "-c", "user.email=t@x", "commit", "--allow-empty", "-m", "init"], teacherDir);
  run(["push", "origin", "main"], teacherDir);
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const BARE = (n: string, desc: string) =>
  `# 题目：${n}\n# 描述：${desc}\n# ===== 代码区 =====\nprint("${n}")\n`;

function makeFixture() {
  const persistence = createPersistence(":memory:");
  const repoDir = path.join(base, `server-${Math.random().toString(36).slice(2)}`);
  const git = createGitService({ repoDir, remoteUrl, authorEmailDomain: "classroom" });
  return { persistence, git, repoDir, sync: createSyncService({ persistence, git, repoDir }) };
}

describe("syncService 四阶段状态机（A19/A28）", () => {
  // Windows 下 git 子进程启动开销大，一次 syncNow 含 10+ 次 git 调用 → 放宽单用例超时
  it("教师推裸文件 → 导入草稿 + 注入回写 main", async () => {
    const { persistence, sync } = makeFixture();
    writeTeacher("week-01/exercise-01.py", BARE("两数之和", "读取两个整数输出和"));
    writeTeacher("week-01/exercise-02.py", BARE("求平均", "读取列表输出均值"));
    teacherCommit("week-01 两题");

    const r = await sync.syncNow();
    expect(r.importedNew).toBe(2);
    expect(r.injected).toBe(2);
    const assignments = persistence.getAssignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0].isPublished).toBe(false);          // 草稿（A18）
    const exercises = persistence.getExercises(assignments[0].id);
    expect(exercises).toHaveLength(2);
    expect(exercises[0].versionHash).toHaveLength(16);

    // 注入回写可见：教师 pull 后文件头部有 exercise-id，与 DB 一致
    run(["pull", "--rebase"], teacherDir);
    const onMain = fs.readFileSync(path.join(teacherDir, "week-01/exercise-01.py"), "utf8");
    expect(onMain).toContain(`# exercise-id: ${exercises[0].id}`);
    expect(onMain).toContain("# week: 1");
  }, 60_000);

  it("重复同步无变化 → 全零；教师改题 → updated+1 且 versionHash 变；A30 警示", async () => {
    const { persistence, sync } = makeFixture();
    writeTeacher("week-02/exercise-01.py", BARE("题A", "描述A"));
    teacherCommit("add week-02");
    await sync.syncNow();

    const again = await sync.syncNow();
    expect(again.importedNew).toBe(0);
    expect(again.injected).toBe(0);
    expect(again.updated).toBe(0);

    // 已发布且有提交的练习被改 → updated + warning（A30）
    const a = persistence.getAssignments().find((x) => x.week === 2)!;
    persistence.setAssignmentPublished(a.id, true, Date.now());
    const ex = persistence.getExercises(a.id)[0];
    persistence.insertSubmission({
      id: "s1", exerciseId: ex.id, studentId: "0001", studentName: "张三",
      code: "print(1)", source: "auto", submittedAt: Date.now(), review: null,
      codeHash: "h", gitSynced: false,
    });
    teacherPull();   // server 上一轮注入已推进远端，教师先同步再改
    writeTeacher("week-02/exercise-01.py", BARE("题A改", "描述改"));
    teacherCommit("edit week-02");
    const r2 = await sync.syncNow();
    expect(r2.updated).toBe(1);
    expect(r2.warnings.some((w) => w.includes("评审基准已切换"))).toBe(true);
    expect(persistence.getExercises(a.id)[0].problemStatement).toContain("题A改");
  }, 60_000);

  it("教师删文件 → 练习下线（isActive=false），历史提交仍可查", async () => {
    const { persistence, sync } = makeFixture();
    writeTeacher("week-03/exercise-01.py", BARE("题X", "描述"));
    teacherCommit("add week-03");
    await sync.syncNow();
    const ex = persistence.getAssignments().find((a) => a.week === 3)!;
    const exId = persistence.getExercises(ex.id)[0].id;

    teacherPull();   // server 上一轮注入已推进远端，教师先同步再删
    fs.rmSync(path.join(teacherDir, "week-03/exercise-01.py"));
    teacherCommit("remove week-03");
    const r = await sync.syncNow();
    expect(r.deactivated).toBe(1);
    expect(persistence.getExercise(exId)?.isActive).toBe(false);   // A20
  }, 60_000);

  it("Phase 4：git_synced=0 的提交被补推到学生分支", async () => {
    const { persistence, git, sync } = makeFixture();
    writeTeacher("week-04/exercise-01.py", BARE("题Y", "描述"));
    teacherCommit("add week-04");
    await sync.syncNow();
    const a = persistence.getAssignments().find((x) => x.week === 4)!;
    const ex = persistence.getExercises(a.id)[0];
    persistence.replaceRoster([{ studentId: "0001", studentName: "张三" }]);
    // 直接落一条未同步提交（模拟 push 失败遗留）
    persistence.insertSubmission({
      id: "s2", exerciseId: ex.id, studentId: "0001", studentName: "张三",
      code: "print('retry-me')", source: "manual", submittedAt: Date.now(), review: null,
      codeHash: "h2", gitSynced: false,
    });
    const r = await sync.syncNow();
    expect(persistence.getUnsyncedSubmissions()).toHaveLength(0);
    run(["fetch", "origin"], teacherDir);
    const content = run(["show", "origin/student-0001:week-04/exercise-01.py"], teacherDir);
    expect(content).toContain("retry-me");
  }, 60_000);
});
