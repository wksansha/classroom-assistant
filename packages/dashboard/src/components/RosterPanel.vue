<script setup lang="ts">
import { ref } from "vue";
import type { RosterEntry } from "@classroom/shared";
import { adminApi } from "../api/admin";

const props = defineProps<{ roster: RosterEntry[] }>();
const emit = defineEmits<{ refreshed: [] }>();
const message = ref("");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// —— 行内改名（spec roster §4：姓名直接改；学号不可改）——
const editingId = ref<string | null>(null);
const editName = ref("");
function startEdit(r: RosterEntry) { editingId.value = r.studentId; editName.value = r.studentName; }
async function saveEdit(r: RosterEntry) {
  const name = editName.value.trim();
  editingId.value = null;
  if (!name || name === r.studentName) return;
  try {
    await adminApi.renameRosterEntry(r.studentId, name);
    message.value = `已改名：${r.studentId} → ${name}`;
    emit("refreshed");
  } catch (e) { message.value = `改名失败：${errMsg(e)}`; }
}

// —— 单条添加（底部固定添加行）——
const addId = ref("");
const addName = ref("");
async function addEntry() {
  const id = addId.value.trim(), name = addName.value.trim();
  if (!id || !name) { message.value = "请填写学号和姓名"; return; }
  try {
    await adminApi.addRosterEntry(id, name);
    message.value = `已添加 ${id} ${name}`;
    addId.value = ""; addName.value = "";
    emit("refreshed");
  } catch (e) { message.value = `添加失败：${errMsg(e)}`; }
}

// —— 批量添加：前端拆行逐条 POST entry（内网毫秒级，无需批量接口）——
const batchText = ref("");
const batchRunning = ref(false);
async function addBatch() {
  const lines = batchText.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) { message.value = "批量区为空"; return; }
  batchRunning.value = true;
  let ok = 0;
  const failed: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(\S+)\s+(\S.*)$/);
    if (!m) { failed.push(line); continue; }
    try { await adminApi.addRosterEntry(m[1], m[2].trim()); ok++; }
    catch { failed.push(line); }
  }
  batchRunning.value = false;
  batchText.value = failed.join("\n");   // 失败行留在批量区供修正重试
  message.value = `批量添加完成：成功 ${ok} 条${failed.length ? `，失败 ${failed.length} 条已留在批量区` : ""}`;
  if (ok > 0) emit("refreshed");
}

// —— 行操作：移出（软删除，无确认——凭证保留，重新导入可无缝复用）——
async function removeEntry(r: RosterEntry) {
  try {
    await adminApi.removeRosterEntry(r.studentId);
    message.value = `已移出 ${r.studentId}（Git 凭证保留，重新导入可无缝复用）`;
    emit("refreshed");
  } catch (e) { message.value = `移出失败：${errMsg(e)}`; }
}

// —— 行操作：彻底清除（purge，二次确认；文案明确删除 Gitea 账户与学生分支）——
async function purgeEntry(r: RosterEntry) {
  const ok = window.confirm(`彻底清除 ${r.studentId} ${r.studentName}？\n将删除其 Gitea 账户与 student-${r.studentId} 分支，提交历史不可恢复！`);
  if (!ok) return;
  try {
    await adminApi.purgeRosterEntry(r.studentId);
    message.value = `已彻底清除 ${r.studentId}`;
    emit("refreshed");
  } catch (e) { message.value = `清除失败：${errMsg(e)}`; }
}

// —— 学期换血：整表替换（走现有覆盖导入），弱化入口 + 红字警示 ——
const replaceText = ref("");
async function replaceAll() {
  try {
    const r = await adminApi.replaceRoster(replaceText.value);
    message.value = `已整表替换：${r.count} 人`;
    replaceText.value = "";
    emit("refreshed");
  } catch (e) { message.value = `整表替换失败：${errMsg(e)}`; }
}
</script>

<template>
  <section class="roster-panel">
    <h3>名册管理</h3>
    <div class="roster-table-wrap">
      <table class="roster-table">
        <thead><tr><th>学号</th><th>姓名</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="r in props.roster" :key="r.studentId">
            <td>{{ r.studentId }}</td>
            <td>
              <template v-if="editingId === r.studentId">
                <input class="edit-name" v-model="editName" @keyup.enter="saveEdit(r)" />
                <button class="save-edit" @click="saveEdit(r)">保存</button>
              </template>
              <template v-else><span class="name-text" @click="startEdit(r)">{{ r.studentName }}</span></template>
            </td>
            <td>
              <button class="remove-entry" @click="removeEntry(r)">移出</button>
              <button class="purge-entry" @click="purgeEntry(r)">彻底清除</button>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr class="add-row">
            <td><input class="add-id" v-model="addId" placeholder="学号" /></td>
            <td><input class="add-name" v-model="addName" placeholder="姓名" @keyup.enter="addEntry" /></td>
            <td><button class="add-entry" @click="addEntry">+ 添加学生</button></td>
          </tr>
        </tfoot>
      </table>
    </div>
    <span class="msg">{{ message }}</span>
    <details class="batch-add">
      <summary>批量添加（每行「学号 姓名」，逐条入册）</summary>
      <textarea class="batch-text" v-model="batchText" rows="4" placeholder="0001 张三&#10;0002 李四"></textarea>
      <button class="add-batch" :disabled="batchRunning" @click="addBatch">逐条添加</button>
    </details>
    <details class="replace-all">
      <summary>整表替换（学期换血）</summary>
      <p class="danger-text">⚠️ 覆盖式导入：现有名册整体删除替换；旧学号的 Gitea 账户与学生分支保留为档案。</p>
      <textarea class="replace-text" v-model="replaceText" rows="4" placeholder="0001 张三&#10;0002 李四"></textarea>
      <button class="replace-roster" @click="replaceAll">整表替换</button>
    </details>
  </section>
</template>
