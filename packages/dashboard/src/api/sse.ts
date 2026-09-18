import type { TeacherSnapshot } from "@classroom/shared";

interface StoreLike {
  applySnapshot(s: TeacherSnapshot): void;
  applyUpdate(s: TeacherSnapshot): void;
  sseConnected: boolean;
}

export interface SseDeps {
  createEventSource?: (url: string) => EventSource;
  fetchSummary?: () => Promise<TeacherSnapshot>;
  retryDelayMs?: number;
}

export function connectClassroom(store: StoreLike, deps: SseDeps = {}) {
  const createES = deps.createEventSource ?? ((url: string) => new EventSource(url));
  const fetchSummary =
    deps.fetchSummary ??
    (async () => {
      const r = await fetch("/api/summary");
      if (!r.ok) throw new Error(`summary ${r.status}`);
      return (await r.json()) as TeacherSnapshot;
    });
  const retryMs = deps.retryDelayMs ?? 5000;

  let es: EventSource | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function start() {
    // 首载/重连先拉 summary 对齐（spec §8：断线重连成功先补齐快照）
    try {
      store.applySnapshot(await fetchSummary());
    } catch {
      /* 服务未起：走 EventSource 错误分支重试 */
    }
    if (stopped) return;
    es = createES("/api/stream/teacher");
    es.onopen = () => { store.sseConnected = true; };
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "snapshot") store.applySnapshot(msg.data);
      else store.applyUpdate(msg.data);
    };
    es.onerror = () => {
      store.sseConnected = false;
      es?.close();
      es = null;
      if (!stopped && timer === null) {
        timer = setTimeout(() => { timer = null; void start(); }, retryMs);
      }
    };
  }

  void start();
  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    es?.close();
  };
}