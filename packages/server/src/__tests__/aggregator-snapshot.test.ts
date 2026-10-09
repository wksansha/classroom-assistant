import { describe, it, expect } from "vitest";
import { createAggregator } from "../aggregator";
import type { StudentRecord, StoredEvent } from "../stateManager";

const NOW = Date.parse("2026-09-17T04:00:00.000Z");
const MIN = 60_000;

function err(ts: number, subtype: string, category = "类型错误"): StoredEvent {
  return { ts, eventType: "run", success: false, subtype, category, knowledge: "知识点", rawMessage: "m" };
}

function student(id: string, name: string, events: StoredEvent[], consecutiveErrors = events.filter(e => !e.success).length): StudentRecord {
  const errors = events.filter(e => !e.success);
  return {
    studentId: id, studentName: name, classId: "3A", events,
    lastActivityAt: errors.at(-1)?.ts ?? NOW,
    lastErrorAt: errors.at(-1)?.ts ?? null,
    consecutiveErrors,
  };
}

describe("recompute：完整快照", () => {
  it("students 字段：状态色、分数、最近 3 条错误（新的在前）", () => {
    const events = [1, 2, 3, 4].map(i => err(NOW - i * MIN, `子类${i}`));
    const rec = student("stu001", "张三", events);
    const snap = createAggregator().recompute([rec], NOW);
    expect(snap.students[0]).toMatchObject({ studentId: "stu001", studentName: "张三", errorCountTotal: 4 });
    expect(snap.students[0].recentErrors).toHaveLength(3);
    expect(snap.students[0].recentErrors[0].subtype).toBe("子类4");
  });

  it("告警取前 5 名 + alertSummary（未进榜的报警学生不计入「正常」）", () => {
    const recs = Array.from({ length: 7 }, (_, i) =>
      student(`stu00${i + 1}`, `学生${i}`, [err(NOW - MIN, "缺少冒号")]));
    const snap = createAggregator().recompute(recs, NOW);
    expect(snap.alerts).toHaveLength(5);
    // 7 人全部报错（分数>0），top5 之外的 2 人不是「正常」→ 正常人数为 0
    expect(snap.alertSummary).toBe("其余 0 人正常");
    expect(snap.alerts[0].subtype).toBe("缺少冒号");
  });

  it("聚合按 subtype 分组，count 为人数且降序，携带名单", () => {
    const recs = [
      student("stu001", "张三", [err(NOW - MIN, "缺少冒号")]),
      student("stu002", "李四", [err(NOW - MIN, "缺少冒号"), err(NOW - 2 * MIN, "缺少冒号")]), // 同人同 subtype 仍算 1 人
      student("stu003", "王五", [err(NOW - MIN, "意外缩进")]),
    ];
    const agg = createAggregator().recompute(recs, NOW).aggregates;
    expect(agg[0]).toMatchObject({ subtype: "缺少冒号", count: 2 });
    expect(agg[0].students.map(s => s.studentName)).toEqual(["张三", "李四"]);
    expect(agg[1]).toMatchObject({ subtype: "意外缩进", count: 1 });
  });

  it("建议规则：≥40% 全班讲评；≥20% 小组讨论；连续≥3 单独辅导", () => {
    // 10 人班：stu1-4 报「缺少冒号」(4/7=57%→class-review)
    //          stu5-6 报「意外缩进」(2/7=29%→group-discuss)
    //          stu7 连续 3 次不同 subtype（→individual）
    //          分母=7（上报过错误的学生），stu8-10 无错误
    const recs = [
      ...[1, 2, 3, 4].map(i => student(`stu00${i}`, `学生${i}`, [err(NOW - MIN, "缺少冒号")])),
      ...[5, 6].map(i => student(`stu00${i}`, `学生${i}`, [err(NOW - MIN, "意外缩进")])),
      student("stu007", "学生7", [1, 2, 3].map(i => err(NOW - i * MIN, `甲${i}`))),
      student("stu008", "学生8", []), student("stu009", "学生9", []), student("stu010", "学生10", []),
    ];
    const snap = createAggregator().recompute(recs, NOW);
    const ids = snap.suggestions.map(s => s.id);
    expect(ids).toContain("class-review:缺少冒号");
    expect(ids).toContain("group-discuss:意外缩进");
    expect(ids).toContain("individual:stu007");
    const cr = snap.suggestions.find(s => s.id === "class-review:缺少冒号")!;
    expect(cr.text).toBe("⚠️ 4 人卡在「缺少冒号」，建议全班讲评");
    const ind = snap.suggestions.find(s => s.id === "individual:stu007")!;
    expect(ind.text).toBe("🙋 学生7 连续报错，建议单独辅导");
  });

  it("ack 后建议标记已处理（内存态）", () => {
    const agg = createAggregator();
    const recs = [student("stu001", "张三", [err(NOW - MIN, "缺少冒号")])];
    agg.ack("class-review:缺少冒号");
    const snap = agg.recompute(recs, NOW);
    const s = snap.suggestions.find(x => x.id === "class-review:缺少冒号");
    expect(s?.acked).toBe(true);
  });
});
