<script setup lang="ts">
import type { Assignment, Exercise } from "@classroom/shared";

defineProps<{ assignment: Assignment & { exercises: Exercise[] } }>();
</script>

<template>
  <div class="assignment-detail">
    <header class="meta">
      <h2>{{ assignment.title }}</h2>
      <span>第 {{ assignment.week }} 周</span>
      <span v-if="assignment.dueAt">截止 {{ new Date(assignment.dueAt).toLocaleString() }}</span>
    </header>
    <ul class="exercise-list">
      <li v-for="ex in assignment.exercises" :key="ex.id">
        <span class="order">{{ ex.order }}.</span>
        <span class="filename">{{ ex.filename }}</span>
        <span class="tags">
          <span class="tag">{{ ex.kind ?? "file" }}</span>
          <span v-if="ex.dir" class="tag">{{ ex.dir }}</span>
          <span class="tag">入口：{{ ex.entry ?? "main.py" }}</span>
          <span class="tag hash">{{ ex.versionHash }}</span>
        </span>
      </li>
    </ul>
  </div>
</template>
