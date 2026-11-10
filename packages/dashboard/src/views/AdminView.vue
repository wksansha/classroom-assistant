<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { RosterEntry } from "@classroom/shared";
import { adminApi, ADMIN_TOKEN_KEY } from "../api/admin";
import RosterPanel from "../components/RosterPanel.vue";
import LessonFilesPanel from "../components/LessonFilesPanel.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";

const state = ref<"checking" | "login" | "ready">("checking");
const password = ref("");
const error = ref("");
const roster = ref<RosterEntry[]>([]);
const showResetConfirm = ref(false);
const resetting = ref(false);
const resetError = ref("");
const resetDone = ref(false);

async function load() {
  roster.value = await adminApi.roster();
}

async function enterReady() {
  state.value = "ready";
  await load();
}

async function resetDashboard() {
  resetting.value = true;
  resetError.value = "";
  try {
    await adminApi.resetDashboard();
    resetDone.value = true;
    setTimeout(() => { resetDone.value = false; }, 5000);
  } catch {
    resetError.value = "重置失败，请稍后重试";
  } finally {
    resetting.value = false;
  }
}

async function checkSession() {
  try {
    const s = await adminApi.verifySession();
    // 服务端未启用管理鉴权（未配置 ADMIN_PASSWORD）→ 直接进
    if (!s.adminProtected || localStorage.getItem(ADMIN_TOKEN_KEY)) await enterReady();
    else state.value = "login";
  } catch {
    // 带着失效令牌探测 → 清掉回登录门
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    state.value = "login";
  }
}

async function login() {
  error.value = "";
  const token = password.value.trim();
  if (!token) { error.value = "请输入管理密码"; return; }
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
  try {
    const s = await adminApi.verifySession();
    if (s.adminProtected && s.ok) await enterReady();
    else state.value = "login";
  } catch {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    error.value = "密码不正确";
  }
}

onMounted(() => void checkSession());
</script>

<template>
  <div class="admin-view">
    <header class="app-header">
      <h1>课堂助手 · 管理</h1>
    </header>
    <p v-if="state === 'checking'" class="login-hint">正在检查管理会话…</p>
    <form v-else-if="state === 'login'" class="login-card" @submit.prevent="login">
      <h2>管理登录</h2>
      <p class="login-hint">请输入管理密码（由教员在服务器上配置）</p>
      <input v-model="password" type="password" placeholder="管理密码" autocomplete="current-password" />
      <button type="submit">进入</button>
      <p v-if="error" class="login-error">{{ error }}</p>
    </form>
    <template v-else>
      <RosterPanel :roster="roster" @refreshed="load()" />
      <LessonFilesPanel />
      <section class="danger-zone">
        <h3>大屏数据</h3>
        <p class="danger-hint">课间换场用：点击后大屏统计清零（学员状态、题目进度、课堂节奏），新课数据从零开始。历史归档保留，服务器重启不会恢复旧数据；学员在线状态不受影响。</p>
        <p v-if="resetDone" class="reset-ok">✅ 已重置，大屏已从零开始统计</p>
        <p v-if="resetError" class="login-error">{{ resetError }}</p>
        <button class="danger-btn" :disabled="resetting" @click="showResetConfirm = true">
          {{ resetting ? "重置中…" : "重置大屏数据" }}
        </button>
      </section>
      <ConfirmDialog
        v-if="showResetConfirm"
        title="重置大屏数据？"
        body="大屏当前统计（学员状态、告警、题目进度、课堂节奏）将清零，仅统计此后发生的新数据。此操作不影响学员端，也不删除历史归档。"
        confirm-text="确认重置"
        danger
        @confirm="showResetConfirm = false; void resetDashboard()"
        @cancel="showResetConfirm = false"
      />
    </template>
  </div>
</template>

<style scoped>
.danger-zone {
  margin: 24px auto 40px;
  max-width: 720px;
  padding: 16px 20px;
  border: 1px solid #f0c2c2;
  border-radius: 6px;
  background: #fff7f7;
}
.danger-zone h3 {
  margin: 0 0 6px;
  font-size: 15px;
  color: #b42318;
}
.danger-hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: #7a4a46;
  line-height: 1.6;
}
.danger-btn {
  padding: 8px 18px;
  border: 1px solid #d92d20;
  border-radius: 6px;
  background: #d92d20;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}
.danger-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.danger-btn:hover:not(:disabled) {
  background: #b42318;
}
.reset-ok {
  margin: 0 0 12px;
  font-size: 13px;
  color: #067647;
}
</style>
