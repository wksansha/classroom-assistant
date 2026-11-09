<script setup lang="ts">
import { computed } from "vue";
import { useClassroom } from "../stores/classroom";

const store = useClassroom();
const visible = computed(() => store.snapshot?.suggestions.filter((s) => !s.acked) ?? []);
const KIND_LABEL: Record<string, string> = { "class-review": "全班讲评", "group-discuss": "小组讨论", individual: "单独辅导" };

/** 正文强调：转义 HTML 后把「」内的关键词加粗提亮（服务端文案 + LLM 增强，防注入先转义） */
function emphasize(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/「([^」]+)」/g, "「<strong>$1</strong>」");
}

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
    <h2 class="tech-title"><span class="ai-badge">AI</span>教学建议</h2>
    <div class="panel-body">
      <p v-if="!visible.length" class="empty">暂无建议，课堂运转良好</p>
      <div class="card" v-for="s in visible" :key="s.id" :class="s.kind">
        <span class="kind-tag">{{ KIND_LABEL[s.kind] ?? s.kind }}</span>
        <p class="text" v-html="emphasize(s.text)" />
        <button @click="ack(s.id)">标记已处理</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ai-panel {
  flex: 1;         /* 拉伸填满 right-col：与左侧矩阵/课堂动态等高（此前缺 flex:1 导致高度只随内容变化） */
  padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
  min-height: 0;   /* 高度与矩阵对齐（right-col 拉伸）；滚动在内层 .panel-body，不再裁剪 tech-card 四角折角标 */
}
.panel-body {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 10px;
  scrollbar-width: none; -ms-overflow-style: none;
}
.panel-body::-webkit-scrollbar { display: none; }
.ai-badge {
  background: rgba(63, 169, 255, 0.2); color: var(--tech-cyan);
  border: 1px solid rgba(63, 169, 255, 0.35);   /* 亮蓝边框降透明度，避免刺眼 */
  font-size: 12px; font-weight: 700; border-radius: 2px; padding: 2px 8px;
  letter-spacing: 2px; text-shadow: 0 0 8px rgba(80, 220, 255, 0.8);
}
.card {
  display: flex; flex-direction: column; align-items: stretch; gap: 6px;
  background: rgba(20, 50, 100, 0.4); border: 1px solid rgba(63, 140, 255, 0.25);
  border-left: 4px solid rgba(63, 169, 255, 0.45);   /* 默认色条降透明度（各 kind 会覆盖为对应状态色） */
  border-radius: 2px; padding: 12px; margin-bottom: 2px;
}
.card.class-review { border-left-color: var(--tech-red); }
.card.group-discuss { border-left-color: var(--tech-yellow); }
.card.individual { border-left-color: var(--tech-green); }
.kind-tag { font-size: 13px; color: var(--text-dim); }
.text { margin: 0; font-size: 15px; line-height: 1.6; color: var(--text-primary); }
.text :deep(strong) { font-weight: 700; color: #fff; text-shadow: 0 0 6px rgba(80, 220, 255, 0.35); }
.card button {
  align-self: flex-end; padding: 4px 12px; font-size: 13px; cursor: pointer;
  border: 1px solid rgba(63, 140, 255, 0.4); background: transparent; color: var(--text-secondary);
  border-radius: 2px;
}
.card button:hover { border-color: var(--tech-cyan); color: var(--tech-cyan); }
.empty { color: var(--text-dim); font-size: 14px; text-align: center; }
</style>
