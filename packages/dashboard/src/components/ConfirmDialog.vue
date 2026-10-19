<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";

/** 自定义确认框（替换原生 window.confirm；danger=true 时确认按钮红色警示；ESC 关闭） */
defineProps<{ title: string; body: string; confirmText?: string; danger?: boolean }>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("cancel");
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="dialog-mask" @click.self="emit('cancel')">
    <div class="dialog" role="alertdialog">
      <h4 class="dialog-title">{{ title }}</h4>
      <p class="dialog-body">{{ body }}</p>
      <div class="dialog-actions">
        <button class="dialog-cancel" @click="emit('cancel')">取消</button>
        <button class="dialog-confirm" :class="{ danger }" @click="emit('confirm')">{{ confirmText ?? "确认" }}</button>
      </div>
    </div>
  </div>
</template>
