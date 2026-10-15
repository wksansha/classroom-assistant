<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useClassroom } from "./stores/classroom";
import { connectClassroom } from "./api/sse";
import AlertPanel from "./components/AlertPanel.vue";
import StudentMatrix from "./components/StudentMatrix.vue";
import ErrorAggPanel from "./components/ErrorAggPanel.vue";
import SuggestionBar from "./components/SuggestionBar.vue";
import StudentDrawer from "./components/StudentDrawer.vue";
import AdminView from "./views/AdminView.vue";

const store = useClassroom();

const isAdmin = ref(window.location.hash === "#/admin");
function onHashChange() { isAdmin.value = window.location.hash === "#/admin"; }
window.addEventListener("hashchange", onHashChange);

let stopSse: (() => void) | null = null;
onMounted(() => {
  stopSse = connectClassroom(store);
});
onUnmounted(() => {
  stopSse?.();
  window.removeEventListener("hashchange", onHashChange);
});
</script>

<template>
  <AdminView v-if="isAdmin" />
  <div class="app" v-else>
    <header class="app-header">
      <h1>课堂教学实时助教</h1>
      <span class="conn" :class="store.sseConnected ? 'on' : 'off'">
        {{ store.sseConnected ? "已连接" : "连接中断，重试中…" }}
      </span>
    </header>
    <SuggestionBar />
    <AlertPanel />
    <main>
      <StudentMatrix />
      <ErrorAggPanel />
    </main>
    <StudentDrawer />
  </div>
</template>
