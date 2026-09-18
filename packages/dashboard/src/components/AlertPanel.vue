<script setup lang="ts">
import { useClassroom } from "../stores/classroom";

const store = useClassroom();
</script>

<template>
  <section class="alert-panel" v-if="store.snapshot">
    <h2>优先帮助</h2>
    <div class="alert" v-for="a in store.snapshot.alerts" :key="a.studentId">
      <span class="score">{{ a.score }}</span>
      <div class="body">
        <strong>{{ a.studentName }}</strong>
        <span class="reason">{{ a.reason }}</span>
        <span class="subtype">{{ a.subtype }} · {{ a.knowledge }}</span>
      </div>
      <button class="view" @click="store.openDrawer(a.studentId)">查看</button>
      <button disabled title="V2 开放">发提示</button>
    </div>
    <p class="summary">{{ store.snapshot.alertSummary }}</p>
  </section>
</template>

<style scoped>
.alert-panel { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
.alert-panel h2 { margin: 0 0 8px; font-size: 15px; }
.alert { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); }
.alert:last-of-type { border-bottom: none; }
.score { min-width: 36px; text-align: center; background: var(--red); color: #fff; border-radius: 4px; padding: 2px 6px; font-weight: 600; }
.body { display: flex; flex-direction: column; flex: 1; font-size: 13px; }
.reason { color: var(--muted); }
.subtype { color: var(--accent); font-size: 12px; }
.summary { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
</style>
