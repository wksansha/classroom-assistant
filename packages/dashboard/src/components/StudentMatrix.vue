<script setup lang="ts">
import { computed } from "vue";
import { useClassroom } from "../stores/classroom";
import { fmtTime } from "../composables/time";
import type { StudentState } from "@classroom/shared";

const store = useClassroom();

const statusCounts = computed(() => {
  const counts = { red: 0, yellow: 0, green: 0, offline: 0 };
  for (const s of store.snapshot?.students ?? []) {
    if (!s.online) counts.offline++;
    else counts[s.status]++;
  }
  return counts;
});

function tooltip(s: StudentState): string {
  if (!s.online) return "学员未在线";
  if (s.status === "green") return "状态正常";
  const errs = s.recentErrors.map((r) => `${fmtTime(r.ts)} ${r.subtype}｜${r.knowledge}`);
  return errs.length ? errs.join("\n") : "暂无错误";
}
</script>

<template>
  <section class="matrix tech-card" v-if="store.snapshot">
    <h2 class="tech-title">全班状态</h2>
    <div class="counts">
      <span class="red"><i class="lg" />需要协助 {{ statusCounts.red }} 人</span>
      <span class="yellow"><i class="lg" />调试中 {{ statusCounts.yellow }} 人</span>
      <span class="green"><i class="lg" />正常 {{ statusCounts.green }} 人</span>
      <span class="off-legend"><i class="lg" />未在线 {{ statusCounts.offline }} 人</span>
    </div>
    <div class="grid" v-if="store.snapshot.students.length">
      <div
        v-for="s in store.snapshot.students"
        :key="s.studentId"
        class="tile"
        :class="[s.status, { offline: !s.online }]"
        :title="tooltip(s)"
        @click="store.openDrawer(s.studentId)"
      >
        <span class="dot" />{{ s.studentName }}
        <span v-if="s.machineCount >= 2" class="machine-badge" :title="`${s.machineCount} 台电脑在线`">×{{ s.machineCount }}</span>
      </div>
    </div>
    <p v-else class="empty">等待学员上报…</p>
  </section>
</template>

<style scoped>
.matrix {
  padding: 12px 16px; display: flex; flex-direction: column; gap: 10px;
  /* 高度固定（≈5 行半瓦片，1080p 下 40vh，第 6 行露半行提示可滚动）：主区行高由本卡决定，
     课堂动态/AI 面板对齐此高度；学生超出可视行数时 .grid 内部滚动，滚动条隐藏 */
  height: clamp(400px, 40vh, 470px);
}
.counts { display: flex; gap: 14px; font-size: 15px; justify-content: center; }
/* 图例发光圆点：正常用青色（绿色只留给作业完成度的「已通过」，避免跨卡歧义） */
.counts .lg { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 6px; vertical-align: -1px; }
.counts .red { color: var(--tech-red); text-shadow: 0 0 6px rgba(255, 95, 109, 0.6); }
.counts .red .lg { background: var(--tech-red); box-shadow: 0 0 6px rgba(255, 95, 109, 0.7); }
.counts .yellow { color: var(--tech-yellow); text-shadow: 0 0 6px rgba(255, 197, 61, 0.5); }
.counts .yellow .lg { background: var(--tech-yellow); box-shadow: 0 0 6px rgba(255, 197, 61, 0.6); }
.counts .green { color: var(--tech-cyan); text-shadow: 0 0 6px rgba(124, 231, 255, 0.5); }
.counts .green .lg { background: var(--tech-cyan); box-shadow: 0 0 6px rgba(124, 231, 255, 0.7); }
.counts .off-legend { color: var(--text-dim); }
.counts .off-legend .lg { background: var(--tech-offline); }
.grid {
  flex: 1; min-height: 0;
  padding-top: 15px;   /* 瓦片整体下移：压缩卡底空白 */
  display: grid; grid-template-columns: repeat(4, 1fr);   /* 固定 4 列：卡更窄更高，与课堂动态/AI 列三列并立 */
  gap: 8px; align-content: start;
  overflow-y: auto; scrollbar-width: none; -ms-overflow-style: none;   /* 学生超出可视行数时内部滚动，滚动条隐藏 */
}
.grid::-webkit-scrollbar { display: none; }
.tile {
  display: flex; align-items: center; justify-content: center; gap: 6px; padding: 12px 8px;
  border: 1px solid var(--tech-card-border); border-radius: 8px; cursor: pointer;
  font-size: 20px; position: relative;
  background: rgba(20, 50, 100, 0.4); color: var(--text-primary);
}
.tile:hover { border-color: var(--tech-cyan); }
.tile.red { border-color: rgba(255, 95, 109, 0.6); box-shadow: 0 0 10px rgba(255, 95, 109, 0.18), inset 0 0 8px rgba(255, 95, 109, 0.08); }   /* 静态微光：整片不闪，避免急迫感 */
/* 呼吸转移到状态圆点：小亮点 3s 缓动，扫视可发现但不制造警报感 */
.tile.red:not(.offline) .dot { animation: dot-red-pulse 3s ease-in-out infinite; }
@keyframes dot-red-pulse {
  0%, 100% { box-shadow: 0 0 4px rgba(255, 95, 109, 0.4); }
  50% { box-shadow: 0 0 12px rgba(255, 95, 109, 0.95); }
}
.tile.yellow { border-color: rgba(255, 197, 61, 0.5); }
.tile.green { border-color: rgba(124, 231, 255, 0.5); }   /* 正常显示为青色（绿色留给完成度「已通过」） */
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.tile.red .dot { background: var(--tech-red); box-shadow: 0 0 8px rgba(255, 95, 109, 0.9); }
.tile.yellow .dot { background: var(--tech-yellow); box-shadow: 0 0 8px rgba(255, 197, 61, 0.7); }
.tile.green .dot { background: var(--tech-cyan); box-shadow: 0 0 8px rgba(124, 231, 255, 0.8); }
.tile.offline { opacity: 0.45; background: var(--tech-offline); }
.tile.offline .dot { background: #5d7fa6; box-shadow: none; }
.machine-badge {
  position: absolute; top: -6px; right: -6px;
  background: var(--tech-blue); color: #04070d; font-size: 11px; line-height: 1;
  padding: 3px 5px; border-radius: 8px; font-weight: 700;
}
.empty { color: var(--text-dim); font-size: 13px; text-align: center; }
</style>
