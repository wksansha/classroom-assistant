<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { RosterEntry } from "@classroom/shared";
import { adminApi, ADMIN_TOKEN_KEY } from "../api/admin";
import RosterPanel from "../components/RosterPanel.vue";

const state = ref<"checking" | "login" | "ready">("checking");
const password = ref("");
const error = ref("");
const roster = ref<RosterEntry[]>([]);

async function load() {
  roster.value = await adminApi.roster();
}

async function enterReady() {
  state.value = "ready";
  await load();
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
    <RosterPanel v-else :roster="roster" @refreshed="load()" />
  </div>
</template>
