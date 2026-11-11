<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ActivityFeedItem, TeacherSnapshot } from "@classroom/shared";
import { useClassroom } from "../stores/classroom";

const store = useClassroom();

/* —— 展示列表（不直接绑快照）：新条目识别 + 悬浮暂停缓冲 ——
 * 快照全量替换（V1 语义），按 id diff 出新条目；悬浮期间新条目进 pending，
 * 移开后一次性补入并打进入动画（保证正在看的行与代码卡不跳动） */
const displayed = ref<ActivityFeedItem[]>([]);
const enteringIds = ref(new Set<string>());
const seenIds = new Set<string>();
const pending = ref<ActivityFeedItem[]>([]);

const hoverPause = ref(false);
const popHover = ref(false);
const hoverCount = ref(0);

const pendingCount = computed(() => (hoverPause.value ? pending.value.length : 0));

function applyNew(items: ActivityFeedItem[], animate: boolean) {
  if (!items.length) return;
  const fresh = items.filter((i) => !seenIds.has(i.id));
  if (!fresh.length) return;
  fresh.forEach((i) => seenIds.add(i.id));
  displayed.value = [...fresh, ...displayed.value].slice(0, 30);
  if (animate) {
    enteringIds.value = new Set([...enteringIds.value, ...fresh.map((i) => i.id)]);
    setTimeout(() => {
      const s = new Set(enteringIds.value);
      fresh.forEach((i) => s.delete(i.id));
      enteringIds.value = s;
    }, 1600);
  }
}

watch(
  () => store.snapshot,
  (snap: TeacherSnapshot | null) => {
    if (!snap) return;
    const latest = snap.activityFeed ?? [];
    if (hoverPause.value) {
      pending.value.push(...latest.filter((i) => !seenIds.has(i.id) && !pending.value.some((p) => p.id === i.id)));
    } else {
      applyNew(latest, true);
    }
  },
);

/* —— 悬浮即暂停；离开延迟收起 ——
 * 行与代码卡之间有 14px 间隙，且代码卡要能移入滚动：离开行不立即销毁，
 * 延迟到期且指针既不在行上也不在卡上，才收起并一次性恢复动态流 */
let hideTimer: ReturnType<typeof setTimeout> | null = null;
const HIDE_DELAY_MS = 200;

function cancelHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}
function scheduleHide() {
  cancelHide();
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (hoverCount.value > 0 || popHover.value) return;
    hidePop();
    if (hoverPause.value) { hoverPause.value = false; applyNew(pending.value.splice(0), true); }
  }, HIDE_DELAY_MS);
}
function onRowEnter(item: ActivityFeedItem) {
  hoverCount.value += 1;
  hoverPause.value = true;
  cancelHide();
  showPop(item);
}
function onRowLeave() {
  hoverCount.value = Math.max(0, hoverCount.value - 1);
  scheduleHide();
}
function onPopEnter() {
  popHover.value = true;
  cancelHide();
}
function onPopLeave() {
  popHover.value = false;
  scheduleHide();
}
/* —— 安全网：Chromium 偶发不派发 mouseleave 边界事件（实测），指针离开「行+代码卡」即安排收起并恢复流，
 * 不依赖 mouseleave 是否送达。rAF 节流，pointermove 被动监听不影响滚动性能 —— */
function onDocPointerMove(e: PointerEvent) {
  if (!pop.value) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest?.(".lb-row") || t?.closest?.(".code-pop")) return;
  if (hoverCount.value > 0) hoverCount.value = 0;
  popHover.value = false;
  scheduleHide();
}
let rafId = 0;
function onDocMove(e: PointerEvent) {
  if (!pop.value || rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; onDocPointerMove(e); });
}
onMounted(() => document.addEventListener("pointermove", onDocMove, { passive: true }));
onBeforeUnmount(() => {
  document.removeEventListener("pointermove", onDocMove);
  if (rafId) cancelAnimationFrame(rafId);
  cancelHide();
});

/* —— 心跳条：从展示列表按生聚合最近 8 次（混排运行+评审，最新在最右）—— */
const heartbeatMap = computed(() => {
  const m = new Map<string, string[]>();
  for (const it of displayed.value) {
    const arr = m.get(it.studentId);
    if (arr) { if (arr.length < 8) arr.push(it.kind); }
    else m.set(it.studentId, [it.kind]);
  }
  for (const arr of m.values()) arr.reverse();   // 旧的在前，最新在最右
  return m;
});
const heartbeatOf = (studentId: string): string[] => heartbeatMap.value.get(studentId) ?? [];

/* —— 代码卡懒加载（内存缓存 per studentId|filePath）—— */
interface PopState { item: ActivityFeedItem; x: number; y: number; title: string | null; code: string | null }
const pop = ref<PopState | null>(null);
const codeCache = new Map<string, { title: string | null; code: string | null }>();

function showPop(item: ActivityFeedItem) {
  const el = document.querySelector(`[data-feed-id="${CSS.escape(item.id)}"]`) as HTMLElement | null;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const left = rect.right + 14;
  const width = 460;
  pop.value = {
    item,
    x: left + width > window.innerWidth ? Math.max(8, rect.left - width - 14) : left,
    y: Math.min(Math.max(10, rect.top - 40), Math.max(10, window.innerHeight - 380)),
    title: item.title,
    code: codeCache.get(`${item.studentId}|${item.filePath ?? ""}`)?.code ?? null,
  };
  const key = `${item.studentId}|${item.filePath ?? ""}`;
  if (!codeCache.has(key)) {
    codeCache.set(key, { title: item.title, code: null });   // 占位防重复请求
    fetch(`/api/feed/code?studentId=${encodeURIComponent(item.studentId)}&filePath=${encodeURIComponent(item.filePath ?? "")}`)
      .then((r) => (r.ok ? r.json() : { code: null }))
      .then((data: { title: string | null; code: string | null }) => {
        codeCache.set(key, { title: data.title ?? item.title, code: data.code });
        if (pop.value?.item.id === item.id) pop.value = { ...pop.value, title: data.title, code: data.code };
      })
      .catch(() => { /* 懒加载失败静默：代码卡显示占位文案 */ });
  }
}
function hidePop() { pop.value = null; }

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const EVT_LABEL: Record<string, string> = { run_ok: "运行成功", run_fail: "运行失败", review_pass: "AI 评审通过", review_fail: "AI 评审未通过" };
const isRun = (kind: string) => kind === "run_ok" || kind === "run_fail";

/* 首载快照（含重启回放数据）：直接铺开不打动画 */
onMounted(() => {
  const snap = store.snapshot;
  if (snap?.activityFeed?.length) applyNew(snap.activityFeed, false);
});
</script>

<template>
  <section class="event-feed tech-card" v-if="store.snapshot">
    <div class="feed-head">
      <h2 class="tech-title">课堂动态</h2>
      <span v-if="pendingCount" class="pause-badge">⏸ 已暂停 · {{ pendingCount }} 条新动态</span>
      <span class="llm-badge" :class="{ degraded: !store.snapshot.reviewOnline }">
        {{ store.snapshot.reviewOnline ? "AI在线评审" : "AI降级 · 仅显示运行" }}
      </span>
    </div>

    <p v-if="!displayed.length" class="empty">等待学员动态…</p>
    <div v-else class="feed-list">
      <div
        v-for="it in displayed"
        :key="it.id"
        :data-feed-id="it.id"
        class="lb-row"
        :class="{ entering: enteringIds.has(it.id) }"
        @mouseenter="onRowEnter(it)"
        @mouseleave="onRowLeave"
      >
        <span class="avatar" :class="it.kind">{{ it.studentName[0] }}</span>
        <div class="lb-body">
          <div class="lb-line1">
            <span class="lb-name">{{ it.studentName }}</span>
            <span class="lb-act" :class="it.kind">{{ EVT_LABEL[it.kind] }}</span>
            <span class="lb-try" :class="{ hot: it.attempt >= 3 }">第{{ it.attempt }}次{{ isRun(it.kind) ? "运行" : "评审" }}</span>
            <span class="hb" title="该生最近 8 次动态">
              <i v-for="(k, idx) in heartbeatOf(it.studentId)" :key="idx" :class="[k, { 'hb-latest': idx === heartbeatOf(it.studentId).length - 1 }]" />
            </span>
            <span class="lb-time">{{ fmtTime(it.ts) }}</span>
          </div>
          <div v-if="it.reason" class="lb-reason">
            <span class="k-tag" :class="isRun(it.kind) ? 'warn' : 'err'">{{ it.reasonTag }}</span>{{ it.reason }}
          </div>
        </div>
      </div>
    </div>

    <!-- 悬浮代码卡（懒加载评审输入） -->
    <teleport to="body">
      <div
        v-if="pop"
        class="code-pop"
        :style="{ left: pop.x + 'px', top: pop.y + 'px' }"
        @mouseenter="onPopEnter"
        @mouseleave="onPopLeave"
      >
        <div class="pop-head">
          <span class="stu">{{ pop.item.studentName }}</span>
          <span>·</span>
          <span class="file">{{ pop.title ?? "题目" }} · 第{{ pop.item.attempt }}次{{ isRun(pop.item.kind) ? "运行" : "评审" }}</span>
          <span class="pop-kind">{{ isRun(pop.item.kind) ? "运行" : "评审输入" }}</span>
        </div>
        <pre v-if="pop.code">{{ pop.code.split("\n").slice(0, 40).map((l, i) => `${String(i + 1).padStart(2)}  ${l}`).join("\n") }}</pre>
        <p v-else class="pop-empty">暂无代码缓存（评审后可得）</p>
      </div>
    </teleport>
  </section>
</template>

<style scoped>
.event-feed {
  padding: 12px 10px 8px; display: flex; flex-direction: column; gap: 8px;
  min-height: 0; contain: size;   /* 脱离内容撑高：高度由矩阵行决定，与矩阵等高 */
}
/* 标题独占流内居中；两个徽章绝对定位钉两侧——出现/消失（含 1fr min-content 撑宽问题）均不影响标题位置 */
.feed-head { position: relative; display: flex; justify-content: center; align-items: center; padding: 0 6px; }
.llm-badge {
  position: absolute; right: 6px;
  font-family: var(--font-num); font-size: 13px; font-weight: 700; letter-spacing: 1px;
  padding: 3px 10px; border-radius: 2px; white-space: nowrap;
  background: rgba(63, 169, 255, 0.15); color: var(--tech-cyan); border: 1px solid var(--tech-blue);
  text-shadow: 0 0 8px rgba(80, 220, 255, 0.8);
  animation: badge-glow 2.4s ease-in-out infinite;
}
.llm-badge.degraded { background: rgba(90, 120, 160, 0.15); color: var(--text-dim); border-color: rgba(90, 120, 160, 0.4); text-shadow: none; animation: none; }
@keyframes badge-glow { 0%, 100% { box-shadow: 0 0 4px rgba(63, 169, 255, 0.3); } 50% { box-shadow: 0 0 12px rgba(63, 169, 255, 0.6); } }
.pause-badge {
  position: absolute; left: 6px;
  font-size: 13px; font-weight: 700; padding: 3px 10px; border-radius: 2px; white-space: nowrap;
  background: rgba(255, 197, 61, 0.12); color: var(--tech-yellow); border: 1px solid rgba(255, 197, 61, 0.45);
}
.feed-list { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; display: flex; flex-direction: column; padding: 0 4px; }
.feed-list::-webkit-scrollbar { display: none; }

.lb-row {
  display: flex; align-items: center; gap: 11px; padding: 8px 6px; cursor: default;
  border-radius: 4px; transition: background 0.12s; position: relative; flex: none;
}
.lb-row:hover { background: rgba(63, 140, 255, 0.1); }
.lb-row.entering { animation: lb-in 0.35s ease-out, lb-pulse 1.4s ease-out; }
@keyframes lb-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes lb-pulse { 0% { background: rgba(63, 169, 255, 0.3); } 100% { background: transparent; } }
.lb-row:hover.entering { animation: none; }

.avatar {
  width: 34px; height: 34px; border-radius: 50%; flex: none;
  display: flex; align-items: center; justify-content: center;
  font-size: 15px; font-weight: 700; color: var(--text-primary);
  position: relative; background: rgba(20, 50, 100, 0.5);
}
.avatar::after {
  content: ""; position: absolute; right: -1px; bottom: -1px; width: 13px; height: 13px;
  border-radius: 50%; border: 2px solid rgba(6, 14, 30, 0.9);
}
.avatar.run_ok::after { background: var(--tech-cyan); box-shadow: 0 0 6px rgba(124, 231, 255, 0.8); }
.avatar.run_fail::after { background: var(--tech-yellow); box-shadow: 0 0 6px rgba(255, 197, 61, 0.8); }
.avatar.review_pass::after { background: var(--tech-green); box-shadow: 0 0 6px rgba(34, 197, 94, 0.8); }
.avatar.review_fail::after { background: var(--tech-red); box-shadow: 0 0 6px rgba(255, 95, 109, 0.8); }
.avatar.review_fail { animation: av-blink 1.2s ease-in-out 3; }
@keyframes av-blink { 50% { box-shadow: 0 0 10px rgba(255, 95, 109, 0.5); } }

.lb-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.lb-line1 { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.lb-name { font-size: 14.5px; font-weight: 700; white-space: nowrap; }
.lb-act { font-size: 13.5px; font-weight: 700; white-space: nowrap; }
.lb-act.run_ok { color: var(--tech-cyan); } .lb-act.run_fail { color: var(--tech-yellow); }
.lb-act.review_pass { color: var(--tech-green); } .lb-act.review_fail { color: var(--tech-red); }
.lb-try { font-size: 12px; color: var(--text-dim); white-space: nowrap; }
.lb-try.hot { color: var(--tech-yellow); text-shadow: 0 0 6px rgba(255, 197, 61, 0.5); }
.lb-time { font-family: var(--font-num); font-size: 12px; color: var(--text-dim); margin-left: auto; font-variant-numeric: tabular-nums; }

.hb { display: inline-flex; gap: 2px; align-items: center; align-self: center; flex: none; }
.hb i { width: 8px; height: 4px; border-radius: 1px; background: rgba(90, 120, 160, 0.25); }
.hb i.run_ok { background: var(--tech-cyan); }
.hb i.run_fail { background: var(--tech-yellow); }
.hb i.review_pass { background: var(--tech-green); height: 6px; box-shadow: 0 0 4px rgba(34, 197, 94, 0.7); }
.hb i.review_fail { background: var(--tech-red); height: 6px; box-shadow: 0 0 4px rgba(255, 95, 109, 0.7); }
.hb i.hb-latest { animation: hb-pop 0.4s ease-out; }
@keyframes hb-pop { 50% { transform: scaleY(2.4); } }

.lb-reason { font-size: 12.5px; color: var(--text-secondary); line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lb-reason .k-tag { display: inline-block; font-size: 11px; padding: 0 6px; margin-right: 6px; border-radius: 2px; vertical-align: 1px; }
.lb-reason .k-tag.warn { background: rgba(255, 197, 61, 0.12); color: var(--tech-yellow); border: 1px solid rgba(255, 197, 61, 0.4); }
.lb-reason .k-tag.err { background: rgba(255, 95, 109, 0.12); color: var(--tech-red); border: 1px solid rgba(255, 95, 109, 0.35); }

.empty { color: var(--text-dim); font-size: 14px; text-align: center; margin: auto 0; letter-spacing: 2px; }

/* 悬浮代码卡（teleport 到 body，scoped 样式需 :deep 不适用——直接写全局选择器权重） */
</style>
<style>
/* 代码卡 teleport 到 body，脱离 scoped 作用域，用独立类名避免污染 */
.code-pop {
  position: fixed; z-index: 100; width: 460px; max-width: 44vw;
  background: rgba(6, 14, 30, 0.97); border: 1px solid rgba(63, 169, 255, 0.5);
  border-radius: 3px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6), 0 0 18px rgba(63, 140, 255, 0.25);
}
.code-pop .pop-head {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid rgba(63, 140, 255, 0.2); font-size: 12px; color: #9fd4ff;
}
.code-pop .pop-head .stu { font-weight: 700; color: #7ce7ff; }
.code-pop .pop-head .file { font-family: var(--font-num, monospace); color: #5d7fa6; }
.code-pop .pop-head .pop-kind { margin-left: auto; color: #5d7fa6; }
.code-pop pre {
  margin: 0; padding: 10px 12px; max-height: 300px; overflow-y: auto;
  font-family: "Cascadia Mono", Consolas, monospace; font-size: 12.5px; line-height: 1.6;
  color: #bfe3ff; white-space: pre-wrap; word-break: break-all;
  scrollbar-width: thin; scrollbar-color: rgba(63, 140, 255, 0.4) transparent;
}
.code-pop .pop-empty { margin: 0; padding: 18px 12px; font-size: 13px; color: #5d7fa6; text-align: center; }
</style>
