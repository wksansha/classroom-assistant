<script setup lang="ts">
import { ref, watch } from "vue";
import { useClassroom } from "../stores/classroom";
import { fmtTime, fmtAgo } from "../composables/time";

const store = useClassroom();
const detail = ref<{
  studentId: string; studentName: string;
  events: { ts: number; eventType: string; success: boolean; subtype: string | null; knowledge: string | null; rawMessage: string }[];
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
        停留：{{ fmtAgo(store.activeStudent.lastActivityAt) }}
      </p>
      <ul v-if="detail" class="history">
        <li v-for="(e, i) in detail.events" :key="i" :class="{ success: e.success }">
          <span class="t">{{ fmtTime(e.ts) }}</span>
          <strong>{{ e.success ? "运行成功" : e.subtype }}</strong>
          <span class="k">{{ e.knowledge ?? "" }}</span>
          <code>{{ e.rawMessage }}</code>
        </li>
      </ul>
      <button disabled title="V2 开放">发提示</button>
    </aside>
  </div>
</template>

<style scoped>
.drawer-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.3); display: flex; justify-content: flex-end; z-index: 10; }
.drawer { width: 380px; background: var(--card); height: 100%; padding: 16px; overflow-y: auto; box-shadow: -4px 0 16px rgba(0, 0, 0, 0.1); }
header { display: flex; align-items: center; gap: 8px; }
header h3 { margin: 0; flex: 1; }
.status { font-size: 12px; padding: 2px 8px; border-radius: 4px; }
.status.red { background: #fef2f2; color: var(--red); }
.status.yellow { background: #fffbeb; color: var(--yellow); }
.status.green { background: #f0fdf4; color: var(--green); }
.close { border: none; background: none; font-size: 20px; cursor: pointer; }
.meta { color: var(--muted); font-size: 13px; }
.history { list-style: none; padding: 0; margin: 12px 0; }
.history li { padding: 8px 0; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.history li.success { color: var(--green); }
.history .t { color: var(--muted); font-size: 12px; }
.history .k { color: var(--muted); }
.history code { font-size: 12px; color: var(--accent); word-break: break-all; }
</style>