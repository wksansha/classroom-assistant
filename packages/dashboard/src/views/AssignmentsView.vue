<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useAssignmentsStore } from "../stores/assignments";
import AssignmentDetailView from "./AssignmentDetailView.vue";

const store = useAssignmentsStore();
const selectedId = ref<string | null>(null);

const published = computed(() => store.assignments.filter((a) => a.isPublished));   // A23：草稿不上投屏
const current = computed(() => published.value.find((a) => a.id === selectedId.value) ?? published.value[0] ?? null);

onMounted(async () => {
  await store.fetchAll();
  if (current.value) await store.fetchSubmissionsFor(current.value);
});

async function select(id: string) {
  selectedId.value = id;
  const a = store.assignments.find((x) => x.id === id);
  if (a) await store.fetchSubmissionsFor(a);
}
</script>

<template>
  <div class="assignments-view">
    <nav class="assignment-tabs">
      <button v-for="a in published" :key="a.id" :class="{ active: current?.id === a.id }" @click="select(a.id)">
        {{ a.title }}（{{ a.exercises.length }} 题）
      </button>
    </nav>
    <AssignmentDetailView v-if="current" :assignment="current" />
    <p v-else class="empty">暂无已发布作业</p>
  </div>
</template>
