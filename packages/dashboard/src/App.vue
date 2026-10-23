<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useClassroom } from "./stores/classroom";
import { connectClassroom } from "./api/sse";
import StatusBar from "./components/StatusBar.vue";
import StudentMatrix from "./components/StudentMatrix.vue";
import AIPanel from "./components/AIPanel.vue";
import StudentDrawer from "./components/StudentDrawer.vue";
import AdminView from "./views/AdminView.vue";
import Toast from "./components/Toast.vue";

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
    <StatusBar />
    <main class="main-grid">
      <StudentMatrix />
      <div class="right-col">
        <AIPanel />
      </div>
    </main>
    <StudentDrawer />
  </div>
  <Toast />
</template>
