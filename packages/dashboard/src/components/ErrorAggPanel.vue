<script setup lang="ts">
import { computed, ref } from "vue";
import { useClassroom } from "../stores/classroom";

const store = useClassroom();
const expanded = ref<string | null>(null);

const maxCount = computed(() =>
  Math.max(1, ...(store.snapshot?.aggregates.map((g) => g.count) ?? [1])),
);

function toggle(subtype: string) {
  expanded.value = expanded.value === subtype ? null : subtype;
}
</script>

<template>
  <section class="agg" v-if="store.snapshot">
    <h2>错误聚合</h2>
    <div class="group" v-for="g in store.snapshot.aggregates" :key="g.subtype">
      <div class="bar-row" @click="toggle(g.subtype)">
        <div class="bar" :style="{ width: `${(g.count / maxCount) * 100}%` }" />
        <span class="label">{{ g.subtype }} {{ g.count }} 人</span>
      </div>
      <p class="knowledge">{{ g.knowledge }}</p>
      <ul v-if="expanded === g.subtype" class="names">
        <li v-for="s in g.students" :key="s.studentId">{{ s.studentName }}</li>
      </ul>
    </div>
    <p v-if="store.snapshot.aggregates.length === 0" class="empty">暂无聚合数据</p>
  </section>
</template>

<style scoped>
.agg { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
.agg h2 { margin: 0 0 8px; font-size: 15px; }
.group { margin-bottom: 10px; }
.bar-row { display: flex; align-items: center; gap: 8px; cursor: pointer; background: var(--bg); border-radius: 4px; overflow: hidden; }
.bar { height: 22px; background: var(--accent); opacity: 0.75; border-radius: 4px 0 0 4px; }
.label { font-size: 13px; padding: 0 8px; white-space: nowrap; }
.knowledge { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
.names { margin: 4px 0 0; padding-left: 20px; font-size: 13px; color: var(--text); }
.empty { color: var(--muted); font-size: 13px; }
</style>