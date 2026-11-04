<script setup lang="ts">
import { computed } from "vue";
import { useClassroom } from "../stores/classroom";
import { fmtTime } from "../composables/time";
import type { RecentError } from "@classroom/shared";

const store = useClassroom();

const statusCounts = computed(() => {
  const counts = { red: 0, yellow: 0, green: 0, offline: 0 };
  for (const s of store.snapshot?.students ?? []) {
    if (!s.online) counts.offline++;
    else counts[s.status]++;
  }
  return counts;
});

function tooltip(recent: RecentError[]): string {
  return recent.map((r) => `${fmtTime(r.ts)} ${r.subtype}｜${r.knowledge}`).join("\n") || "暂无错误";
}
</script>

<template>
  <section class="matrix tech-card" v-if="store.snapshot">
    <h2 class="tech-title">全班状态</h2>
    <div class="counts">
      <span class="red">🔴 卡住 {{ statusCounts.red }} 人</span>
      <span class="yellow">🟡 有错误 {{ statusCounts.yellow }} 人</span>
      <span class="green">🟢 正常 {{ statusCounts.green }} 人</span>
      <span class="off-legend">⚪ 未在线 {{ statusCounts.offline }} 人</span>
    </div>
    <div class="grid" v-if="store.snapshot.students.length">
      <div
        v-for="s in store.snapshot.students"
        :key="s.studentId"
        class="tile"
        :class="[s.status, { offline: !s.online }]"
        :title="tooltip(s.recentErrors)"
        @click="store.openDrawer(s.studentId)"
      >
        <span class="dot" />{{ s.studentName }}
        <span v-if="s.machineCount >= 2" class="machine-badge" :title="`${s.machineCount} 台电脑在线`">×{{ s.machineCount }}</span>
      </div>
    </div>
    <p v-else class="empty">等待学生上报…</p>
  </section>
</template>

<style scoped>
.matrix { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.counts { display: flex; gap: 14px; font-size: 13px; justify-content: center; }
.counts .red { color: var(--tech-red); text-shadow: 0 0 6px rgba(255, 95, 109, 0.6); }
.counts .yellow { color: var(--tech-yellow); text-shadow: 0 0 6px rgba(255, 197, 61, 0.5); }
.counts .green { color: var(--tech-green); text-shadow: 0 0 6px rgba(34, 197, 94, 0.5); }
.counts .off-legend { color: var(--text-dim); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
.tile {
  display: flex; align-items: center; gap: 6px; padding: 12px 10px;
  border: 1px solid var(--tech-card-border); border-radius: 2px; cursor: pointer;
  font-size: 16px; position: relative;
  background: rgba(20, 50, 100, 0.4); color: var(--text-primary);
}
.tile:hover { border-color: var(--tech-cyan); }
.tile.red { border-color: rgba(255, 95, 109, 0.6); }
.tile.yellow { border-color: rgba(255, 197, 61, 0.5); }
.tile.green { border-color: rgba(34, 197, 94, 0.5); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.tile.red .dot { background: var(--tech-red); box-shadow: 0 0 8px rgba(255, 95, 109, 0.9); }
.tile.yellow .dot { background: var(--tech-yellow); box-shadow: 0 0 8px rgba(255, 197, 61, 0.7); }
.tile.green .dot { background: var(--tech-green); box-shadow: 0 0 8px rgba(34, 197, 94, 0.7); }
.tile.offline { opacity: 0.45; background: var(--tech-offline); }
.tile.offline .dot { background: #5d7fa6; box-shadow: none; }
.machine-badge {
  position: absolute; top: -6px; right: -6px;
  background: var(--tech-blue); color: #04070d; font-size: 11px; line-height: 1;
  padding: 3px 5px; border-radius: 8px; font-weight: 700;
}
.empty { color: var(--text-dim); font-size: 13px; text-align: center; }
</style>
