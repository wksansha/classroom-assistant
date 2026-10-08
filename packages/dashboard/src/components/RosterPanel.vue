<script setup lang="ts">
import { ref } from "vue";
import type { RosterEntry } from "@classroom/shared";
import { assignmentsApi } from "../api/assignments";

const props = defineProps<{ roster: RosterEntry[] }>();
const emit = defineEmits<{ refreshed: [] }>();
const text = ref("");
const message = ref("");

async function importRoster() {
  try {
    const r = await assignmentsApi.importRoster(text.value);
    message.value = `已导入 ${r.count} 人`;
    text.value = "";
    emit("refreshed");
  } catch (e) {
    message.value = `导入失败：${e instanceof Error ? e.message : String(e)}`;
  }
}
</script>

<template>
  <section class="roster-panel">
    <h3>名册管理（覆盖式导入，每行「学号 姓名」）</h3>
    <textarea v-model="text" rows="6" placeholder="0001 张三&#10;0002 李四"></textarea>
    <button class="import-roster" @click="importRoster">导入名册</button>
    <span class="msg">{{ message }}</span>
    <table class="roster-table">
      <thead><tr><th>学号</th><th>姓名</th></tr></thead>
      <tbody><tr v-for="r in props.roster" :key="r.studentId"><td>{{ r.studentId }}</td><td>{{ r.studentName }}</td></tr></tbody>
    </table>
  </section>
</template>
