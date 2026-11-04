<script setup lang="ts">
import { ref, watch } from "vue";
import { useClassroom } from "../stores/classroom";
import { fmtTime, fmtAgo } from "../composables/time";

const store = useClassroom();
const detail = ref<{
  studentId: string; studentName: string;
  events: { ts: number; eventType: string; success: boolean; subtype: string | null; knowledge: string | null; rawMessage: string; codeSnippet?: string; category?: string }[];
  lastActivityAt: number; lastErrorAt: number | null;
} | null>(null);

watch(
  () => store.activeStudentId,
  async (id) => {
    detail.value = null;
    if (!id) return;
    try {
      const res = await fetch(`/api/student/${id}`);
      detail.value = res.ok ? await res.json() : null;
    } catch {
      detail.value = null;
    }
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="store.activeStudentId" class="drawer-mask" @click.self="store.closeDrawer()">
    <aside class="drawer">
      <header>
        <h3>{{ store.activeStudent?.studentName ?? detail?.studentName ?? "未知学生" }}</h3>
        <span class="status" :class="store.activeStudent?.status">{{ store.activeStudent?.status ?? "" }}</span>
        <button class="close" @click="store.closeDrawer()">×</button>
      </header>
      <p v-if="store.activeStudent" class="meta">
        本节课动态 · 停留：{{ fmtAgo(store.activeStudent.lastActivityAt) }}
      </p>
      <div v-if="detail" class="history-wrapper">
        <ul class="history">
          <li v-for="(e, i) in detail.events" :key="i" :class="{ success: e.success }">
            <span class="t">{{ fmtTime(e.ts) }}</span>
            <strong>{{ e.success ? "运行成功" : (e.subtype ?? "") }}</strong>
            <span class="k">{{ e.knowledge ?? "" }}</span>
            <code>{{ e.rawMessage }}</code>
            <pre v-if="e.codeSnippet" class="snippet">{{ e.codeSnippet }}</pre>
          </li>
        </ul>
      </div>
      <button disabled title="V2 开放">发提示</button>
    </aside>
  </div>
</template>

<style scoped>
.drawer-mask { position: fixed; inset: 0; background: rgba(2, 6, 12, 0.6); display: flex; justify-content: flex-end; z-index: 10; }
.drawer {
  width: 380px; height: 100%; padding: 16px; overflow-y: auto;
  background: linear-gradient(180deg, #0c1d38, #060d1a);
  border-left: 1px solid var(--tech-card-border);
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.5);
  color: var(--text-primary);
}
header { display: flex; align-items: center; gap: 8px; }
header h3 { margin: 0; flex: 1; font-size: 16px; }
.status { font-size: 12px; padding: 2px 8px; border-radius: 2px; }
.status.red { background: rgba(255, 95, 109, 0.12); color: var(--tech-red); }
.status.yellow { background: rgba(255, 197, 61, 0.12); color: var(--tech-yellow); }
.status.green { background: rgba(34, 197, 94, 0.12); color: var(--tech-green); }
.status.idle { background: var(--tech-offline); color: var(--text-dim); }
.close { border: none; background: none; font-size: 20px; cursor: pointer; color: var(--text-dim); }
.close:hover { color: var(--text-primary); }
.meta { color: var(--text-dim); font-size: 13px; }
.history-wrapper { margin: 12px 0; }
.history { list-style: none; padding: 0; margin: 0; }
.history li { padding: 8px 0; border-bottom: 1px solid rgba(63, 140, 255, 0.2); display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.history li.success { color: var(--tech-green); }
.history .t { color: var(--text-dim); font-size: 12px; }
.history .k { color: var(--text-dim); }
.history code { font-size: 12px; color: var(--tech-cyan); word-break: break-all; }
.history .snippet { margin: 6px 0; padding: 8px; background: rgba(20, 50, 100, 0.4); border-radius: 2px; font-size: 11px; color: var(--text-primary); white-space: pre-wrap; word-break: break-all; }
</style>