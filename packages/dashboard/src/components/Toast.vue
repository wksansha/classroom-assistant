<script setup lang="ts">
import { useToast } from "../composables/useToast";

const { toasts, dismiss } = useToast();
</script>

<template>
  <div class="toast-wrap">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind" @click="dismiss(t.id)">{{ t.text }}</div>
  </div>
</template>
