<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useClassroom } from "./stores/classroom";
import { connectClassroom } from "./api/sse";
import AlertPanel from "./components/AlertPanel.vue";
import StudentMatrix from "./components/StudentMatrix.vue";
import ErrorAggPanel from "./components/ErrorAggPanel.vue";
import SuggestionBar from "./components/SuggestionBar.vue";
import StudentDrawer from "./components/StudentDrawer.vue";

const store = useClassroom();
let stopSse: (() => void) | null = null;
onMounted(() => { stopSse = connectClassroom(store); });
onUnmounted(() => stopSse?.());
</script>

<template>
  <div class="app">
    <header class="app-header">
      <h1>课堂教学实时助教</h1>
      <span class="conn" :class="store.sseConnected ? 'on' : 'off'">
        {{ store.sseConnected ? "已连接" : "连接中断，重试中…" }}
      </span>
    </header>
    <SuggestionBar />
    <main>
      <StudentMatrix />
      <ErrorAggPanel />
    </main>
    <StudentDrawer />
  </div>
</template>