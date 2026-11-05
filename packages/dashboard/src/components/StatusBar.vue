<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useClassroom } from "../stores/classroom";

const store = useClassroom();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onUnmounted(() => { if (timer) clearInterval(timer); });

const stats = computed(() => store.snapshot?.stats ?? { online: 0, total: 0, needHelp: 0, runs: 0, errors: 0 });
const dateText = computed(() => new Date(now.value).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" }));
const clock = computed(() => new Date(now.value).toLocaleTimeString("zh-CN", { hour12: false }));
</script>

<template>
  <header class="status-bar">
    <div class="stats">
      <div class="stat"><span class="num">{{ stats.online }}</span><span class="label">在线 / {{ stats.total }} 人</span></div>
      <div class="stat warn"><span class="num">{{ stats.needHelp }}</span><span class="label">急需帮助</span></div>
      <div class="stat"><span class="num">{{ stats.runs }}</span><span class="label">运行次数</span></div>
      <div class="stat err"><span class="num">{{ stats.errors }}</span><span class="label">报错总数</span></div>
    </div>
    <h1>课堂教学实时助教</h1>
    <div class="meta">
      <span class="date">{{ dateText }}</span>
      <span class="clock">{{ clock }}</span>
      <span class="conn" :class="store.sseConnected ? 'on' : 'off'">
        {{ store.sseConnected ? "已连接" : "连接中断，重试中…" }}
      </span>
    </div>
  </header>
</template>

<style scoped>
.status-bar {
  position: relative; display: flex; align-items: center; justify-content: space-between;
  gap: 16px; padding: 10px 20px 14px;
  background: var(--tech-card-grad); border: 1px solid var(--tech-card-border);
  border-radius: 2px; box-shadow: var(--tech-card-glow); overflow: hidden;
}
.status-bar::after {
  content: ""; position: absolute; bottom: 0; left: 6%; right: 6%; height: 2px;
  background: linear-gradient(90deg, transparent, var(--tech-blue) 20%, var(--tech-cyan) 50%, var(--tech-blue) 80%, transparent);
  box-shadow: 0 0 10px rgba(80, 180, 255, 0.9);
}
.status-bar h1 {
  margin: 0; font-size: 20px; font-weight: 800; letter-spacing: 6px; white-space: nowrap;
  color: var(--text-primary); text-shadow: 0 0 14px rgba(64, 156, 255, 0.9), 0 0 30px rgba(64, 156, 255, 0.5);
}
.stats { display: flex; gap: 12px; }
.stat {
  display: flex; align-items: baseline; gap: 5px; padding: 3px 10px;
  background: rgba(20, 50, 100, 0.4); border: 1px solid rgba(63, 140, 255, 0.3); border-radius: 2px;
}
.stat .num { font-family: var(--font-num); font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--tech-cyan); text-shadow: 0 0 8px rgba(80, 220, 255, 0.8); }
.stat .label { font-size: 12px; color: var(--text-dim); white-space: nowrap; }
.stat.warn .num { color: var(--tech-red); text-shadow: 0 0 8px rgba(255, 95, 109, 0.8); }
.stat.err .num { color: var(--tech-red); text-shadow: 0 0 8px rgba(255, 95, 109, 0.8); }
.meta { display: flex; align-items: center; gap: 10px; }
.date { font-size: 12px; color: var(--text-dim); white-space: nowrap; }
.clock { font-size: 12px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.conn { font-size: 12px; white-space: nowrap; }
.conn.on { color: var(--tech-green); }
.conn.off { color: var(--tech-red); }
</style>
