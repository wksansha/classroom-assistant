<script setup lang="ts">
import { computed } from "vue";
import { useClassroom } from "../stores/classroom";

const store = useClassroom();
const visible = computed(() => store.snapshot?.suggestions.filter((s) => !s.acked) ?? []);
const KIND_LABEL: Record<string, string> = { "class-review": "全班讲评", "group-discuss": "小组讨论", individual: "单独辅导" };

async function ack(id: string) {
  try {
    await fetch("/api/suggestions/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } finally {
    // 服务端下次 update 会带 acked；本地立即隐藏（双保险，沿用 V1 语义）
    if (store.snapshot) {
      store.snapshot = {
        ...store.snapshot,
        suggestions: store.snapshot.suggestions.filter((s) => s.id !== id),
      };
    }
  }
}
</script>

<template>
  <section class="ai-panel tech-card" v-if="store.snapshot">
    <div class="panel-head">
      <span class="ai-badge">AI</span>
      <h2>教学建议</h2>
    </div>
    <p v-if="!visible.length" class="empty">暂无建议，课堂运转良好</p>
    <div class="card" v-for="s in visible" :key="s.id" :class="s.kind">
      <span class="kind-tag">{{ KIND_LABEL[s.kind] ?? s.kind }}</span>
      <p class="text">{{ s.text }}</p>
      <button @click="ack(s.id)">标记已处理</button>
    </div>
  </section>
</template>

<style scoped>
.ai-panel {
  padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
  flex: 1 1 auto; min-height: 280px;   /* 填满右列高度，与全班状态卡严格等高；建议超出一屏时内部滚动 */
  overflow-y: auto; scrollbar-width: none; -ms-overflow-style: none;
}
.ai-panel::-webkit-scrollbar { display: none; }
.panel-head { display: flex; align-items: center; justify-content: center; gap: 8px; }
.ai-badge {
  background: rgba(63, 169, 255, 0.2); color: var(--tech-cyan);
  border: 1px solid var(--tech-blue);
  font-size: 12px; font-weight: 700; border-radius: 2px; padding: 2px 8px;
  letter-spacing: 2px; text-shadow: 0 0 8px rgba(80, 220, 255, 0.8);
}
.ai-panel h2 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: 3px; color: var(--text-secondary); text-shadow: 0 0 8px rgba(80, 160, 255, 0.7); }
.card {
  display: flex; flex-direction: column; align-items: stretch; gap: 6px;
  background: rgba(20, 50, 100, 0.4); border: 1px solid rgba(63, 140, 255, 0.25);
  border-left: 4px solid var(--tech-blue);
  border-radius: 2px; padding: 12px; margin-bottom: 2px;
}
.card.class-review { border-left-color: var(--tech-red); }
.card.group-discuss { border-left-color: var(--tech-yellow); }
.card.individual { border-left-color: var(--tech-green); }
.kind-tag { font-size: 13px; color: var(--text-dim); }
.text { margin: 0; font-size: 16px; line-height: 1.55; color: var(--text-primary); }
.card button {
  align-self: flex-end; padding: 4px 12px; font-size: 13px; cursor: pointer;
  border: 1px solid rgba(63, 140, 255, 0.4); background: transparent; color: var(--text-secondary);
  border-radius: 2px;
}
.card button:hover { border-color: var(--tech-cyan); color: var(--tech-cyan); }
.empty { color: var(--text-dim); font-size: 14px; text-align: center; }
</style>
