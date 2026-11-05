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
        <h3><i class="dot" :class="store.activeStudent?.status ?? 'idle'" />{{ store.activeStudent?.studentName ?? detail?.studentName ?? "未知学员" }}</h3>
        <button class="close" @click="store.closeDrawer()">×</button>
      </header>
      <p v-if="store.activeStudent" class="meta">
        本节课动态 · {{ store.activeStudent.lastActivityAt ? `停留：${fmtAgo(store.activeStudent.lastActivityAt)}` : "暂无操作记录" }}
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
    </aside>
  </div>
</template>

<style scoped>
.drawer-mask { position: fixed; inset: 0; background: rgba(2, 6, 12, 0.6); display: flex; justify-content: flex-end; z-index: 10; }
/* 科技感抽屉：与 tech-card 同族的渐变底/发光描边/四角折角标 */
.drawer {
  position: relative; width: 380px; height: 100%; padding: 18px 16px; overflow-y: auto;
  background: var(--tech-card-grad);
  border-left: 1px solid var(--tech-card-border);
  box-shadow: -6px 0 24px rgba(0, 0, 0, 0.55), var(--tech-card-glow);
  color: var(--text-primary);
}
.drawer::before, .drawer::after { content: ""; position: absolute; width: 10px; height: 10px; border: 2px solid var(--tech-corner); }
.drawer::before { top: 6px; left: 6px; border-right: none; border-bottom: none; }
.drawer::after { bottom: 6px; right: 6px; border-left: none; border-top: none; }
header { display: flex; align-items: center; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--tech-card-border); }
header h3 { margin: 0; flex: 1; display: flex; align-items: center; gap: 9px; font-size: 21px; letter-spacing: 2px; text-shadow: 0 0 10px rgba(80, 160, 255, 0.7); }
/* 状态圆点：与大屏矩阵同色（青=正常/红=卡住/黄=有错误/灰=未在线；绿色只留给完成度「已通过」） */
.dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }
.dot.green { background: var(--tech-cyan); box-shadow: 0 0 8px rgba(124, 231, 255, 0.8); }
.dot.red { background: var(--tech-red); box-shadow: 0 0 8px rgba(255, 95, 109, 0.8); }
.dot.yellow { background: var(--tech-yellow); box-shadow: 0 0 8px rgba(255, 197, 61, 0.7); }
.dot.idle { background: var(--tech-offline); }
.close { border: 1px solid var(--tech-card-border); background: none; width: 26px; height: 26px; line-height: 1; font-size: 16px; cursor: pointer; color: var(--text-dim); border-radius: 2px; }
.close:hover { color: var(--tech-cyan); border-color: var(--tech-cyan); box-shadow: 0 0 8px rgba(80, 220, 255, 0.4); }
.meta { color: var(--text-dim); font-size: 15px; letter-spacing: 1px; }
.history-wrapper { margin: 12px 0 0; }
.history { list-style: none; padding: 0; margin: 0; }
.history li { padding: 9px 0 9px 10px; border-bottom: 1px solid rgba(63, 140, 255, 0.14); border-left: 2px solid rgba(63, 140, 255, 0.35); display: flex; flex-direction: column; gap: 3px; font-size: 15px; }
.history li.success { border-left-color: var(--tech-green); }
.history li:not(.success) { border-left-color: var(--tech-red); }
.history .t { color: var(--text-dim); font-size: 13px; font-family: var(--font-num); letter-spacing: 1px; }
.history .k { color: var(--text-dim); }
.history code { font-size: 14px; color: var(--tech-cyan); word-break: break-all; text-shadow: 0 0 6px rgba(80, 220, 255, 0.35); }
.history .snippet { margin: 4px 0 0; padding: 8px; background: rgba(8, 20, 42, 0.6); border: 1px solid var(--tech-card-border); border-radius: 2px; font-size: 13px; color: var(--text-primary); white-space: pre-wrap; word-break: break-all; }
/* 抽屉滚动条：细青色，隐藏式视觉（贴边几乎不可见） */
.drawer::-webkit-scrollbar { width: 4px; }
.drawer::-webkit-scrollbar-thumb { background: rgba(63, 140, 255, 0.3); border-radius: 2px; }
.drawer::-webkit-scrollbar-track { background: transparent; }
</style>
