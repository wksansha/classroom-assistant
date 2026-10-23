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
  <section class="ai-panel" v-if="store.snapshot">
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
.ai-panel { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
.panel-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.ai-badge { background: #7c3aed; color: #fff; font-size: 12px; font-weight: 700; border-radius: 4px; padding: 2px 8px; letter-spacing: 1px; }
.ai-panel h2 { margin: 0; font-size: 18px; }
.card { display: flex; flex-direction: column; align-items: stretch; gap: 6px; background: var(--bg); border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 6px; padding: 12px; margin-bottom: 10px; }
.card.class-review { border-left-color: var(--red); }
.card.group-discuss { border-left-color: var(--yellow); }
.card.individual { border-left-color: var(--green); }
.kind-tag { font-size: 12px; color: var(--muted); }
.text { margin: 0; font-size: 15px; line-height: 1.5; }
.card button { align-self: flex-end; padding: 4px 12px; font-size: 13px; border: 1px solid var(--border); background: var(--card); border-radius: 6px; cursor: pointer; }
.card button:hover { border-color: var(--accent); color: var(--accent); }
.empty { color: var(--muted); font-size: 14px; }
</style>
