<script setup lang="ts">
import { computed, ref } from "vue";
import type { Assignment, Exercise, Submission } from "@classroom/shared";
import { useAssignmentsStore, latestByStudent } from "../stores/assignments";
import { assignmentsApi } from "../api/assignments";
import SubmissionMatrix from "../components/SubmissionMatrix.vue";
import SubmissionDetailDrawer from "../components/SubmissionDetailDrawer.vue";

const props = defineProps<{ assignment: Assignment & { exercises: Exercise[] } }>();
const store = useAssignmentsStore();

const selectedCell = ref<{ exerciseId: string; studentId: string } | null>(null);
const override = ref<Submission | null>(null);
const history = ref<Submission[]>([]);

const matrix = computed(() => {
  const m: Record<string, Record<string, Submission | undefined>> = {};
  for (const ex of props.assignment.exercises) {
    m[ex.id] = latestByStudent(store.submissionsByExercise[ex.id] ?? []);
  }
  return m;
});
const currentSubmission = computed(() => {
  if (override.value) return override.value;
  if (!selectedCell.value) return null;
  return matrix.value[selectedCell.value.exerciseId]?.[selectedCell.value.studentId] ?? null;
});

async function onSelectCell(payload: { exerciseId: string; studentId: string }) {
  selectedCell.value = payload;
  override.value = null;
  const all = await assignmentsApi.submissionsByStudent(payload.studentId);
  history.value = all.filter((s) => s.exerciseId === payload.exerciseId);   // 该生该练习的历史
}
function onPick(id: string) {
  override.value = history.value.find((h) => h.id === id) ?? null;
}
</script>

<template>
  <div class="assignment-detail">
    <SubmissionMatrix :roster="store.roster" :exercises="assignment.exercises" :matrix="matrix" @select="onSelectCell" />
    <SubmissionDetailDrawer :submission="currentSubmission" :history="history" @close="selectedCell = null; override = null" @pick="onPick" />
  </div>
</template>
