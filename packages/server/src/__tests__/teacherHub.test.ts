import { describe, it, expect, vi } from "vitest";
import { createTeacherHub } from "../teacherHub";
import type { TeacherSnapshot } from "@classroom/shared";

const snap: TeacherSnapshot = {
  ts: 1, classId: "3A", students: [], alerts: [],
  alertSummary: "其余 0 人正常", aggregates: [], suggestions: [],
};

function fakeRes() {
  return {
    writes: [] as string[],
    headers: null as Record<string, string> | null,
    writeHead(_s: number, h: Record<string, string>) { this.headers = h; },
    write(c: string) { this.writes.push(c); return true; },
  };
}
function fakeReq() {
  return {
    closeCb: null as null | (() => void),
    on(ev: string, cb: () => void) { if (ev === "close") this.closeCb = cb; },
  };
}
function parseSse(chunk: string) {
  return JSON.parse(chunk.replace(/^data: /, "").trim());
}

describe("teacherHub（SSE）", () => {
  it("连接即推 snapshot，SSE 响应头正确", () => {
    const hub = createTeacherHub(() => snap);
    const res = fakeRes();
    hub.handleStream(fakeReq() as any, res as any);
    expect(res.headers?.["Content-Type"]).toBe("text/event-stream");
    expect(res.headers?.["Cache-Control"]).toBe("no-cache");
    expect(res.writes).toHaveLength(1);
    const msg = parseSse(res.writes[0]);
    expect(msg.type).toBe("snapshot");
    expect(msg.data).toEqual(snap);
    expect(res.writes[0].endsWith("\n\n")).toBe(true); // SSE 消息必须空行结尾
  });

  it("publish 广播 update 给全部客户端", () => {
    const hub = createTeacherHub(() => snap);
    const r1 = fakeRes(); const r2 = fakeRes();
    hub.handleStream(fakeReq() as any, r1 as any);
    hub.handleStream(fakeReq() as any, r2 as any);
    hub.publish(snap);
    for (const r of [r1, r2]) {
      expect(parseSse(r.writes.at(-1)!).type).toBe("update");
    }
    expect(hub.clientCount()).toBe(2);
  });

  it("客户端断开（close 回调触发）后不再接收广播", () => {
    const hub = createTeacherHub(() => snap);
    const req = fakeReq();
    const res = fakeRes();
    hub.handleStream(req as any, res as any);
    req.closeCb!();
    hub.publish(snap);
    expect(res.writes).toHaveLength(1); // 只有连接时的 snapshot
  });

  it("write 抛错（死连接）时移除该客户端，不影响其他客户端", () => {
    const hub = createTeacherHub(() => snap);
    const dead = { ...fakeRes(), write() { throw new Error("broken pipe"); } };
    const alive = fakeRes();
    hub.handleStream(fakeReq() as any, dead as any);
    hub.handleStream(fakeReq() as any, alive as any);
    expect(() => hub.publish(snap)).not.toThrow();
    expect(parseSse(alive.writes.at(-1)!).type).toBe("update");
  });

  it("心跳：25s 后向客户端发送注释行", () => {
    vi.useFakeTimers();
    const hub = createTeacherHub(() => snap);
    const res = fakeRes();
    hub.handleStream(fakeReq() as any, res as any);
    hub.startHeartbeat();
    vi.advanceTimersByTime(25_000);
    expect(res.writes.at(-1)).toBe(": ping\n\n");
    vi.useRealTimers();
  });
});