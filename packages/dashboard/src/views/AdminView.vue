<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useAssignmentsStore } from "../stores/assignments";
import { assignmentsApi, type SyncResult } from "../api/assignments";
import RosterPanel from "../components/RosterPanel.vue";

const store = useAssignmentsStore();
const syncResult = ref<SyncResult | null>(null);

async function sync() {
  try { syncResult.value = await assignmentsApi.sync(); } catch { syncResult.value = null; }
}
onMounted(() => void store.fetchAll());
</script>

<template>
  <div class="admin-view">
    <h2>课堂助手 · 管理</h2>
    <RosterPanel :roster="store.roster" @refreshed="store.fetchAll()" />
    <section class="assignment-admin">
      <div class="section-header">
        <h3>作业列表</h3>
        <span v-if="syncResult" class="sync-result">
          新增 {{ syncResult.importedNew }} · 更新 {{ syncResult.updated }} · 注入 ID {{ syncResult.injected }} · 下线 {{ syncResult.deactivated }}
          <span v-for="w in syncResult.warnings" :key="w" class="warning">⚠️ {{ w }}</span>
        </span>
        <button class="sync" @click="sync">立即同步</button>
      </div>
      <div class="assignment-list">
        <div v-for="a in store.assignments" :key="a.id" class="assignment-row">
          <strong>{{ a.title }}</strong>
          <span>{{ a.exercises.length }} 题</span>
        </div>
      </div>
    </section>
  </div>
</template>
