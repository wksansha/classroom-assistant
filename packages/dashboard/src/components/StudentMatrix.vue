<script setup lang="ts">
import { useClassroom } from "../stores/classroom";
import { fmtTime } from "../composables/time";
import type { RecentError } from "@classroom/shared";

const store = useClassroom();

function tooltip(recent: RecentError[]): string {
  return recent.map((r) => `${fmtTime(r.ts)} ${r.subtype}｜${r.knowledge}`).join("\n") || "暂无错误";
}
</script>

<template>
  <section class="matrix" v-if="store.snapshot">
    <h2>全班状态</h2>
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
.matrix h2 { margin: 0 0 8px; font-size: 15px; }
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