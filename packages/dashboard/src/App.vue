<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useClassroom } from "./stores/classroom";
import { useAssignmentsStore } from "./stores/assignments";
import { connectClassroom } from "./api/sse";
import AlertPanel from "./components/AlertPanel.vue";
import StudentMatrix from "./components/StudentMatrix.vue";
import ErrorAggPanel from "./components/ErrorAggPanel.vue";
import SuggestionBar from "./components/SuggestionBar.vue";
import StudentDrawer from "./components/StudentDrawer.vue";
import AssignmentsView from "./views/AssignmentsView.vue";
import AdminView from "./views/AdminView.vue";

const store = useClassroom();
const assignmentsStore = useAssignmentsStore();

const tab = ref<"monitor" | "assignments">("monitor");
const isAdmin = ref(window.location.hash === "#/admin");
function onHashChange() { isAdmin.value = window.location.hash === "#/admin"; }
window.addEventListener("hashchange", onHashChange);

let stopSse: (() => void) | null = null;
onMounted(() => {
  stopSse = connectClassroom(store, {
    onAssignmentMessage: (m) => void assignmentsStore.applyAssignmentMessage(m),   // A9/A21
  });
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
    <header class="tabs" v-if="!isAdmin">
      <button :class="{ active: tab === 'monitor' }" @click="tab = 'monitor'">实时监控</button>
      <button :class="{ active: tab === 'assignments' }" @click="tab = 'assignments'">作业矩阵</button>
    </header>
    <SuggestionBar v-show="tab === 'monitor'" />
    <AlertPanel v-show="tab === 'monitor'" />
    <main v-show="tab === 'monitor'">
      <StudentMatrix />
      <ErrorAggPanel />
    </main>
    <main v-if="tab === 'assignments'" class="assignments-main">
      <AssignmentsView />
    </main>
    <StudentDrawer v-show="tab === 'monitor'" />
  </div>
</template>