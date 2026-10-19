<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { RosterEntry } from "@classroom/shared";
import { adminApi } from "../api/admin";
import RosterPanel from "../components/RosterPanel.vue";

const roster = ref<RosterEntry[]>([]);

async function load() {
  roster.value = await adminApi.roster();
}
onMounted(() => void load());
</script>

<template>
  <div class="admin-view">
    <header class="app-header">
      <h1>课堂助手 · 管理</h1>
    </header>
    <RosterPanel :roster="roster" @refreshed="load()" />
  </div>
</template>
