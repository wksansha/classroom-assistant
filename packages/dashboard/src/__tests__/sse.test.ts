import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { connectClassroom } from "../api/sse";
import { useClassroom } from "../stores/classroom";
import { makeSnapshot } from "./helpers";

class FakeES {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) { this.url = url; }
  close() { this.closed = true; }
}

describe("connectClassroom（断线 5s 重连，重连先拉 summary 对齐——spec §8）", () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.useFakeTimers(); });

  it("连接：先拉 summary 对齐，再建 EventSource", async () => {
    const store = useClassroom();
    const es = new FakeES("/api/stream/teacher");
    const stop = connectClassroom(store, {
      fetchSummary: async () => makeSnapshot({ ts: 1 }),
      createEventSource: () => es as any,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.snapshot?.ts).toBe(1);
    expect(es.url).toBe("/api/stream/teacher");
    stop();
  });

  it("收到 snapshot / update 消息 → 更新 store", async () => {
    const store = useClassroom();
    const es = new FakeES("");
    connectClassroom(store, {
      fetchSummary: async () => makeSnapshot({ ts: 1 }),
      createEventSource: () => es as any,
    });
    await vi.advanceTimersByTimeAsync(0);
    es.onmessage!({ data: JSON.stringify({ type: "update", data: makeSnapshot({ ts: 2 }) }) });
    expect(store.snapshot?.ts).toBe(2);
  });

  it("onerror：关闭连接，5s 后重连并重新对齐 summary", async () => {
    const store = useClassroom();
    const fetchSummary = vi.fn().mockResolvedValue(makeSnapshot({ ts: 1 }));
    const es1 = new FakeES("");
    let current = es1;
    const stop = connectClassroom(store, {
      fetchSummary,
      createEventSource: () => { const e = current; current = new FakeES(""); return e as any; },
      retryDelayMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    es1.onerror!();
    expect(es1.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchSummary).toHaveBeenCalledTimes(2);
    stop();
  });
});