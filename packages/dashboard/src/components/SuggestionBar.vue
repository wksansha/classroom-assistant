<script setup lang="ts">
import { computed } from "vue";
import { useClassroom } from "../stores/classroom";

const store = useClassroom();
const visible = computed(() => store.snapshot?.suggestions.filter((s) => !s.acked) ?? []);

async function ack(id: string) {
  try {
    await fetch("/api/suggestions/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } finally {
    // 服务端下次 update 会带 acked；本地立即隐藏（双保险）
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
  <section class="suggestions" v-if="store.snapshot && visible.length">
    <div class="card" v-for="s in visible" :key="s.id" :class="s.kind">
      <span>{{ s.text }}</span>
      <button @click="ack(s.id)">标记已处理</button>
    </div>
  </section>
</template>

<style scoped>
.suggestions { display: flex; flex-wrap: wrap; gap: 8px; }
.card { display: flex; align-items: center; gap: 10px; background: var(--card); border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 6px; padding: 8px 12px; font-size: 13px; }
.card.class-review { border-left-color: var(--red); }
.card.group-discuss { border-left-color: var(--yellow); }
.card.individual { border-left-color: var(--green); }
</style>