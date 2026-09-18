import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useClassroom } from "../stores/classroom";
import { makeSnapshot } from "./helpers";

describe("classroom store（服务端快照的镜像）", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("applySnapshot / applyUpdate 直接替换快照", () => {
    const s = useClassroom();
    s.applySnapshot(makeSnapshot());
    expect(s.snapshot?.ts).toBe(1);
    s.applyUpdate(makeSnapshot({ ts: 2 }));
    expect(s.snapshot?.ts).toBe(2);
  });

  it("openDrawer / closeDrawer 与 activeStudent getter", () => {
    const s = useClassroom();
    s.applySnapshot(makeSnapshot({
      students: [{
        studentId: "stu001", studentName: "张三", status: "green", priorityScore: 0,
        lastActivityAt: 1, lastErrorAt: null, errorCountTotal: 0, recentErrors: [],
      }],
    }));
    expect(s.activeStudent).toBeNull();
    s.openDrawer("stu001");
    expect(s.activeStudent?.studentName).toBe("张三");
    s.closeDrawer();
    expect(s.activeStudentId).toBeNull();
  });
});