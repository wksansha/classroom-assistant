<script setup lang="ts">
import type { Exercise, RosterEntry, Submission } from "@classroom/shared";
import { cellState } from "../stores/assignments";

const props = defineProps<{
  roster: RosterEntry[];
  exercises: Exercise[];
  matrix: Record<string, Record<string, Submission | undefined>>;
}>();
const emit = defineEmits<{ select: [payload: { exerciseId: string; studentId: string }] }>();

function cell(exerciseId: string, studentId: string): Submission | undefined {
  return props.matrix[exerciseId]?.[studentId];
}
function hoverTitle(sub: Submission | undefined): string {
  if (!sub) return "未提交";
  if (!sub.review) return "评审中";
  return `${sub.review.reason}（${sub.review.source}）`;   // A30 悬停详情
}
</script>

<template>
  <table class="submission-matrix">
    <thead>
      <tr>
        <th>学号</th><th>姓名</th>
        <th v-for="ex in exercises" :key="ex.id">{{ ex.filename }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="s in roster" :key="s.studentId">
        <td>{{ s.studentId }}</td>
        <td>{{ s.studentName }}</td>
        <td v-for="ex in exercises" :key="ex.id"
            class="cell" :class="cellState(cell(ex.id, s.studentId))"
            :title="hoverTitle(cell(ex.id, s.studentId))"
            @click="emit('select', { exerciseId: ex.id, studentId: s.studentId })">
          <span v-if="cell(ex.id, s.studentId) === undefined">⏳</span>
          <span v-else-if="!cell(ex.id, s.studentId)!.review">⏱</span>
          <span v-else-if="cell(ex.id, s.studentId)!.review!.status === 'pass'">✅</span>
          <span v-else-if="cell(ex.id, s.studentId)!.review!.status === 'fail'">❌</span>
          <span v-else>⚪</span>
        </td>
      </tr>
    </tbody>
  </table>
</template>
