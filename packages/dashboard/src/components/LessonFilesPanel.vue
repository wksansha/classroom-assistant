<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { adminApi } from "../api/admin";

interface ExerciseFolder { name: string; files: string[] }

const folders = ref<ExerciseFolder[]>([]);
const available = ref(true);
const loading = ref(false);
const selectedFolder = ref("");
const checked = ref<Set<string>>(new Set());   // 跨文件夹切换保持勾选
const saving = ref(false);
const saved = ref(false);
const error = ref("");

const currentFiles = computed(() => folders.value.find((f) => f.name === selectedFolder.value)?.files ?? []);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const d = await adminApi.exerciseTree();
    available.value = d.available;
    folders.value = d.folders;
    if (folders.value.length && !selectedFolder.value) selectedFolder.value = folders.value[0].name;
  } catch {
    error.value = "题库目录加载失败";
  } finally {
    loading.value = false;
  }
  try {
    const d = await adminApi.lessonFiles();
    checked.value = new Set(d.files);   // 回填已保存的预选
  } catch { /* 读失败保持空 */ }
}

function toggle(file: string) {
  const next = new Set(checked.value);
  if (next.has(file)) next.delete(file); else next.add(file);
  checked.value = next;
}

async function save() {
  saving.value = true;
  error.value = "";
  try {
    await adminApi.setLessonFiles([...checked.value]);
    saved.value = true;
    setTimeout(() => { saved.value = false; }, 4000);
  } catch {
    error.value = "保存失败，请稍后重试";
  } finally {
    saving.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section class="lesson-panel">
    <div class="panel-head">
      <h3>本节课文件 <span class="count-badge">已选 {{ checked.size }} 个</span></h3>
      <button class="save-btn" :disabled="saving" @click="save">{{ saving ? "保存中…" : "保存预选" }}</button>
    </div>
    <p class="hint">提前勾选本节课要讲的练习，大屏「作业完成度」下拉即可提前选择（学生尚未运行的题目显示 0% 水桶）。</p>
    <p v-if="loading" class="hint">加载题库目录…</p>
    <p v-else-if="!available" class="hint warn">题库服务不可达（服务器 Gitea 未配置），无法预选</p>
    <p v-else-if="error" class="hint warn">{{ error }}</p>
    <template v-else>
      <div class="row">
        <label for="lesson-folder">作业文件夹</label>
        <select id="lesson-folder" v-model="selectedFolder">
          <option v-for="f in folders" :key="f.name" :value="f.name">{{ f.name }}</option>
        </select>
        <span class="folder-count">{{ currentFiles.length }} 个 .py</span>
      </div>
      <div class="files">
        <label v-for="f in currentFiles" :key="f" class="file-item" :title="f">
          <input type="checkbox" :checked="checked.has(f)" @change="toggle(f)" />
          <span>{{ f }}</span>
        </label>
        <p v-if="!currentFiles.length" class="hint">该文件夹暂无 .py 文件</p>
      </div>
      <p v-if="saved" class="hint ok">✅ 已保存，大屏下拉即刻生效</p>
    </template>
  </section>
</template>

<style scoped>
/* 与 RosterPanel 同一卡片语言：head 行（标题+徽章 | 右侧操作）+ 内容区（style.css 统一变量） */
.lesson-panel {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.panel-head h3 { margin: 0; font-size: 15px; }
.count-badge {
  margin-left: 6px; font-size: 12px; font-weight: normal; color: var(--muted);
  background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
  padding: 1px 8px; vertical-align: 1px;
}
.hint { margin: 0; font-size: 13px; color: var(--muted); line-height: 1.6; }
.hint.warn { color: var(--red); }
.hint.ok { color: #067647; }
.row { display: flex; align-items: center; gap: 10px; }
.row label { font-size: 13px; color: var(--muted); }
.row select {
  padding: 4px 10px; font-size: 13px; font-family: inherit;
  border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--text);
  outline: none; transition: border-color 0.15s, box-shadow 0.15s;
}
.row select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px #2563eb26; }
.folder-count { font-size: 12px; color: var(--muted); }
.files {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 16px;   /* 双列，长名册一眼扫完 */
  max-height: 240px; overflow-y: auto;
  padding: 6px 10px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg);
  scrollbar-width: thin;
}
.file-item {
  display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text);
  padding: 3px 4px; border-radius: 4px; cursor: pointer;
}
.file-item:hover { background: #2563eb0a; }   /* 与名册表格行 hover 同色 */
.file-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-item input { width: 14px; height: 14px; flex: none; cursor: pointer; accent-color: var(--accent); }
.save-btn {
  padding: 4px 14px; border: 1px solid var(--accent); border-radius: 6px;
  background: var(--accent); color: #fff; font-size: 13px; cursor: pointer;
}
.save-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.save-btn:hover:not(:disabled) { filter: brightness(1.05); }
</style>
