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
async function publish(id: string, publish: boolean) {
  await store.publishAssignment(id, publish);
}
async function patchDueAt(id: string, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  await assignmentsApi.patch(id, { dueAt: value ? new Date(value).getTime() : null });
}
onMounted(() => void store.fetchAll());
</script>

<template>
  <div class="admin-view">
    <h2>课堂助手 · 管理</h2>
    <div class="toolbar">
      <button class="sync" @click="sync">立即同步</button>
      <span v-if="syncResult" class="sync-result">
        新增 {{ syncResult.importedNew }} · 更新 {{ syncResult.updated }} · 注入 ID {{ syncResult.injected }} · 下线 {{ syncResult.deactivated }}
        <span v-for="w in syncResult.warnings" :key="w" class="warning">⚠️ {{ w }}</span>
      </span>
    </div>
    <RosterPanel :roster="store.roster" @refreshed="store.fetchAll()" />
    <section class="assignment-admin">
      <h3>作业列表</h3>
      <div v-for="a in store.assignments" :key="a.id" class="assignment-row">
        <strong>{{ a.title }}</strong>
        <span>{{ a.exercises.length }} 题</span>
        <span :class="a.isPublished ? 'published' : 'draft'">{{ a.isPublished ? "已发布" : "草稿" }}</span>
        <label>截止 <input class="due-at" type="date" :value="a.dueAt ? new Date(a.dueAt).toISOString().slice(0, 10) : ''" @change="patchDueAt(a.id, $event)" /></label>
        <button class="publish" v-if="!a.isPublished" @click="publish(a.id, true)">发布</button>
        <button class="unpublish" v-else @click="publish(a.id, false)">取消发布</button>
      </div>
    </section>
  </div>
</template>
