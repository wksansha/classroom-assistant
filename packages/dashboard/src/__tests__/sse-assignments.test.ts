import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TeacherSnapshot } from "@classroom/shared";
import { connectClassroom } from "../api/sse";

const emptySnapshot: TeacherSnapshot = {
  ts: 0, classId: "c", students: [], alerts: [], alertSummary: "", aggregates: [], suggestions: [],
};

class FakeEventSource {
  static last: FakeEventSource;
  onopen: () => void = () => {};
  onmessage: (e: { data: string }) => void = () => {};
  onerror: () => void = () => {};
  close() {}
  constructor(_url: string) { FakeEventSource.last = this; }
}

function makeStore() {
  return {
    applySnapshot: vi.fn(), applyUpdate: vi.fn(), sseConnected: false,
  };
}

describe("connectClassroom 消息分发（A29/A21）", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("submission_received/review_complete 转发给 onAssignmentMessage，不进监控 store", async () => {
    const store = makeStore();
    const onAssignment = vi.fn();
    connectClassroom(store as never, {
      createEventSource: (url) => { void url; return new FakeEventSource() as unknown as EventSource; },
      fetchSummary: async () => emptySnapshot,
      onAssignmentMessage: onAssignment,
    });
    await vi.advanceTimersByTimeAsync(0); // start() 先 await fetchSummary 再建 EventSource
    const msg = { type: "submission_received", data: { submissionId: "s1", exerciseId: "e1", studentId: "0001", assignmentId: "a1", submittedAt: 1 } };
    FakeEventSource.last.onmessage({ data: JSON.stringify(msg) });
    expect(onAssignment).toHaveBeenCalledWith(msg.data);
    expect(store.applyUpdate).not.toHaveBeenCalled();     // 不灌监控 store
    expect(store.applySnapshot).toHaveBeenCalledTimes(1);  // 仅初始 summary
  });
  it("未知类型静默忽略；snapshot/update 照旧", async () => {
    const store = makeStore();
    connectClassroom(store as never, {
      createEventSource: () => new FakeEventSource() as unknown as EventSource,
      fetchSummary: async () => emptySnapshot,
    });
    await vi.advanceTimersByTimeAsync(0);
    FakeEventSource.last.onmessage({ data: JSON.stringify({ type: "future_unknown", data: { x: 1 } }) });
    FakeEventSource.last.onmessage({ data: JSON.stringify({ type: "update", data: emptySnapshot }) });
    expect(store.applyUpdate).toHaveBeenCalledTimes(1); // 未知类型未灌监控 store（A29）
    expect(store.applyUpdate).toHaveBeenCalledWith(emptySnapshot);
    expect(store.applySnapshot).toHaveBeenCalledTimes(1); // 未知类型未触发额外 snapshot
  });
});
