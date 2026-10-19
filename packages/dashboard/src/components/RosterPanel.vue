<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type { RosterEntry } from "@classroom/shared";
import { adminApi } from "../api/admin";
import { useToast } from "../composables/useToast";
import ConfirmDialog from "./ConfirmDialog.vue";

const props = defineProps<{ roster: RosterEntry[] }>();
const emit = defineEmits<{ refreshed: [] }>();
const toast = useToast();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// —— 行内改名（姓名直接改；学号不可改）——
const editingId = ref<string | null>(null);
const editName = ref("");
function startEdit(r: RosterEntry) { editingId.value = r.studentId; editName.value = r.studentName; }
async function saveEdit(r: RosterEntry) {
  const name = editName.value.trim();
  editingId.value = null;
  if (!name || name === r.studentName) return;
  try {
    await adminApi.renameRosterEntry(r.studentId, name);
    toast.success(`已改名：${r.studentId} → ${name}`);
    emit("refreshed");
  } catch (e) { toast.error(`改名失败：${errMsg(e)}`); }
}

// —— 常驻添加行：学号 Enter 跳姓名 → 姓名 Enter 保存 → 焦点回学号，连续录入不断流 ——
const addId = ref("");
const addName = ref("");
const addIdInput = ref<HTMLInputElement | null>(null);
const addNameInput = ref<HTMLInputElement | null>(null);
async function addEntry() {
  const id = addId.value.trim(), name = addName.value.trim();
  if (!id || !name) { toast.error("请填写学号和姓名"); return; }
  try {
    await adminApi.addRosterEntry(id, name);
    toast.success(`已添加 ${id} ${name}`);
    addId.value = ""; addName.value = "";
    emit("refreshed");
  } catch (e) { toast.error(`添加失败：${errMsg(e)}`); return; }
  await nextTick();
  addIdInput.value?.focus();
}

// —— 批量移除：勾选模式（软移出，Git 凭证保留，重新添加可无缝复用）——
const selectMode = ref(false);
const selected = ref(new Set<string>());
const selectedCount = computed(() => selected.value.size);
const allSelected = computed(() => props.roster.length > 0 && selected.value.size === props.roster.length);
function enterSelectMode() { selectMode.value = true; selected.value = new Set(); }
function exitSelectMode() { selectMode.value = false; selected.value = new Set(); }
function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(props.roster.map((r) => r.studentId));
}
function toggleOne(id: string) {
  if (selected.value.has(id)) selected.value.delete(id); else selected.value.add(id);
}
async function removeSelected() {
  const ids = [...selected.value];
  if (ids.length === 0) return;
  let ok = 0;
  const failed: string[] = [];
  for (const id of ids) {
    try { await adminApi.removeRosterEntry(id); ok++; } catch { failed.push(id); }
  }
  exitSelectMode();
  if (ok > 0) {
    toast.success(`已移出 ${ok} 人${failed.length ? `，失败 ${failed.length} 人（${failed.join("、")}）` : ""}，Git 凭证保留`);
    emit("refreshed");
  } else {
    toast.error(`移出失败：${failed.join("、")}`);
  }
}

// —— 行操作：移出（软删除，无确认——凭证保留，重新添加可无缝复用）——
async function removeEntry(r: RosterEntry) {
  try {
    await adminApi.removeRosterEntry(r.studentId);
    toast.success(`已移出 ${r.studentId}（Git 凭证保留，重新添加可无缝复用）`);
    emit("refreshed");
  } catch (e) { toast.error(`移出失败：${errMsg(e)}`); }
}

// —— 行操作：彻底清除（自定义确认框；删 Gitea 账户与学生分支，提交历史不可恢复）——
const purgeTarget = ref<RosterEntry | null>(null);
async function confirmPurge() {
  const r = purgeTarget.value;
  purgeTarget.value = null;
  if (!r) return;
  try {
    await adminApi.purgeRosterEntry(r.studentId);
    toast.success(`已彻底清除 ${r.studentId}`);
    emit("refreshed");
  } catch (e) { toast.error(`清除失败：${errMsg(e)}`); }
}
</script>

<template>
  <section class="roster-panel">
    <div class="roster-head">
      <h3>名册管理</h3>
      <div v-if="!selectMode" class="roster-head-actions">
        <button class="batch-remove" @click="enterSelectMode">批量移除</button>
      </div>
      <div v-else class="roster-head-actions">
        <button class="batch-remove-confirm" :disabled="selectedCount === 0" @click="removeSelected">✓ 移除 ({{ selectedCount }})</button>
        <button class="batch-remove-exit" title="退出勾选" @click="exitSelectMode">✕</button>
      </div>
    </div>
    <div class="roster-table-wrap">
      <table class="roster-table">
        <thead>
          <tr>
            <th v-if="selectMode" class="check-col">
              <input type="checkbox" class="check-all" :checked="allSelected" :indeterminate="selectedCount > 0 && !allSelected" @change="toggleAll" />
            </th>
            <th>学号</th>
            <th>姓名</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in props.roster" :key="r.studentId">
            <td v-if="selectMode" class="check-col">
              <input type="checkbox" class="check-one" :checked="selected.has(r.studentId)" @change="toggleOne(r.studentId)" />
            </td>
            <td>{{ r.studentId }}</td>
            <td>
              <template v-if="editingId === r.studentId">
                <input class="edit-name" v-model="editName" @keyup.enter="saveEdit(r)" />
                <button class="save-edit" @click="saveEdit(r)">保存</button>
              </template>
              <template v-else><span class="name-text" @click="startEdit(r)">{{ r.studentName }}</span></template>
            </td>
            <td v-if="!selectMode">
              <button class="remove-entry" @click="removeEntry(r)">移出</button>
              <button class="purge-entry" @click="purgeTarget = r">彻底清除</button>
            </td>
            <td v-else></td>
          </tr>
        </tbody>
        <tfoot>
          <tr class="add-row">
            <td v-if="selectMode"></td>
            <td><input class="add-id" ref="addIdInput" v-model="addId" placeholder="学号" @keyup.enter="addNameInput?.focus()" /></td>
            <td><input class="add-name" ref="addNameInput" v-model="addName" placeholder="姓名" @keyup.enter="addEntry" /></td>
            <td><button class="add-entry" @click="addEntry">+ 添加学生</button></td>
          </tr>
        </tfoot>
      </table>
    </div>
    <ConfirmDialog
      v-if="purgeTarget"
      title="彻底清除"
      :body="`彻底清除 ${purgeTarget.studentId} ${purgeTarget.studentName}？\n将删除其 Gitea 账户与 student-${purgeTarget.studentId} 分支，提交历史不可恢复！`"
      confirm-text="彻底清除"
      danger
      @confirm="confirmPurge"
      @cancel="purgeTarget = null"
    />
  </section>
</template>
