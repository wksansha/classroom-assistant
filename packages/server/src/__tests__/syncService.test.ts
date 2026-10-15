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
  // 上一个用例的服务端操作可能已推进远端 → push 前先 rebase 同步（测试间共享裸仓）
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
}, 60_000);   // 默认 hook 超时 10s：全量并发下（git 密集测试文件并行）git 进程排队可超
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const BARE = (n: string, desc: string) =>
  `# 题目：${n}\n# 描述：${desc}\n# ===== 代码区 =====\nprint("${n}")\n`;

function makeFixture() {
  const persistence = createPersistence(":memory:");
  const repoDir = path.join(base, `server-${Math.random().toString(36).slice(2)}`);
  const git = createGitService({ repoDir, remoteUrl, authorEmailDomain: "classroom" });
  return { persistence, git, repoDir, sync: createSyncService({ persistence, git, repoDir }) };
}

describe("syncService 只读对账（push 即布置，spec §2.1/§6.3）", () => {
  // Windows 下 git 子进程启动开销大，一次 syncNow 含 10+ 次 git 调用 → 放宽单用例超时
  it("教师推裸文件 → 导入作业（标题=目录名）+ 练习；不回写教师仓库", async () => {
    const { persistence, sync } = makeFixture();
    writeTeacher("week-01/exercise-01.py", BARE("两数之和", "读取两个整数输出和"));
    writeTeacher("week-01/exercise-02.py", BARE("求平均", "读取列表输出均值"));
    teacherCommit("week-01 两题");

    const r = await sync.syncNow();
    expect(r.importedNew).toBe(2);
    const assignments = persistence.getAssignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0].title).toBe("week-01");              // 标题默认 = 目录名
    expect(assignments[0].weekDir).toBe("week-01");
    expect(assignments[0].week).toBe(1);
    const exercises = persistence.getExercises(assignments[0].id);
    expect(exercises).toHaveLength(2);
    expect(exercises[0].versionHash).toHaveLength(16);

    // 只读不回写：教师 pull 后裸文件未被注入 exercise-id，远端无服务端提交
    teacherPull();
    const onMain = fs.readFileSync(path.join(teacherDir, "week-01/exercise-01.py"), "utf8");
    expect(onMain).toBe(BARE("两数之和", "读取两个整数输出和"));
    expect(onMain).not.toContain("exercise-id");
  }, 60_000);

  it("目录名放宽：任意一级子目录可导入（lesson5），. / _ 开头或无特征目录排除", async () => {
    const { persistence, sync } = makeFixture();
    writeTeacher("lesson5/a.py", BARE("题L", "描述L"));
    writeTeacher("lesson5/weather-app/exercise.json", `{ "title": "天气", "entry": "main.py" }`);
    writeTeacher("lesson5/weather-app/main.py", "# 题目：做天气\n# ===== 代码区 =====\nprint('hi')\n");
    writeTeacher("_drafts/skip.py", BARE("草稿", "不导入"));
    writeTeacher(".hidden/skip.py", BARE("隐藏", "不导入"));
    writeTeacher("empty-dir/readme.md", "无 .py 无 manifest → 排除");
    teacherCommit("lesson5 + 噪声目录");

    const r = await sync.syncNow();
    expect(r.importedNew).toBe(4);   // lesson5×2 + 上个用例遗留的 week-01×2（共享远端、每用例独立 :memory: 库重新导入）
    const asg = persistence.getAssignments().find((a) => a.weekDir === "lesson5")!;
    expect(asg).toBeTruthy();
    expect(asg.title).toBe("lesson5");
    const exs = persistence.getExercises(asg.id);
    expect(exs.map((e) => e.filename).sort()).toEqual(["a.py", "weather-app"]);
    expect(exs.find((e) => e.kind === "project")?.dir).toBe("weather-app");
    // 排除目录不建作业
    expect(persistence.getAssignments().filter((a) => a.weekDir === "_drafts" || a.weekDir === ".hidden" || a.weekDir === "empty-dir")).toHaveLength(0);
    // week-N 目录优先取目录名数字，非 week-N 目录自增接续
    expect(persistence.getAssignments().find((a) => a.weekDir === "week-01")?.week).toBe(1);
    expect(asg.week).toBe(2);
  }, 60_000);

  it("重复同步无变化 → 全零；教师改题 → updated+1 且 versionHash 变；A30 警示（有提交即警示）", async () => {
    const { persistence, sync } = makeFixture();
    writeTeacher("week-02/exercise-01.py", BARE("题A", "描述A"));
    teacherCommit("add week-02");
    await sync.syncNow();

    const again = await sync.syncNow();
    expect(again.importedNew).toBe(0);
    expect(again.updated).toBe(0);

    // 有提交记录（notify 索引行）的练习被改 → updated + warning（A30；push 即布置，不再看发布状态）
    const a = persistence.getAssignments().find((x) => x.week === 2)!;
    const ex = persistence.getExercises(a.id)[0];
    persistence.replaceRoster([{ studentId: "0001", studentName: "张三" }]);
    persistence.insertNotifyRow({
      id: "n1", exerciseId: ex.id, studentId: "0001", studentName: "张三",
      commitHash: "c1", filesJson: "[]", submittedAt: Date.now(),
    });
    teacherPull();   // 教师先同步再改
    writeTeacher("week-02/exercise-01.py", BARE("题A改", "描述改"));
    teacherCommit("edit week-02");
    const r2 = await sync.syncNow();
    expect(r2.updated).toBe(1);
    expect(r2.warnings.some((w) => w.includes("评审基准已切换"))).toBe(true);
    expect(persistence.getExercises(a.id)[0].problemStatement).toContain("题A改");
  }, 60_000);

  it("教师删文件 → 练习下线（isActive=false）", async () => {
    const { persistence, sync } = makeFixture();
    writeTeacher("week-03/exercise-01.py", BARE("题X", "描述"));
    teacherCommit("add week-03");
    await sync.syncNow();
    const ex = persistence.getAssignments().find((a) => a.week === 3)!;
    const exId = persistence.getExercises(ex.id)[0].id;

    teacherPull();
    fs.rmSync(path.join(teacherDir, "week-03/exercise-01.py"));
    teacherCommit("remove week-03");
    const r = await sync.syncNow();
    expect(r.deactivated).toBe(1);
    expect(persistence.getExercise(exId)?.isActive).toBe(false);
  }, 60_000);
});
