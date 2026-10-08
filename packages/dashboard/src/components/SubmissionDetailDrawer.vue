<script setup lang="ts">
import type { Submission } from "@classroom/shared";
import { fmtTime } from "../composables/time";

const props = defineProps<{ submission: Submission | null; history: Submission[] }>();
const emit = defineEmits<{ close: []; pick: [submissionId: string] }>();

const STATUS_TEXT: Record<string, string> = { pass: "✅ 通过", fail: "❌ 未通过", unreviewed: "⚪ 未评审" };
const SOURCE_TEXT: Record<string, string> = { auto: "自动提交", manual: "手动提交" };
</script>

<template>
  <div v-if="submission" class="drawer">
    <div class="drawer-header">
      <h3>{{ submission.studentId }} {{ submission.studentName }}
        <span class="branch">git 分支：student-{{ submission.studentId }}</span>
      </h3>
      <button class="close" @click="emit('close')">✕ 关闭</button>
    </div>
    <div class="review" v-if="submission.review">
      <span :class="submission.review.status">{{ STATUS_TEXT[submission.review.status] }}</span>
      <span class="reason">{{ submission.review.reason }}</span>
      <span class="meta">模型 {{ submission.review.model }} · {{ SOURCE_TEXT[submission.source] }} · {{ fmtTime(submission.submittedAt) }}</span>
    </div>
    <div class="review" v-else><span class="reviewing">⏱ 评审中</span></div>
    <pre class="code">{{ submission.code }}</pre>
    <div class="history" v-if="history.length > 1">
      <h4>历史提交</h4>
      <div v-for="h in history" :key="h.id" class="history-item"
           :class="{ active: h.id === submission.id }" @click="emit('pick', h.id)">
        {{ fmtTime(h.submittedAt) }} · {{ h.review ? STATUS_TEXT[h.review.status] : "⏱ 评审中" }} · {{ SOURCE_TEXT[h.source] }}
      </div>
    </div>
  </div>
</template>
