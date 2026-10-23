<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useClassroom } from "../stores/classroom";

const store = useClassroom();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onUnmounted(() => { if (timer) clearInterval(timer); });

const stats = computed(() => store.snapshot?.stats ?? { online: 0, total: 0, needHelp: 0, runs: 0 });
const dateText = computed(() => new Date(now.value).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" }));
const clock = computed(() => new Date(now.value).toLocaleTimeString("zh-CN", { hour12: false }));
</script>

<template>
  <header class="status-bar">
    <h1>课堂教学实时助教</h1>
    <div class="stats">
      <div class="stat"><span class="num">{{ stats.online }}</span><span class="label">在线 / {{ stats.total }} 人</span></div>
      <div class="stat warn"><span class="num">{{ stats.needHelp }}</span><span class="label">急需帮助</span></div>
      <div class="stat"><span class="num">{{ stats.runs }}</span><span class="label">运行次数</span></div>
    </div>
    <span class="date">{{ dateText }}</span>
    <span class="clock">{{ clock }}</span>
    <span class="conn" :class="store.sseConnected ? 'on' : 'off'">
      {{ store.sseConnected ? "已连接" : "连接中断，重试中…" }}
    </span>
  </header>
</template>

<style scoped>
.status-bar { display: flex; align-items: center; gap: 24px; background: #1e293b; color: #fff; padding: 10px 20px; }
.status-bar h1 { font-size: 20px; margin: 0; white-space: nowrap; }
.stats { display: flex; gap: 32px; flex: 1; justify-content: center; }
.stat { display: flex; align-items: baseline; gap: 6px; }
.stat .num { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; }
.stat .label { font-size: 13px; opacity: 0.75; white-space: nowrap; }
.stat.warn .num { color: #f87171; }
.date { font-size: 16px; white-space: nowrap; opacity: 0.9; }
.clock { font-size: 16px; font-variant-numeric: tabular-nums; }
.conn { font-size: 12px; white-space: nowrap; }
.conn.on { color: #4ade80; }
.conn.off { color: #f87171; }
</style>
