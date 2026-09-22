<script setup lang="ts">
import { computed } from "vue";
import { useClassroom } from "../stores/classroom";
import { fmtTime } from "../composables/time";
import type { RecentError } from "@classroom/shared";

const store = useClassroom();

const statusCounts = computed(() => {
  const counts = { red: 0, yellow: 0, green: 0 };
  for (const s of store.snapshot?.students ?? []) {
    counts[s.status]++;
  }
  return counts;
});

function tooltip(recent: RecentError[]): string {
  return recent.map((r) => `${fmtTime(r.ts)} ${r.subtype}｜${r.knowledge}`).join("\n") || "暂无错误";
}
</script>

<template>
  <section class="matrix" v-if="store.snapshot">
    <div class="header">
      <h2>全班状态</h2>
      <div class="counts">
        <span class="red">🔴 {{ statusCounts.red }} 人</span>
        <span class="yellow">🟡 {{ statusCounts.yellow }} 人</span>
        <span class="green">🟢 {{ statusCounts.green }} 人</span>
      </div>
    </div>
    <div class="grid" v-if="store.snapshot.students.length">
      <div
        v-for="s in store.snapshot.students"
        :key="s.studentId"
        class="tile"
        :class="s.status"
        :title="tooltip(s.recentErrors)"
        @click="store.openDrawer(s.studentId)"
      >
        <span class="dot" />{{ s.studentName }}
      </div>
    </div>
    <p v-else class="empty">等待学生上报…</p>
  </section>
</template>

<style scoped>
.matrix { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
.matrix .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.matrix h2 { margin: 0; font-size: 15px; }
.counts { display: flex; gap: 8px; font-size: 12px; }
.counts .red { background: #fef2f2; color: var(--red); padding: 2px 8px; border-radius: 4px; }
.counts .yellow { background: #fffbeb; color: var(--yellow); padding: 2px 8px; border-radius: 4px; }
.counts .green { background: #f0fdf4; color: var(--green); padding: 2px 8px; border-radius: 4px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
.tile { display: flex; align-items: center; gap: 6px; padding: 10px 8px; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-size: 14px; }
.tile:hover { border-color: var(--accent); }
.tile.red { background: #fef2f2; }
.tile.yellow { background: #fffbeb; }
.tile.green { background: #f0fdf4; }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.tile.red .dot { background: var(--red); }
.tile.yellow .dot { background: var(--yellow); }
.tile.green .dot { background: var(--green); }
.empty { color: var(--muted); font-size: 13px; }
</style>