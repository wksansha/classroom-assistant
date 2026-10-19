import { reactive } from "vue";

export interface ToastItem { id: number; kind: "success" | "error"; text: string; }

const toasts = reactive<ToastItem[]>([]);
let seq = 0;

/** 全局浮动提示（模块级单例；App.vue 挂一次 <Toast/>，各面板 toast.success/error 即可） */
export function useToast() {
  function dismiss(id: number) {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }
  function push(kind: ToastItem["kind"], text: string) {
    const id = ++seq;
    toasts.push({ id, kind, text });
    setTimeout(() => dismiss(id), 3000);   // 3 秒自动消失；点击可提前关闭
  }
  return {
    toasts,
    success: (text: string) => push("success", text),
    error: (text: string) => push("error", text),
    dismiss,
  };
}
