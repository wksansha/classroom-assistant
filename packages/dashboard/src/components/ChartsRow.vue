<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, watch, nextTick, ref } from "vue";
import {
  Chart, BarController, BarElement,
  LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler,
} from "chart.js";
import { useClassroom } from "../stores/classroom";

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler);
Chart.defaults.color = "#9fd4ff";
Chart.defaults.borderColor = "rgba(63, 140, 255, 0.2)";

const store = useClassroom();
const barRef = ref<HTMLCanvasElement | null>(null);
const lineRef = ref<HTMLCanvasElement | null>(null);
let barChart: Chart | null = null;
let lineChart: Chart | null = null;

// —— 完成度卡：单题水桶模式（全班齐步走课堂——只关注当前题，桶满 = 全员通过）——
const allItems = computed(() => store.snapshot?.exerciseProgress ?? []);
const activeItems = computed(() => allItems.value.filter((e) => e.passed < e.total));
const completionEmpty = computed(() =>
  allItems.value.length === 0 ? "暂无题目数据" : "全员通过，干得漂亮");
/** 当前题 = 进行中题里最新开始的（firstTs 最大；齐步走课堂即全班正在做的那道） */
const focusItem = computed(() =>
  [...activeItems.value].sort((a, b) => b.firstTs - a.firstTs)[0] ?? null);
const focusPct = computed(() =>
  focusItem.value ? Math.round((focusItem.value.passed / focusItem.value.total) * 100) : 0);

// —— 状态占比已移除（全班状态矩阵已表达三值信息）——

// 三卡（完成度为 DOM 进度条，另两卡 chart.js）各自独立 init/update：某卡无数据时不阻塞其余卡片（spec §5.5）
function initBar() {
  if (!barRef.value) return;
  if (barChart) {
    if (barChart.canvas === barRef.value) return;
    barChart.destroy();
    barChart = null;
  }
  barChart = new Chart(barRef.value, {
    type: "bar",
    data: { labels: [], datasets: [{ label: "涉及人数", data: [], backgroundColor: "#ff5f6d", borderRadius: 2, barPercentage: 0.6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { stepSize: 1, precision: 0, maxRotation: 0, minRotation: 0 } },   // 标签横排不倾斜
        y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } },
      },
    },
  });
}
function initLine() {
  if (!lineRef.value) return;
  if (lineChart) {
    if (lineChart.canvas === lineRef.value) return;
    lineChart.destroy();
    lineChart = null;
  }
  lineChart = new Chart(lineRef.value, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "成功", data: [], borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,0.15)", tension: 0.3, fill: true, pointRadius: 2 },
        { label: "报错", data: [], borderColor: "#ff5f6d", backgroundColor: "rgba(255,95,109,0.15)", tension: 0.3, fill: true, pointRadius: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } } },
    },
  });
}

// —— 课堂节奏（动态时间窗）——
// 原点 = 第一个运行事件的时间点（纵坐标 0，仅作时间锚）；第一个运行的人归入下一个点计数。
// 共 10 个点 = 原点 + 9 段；不足 45 分钟保持 5 分钟粒度（用户示例：7:10 首跑 → 7:10 点=0，
// 7:10-7:15 间另有 5 人 + 首跑者 → 7:15 点=6）；更长的课区间自动压缩（interval = elapsed/9）。
const trendPoints = computed(() => {
  const buckets = store.snapshot?.trend ?? [];
  const BUCKET = 5 * 60_000;
  if (buckets.length === 0) return [];
  const snapTs = store.snapshot?.ts ?? Date.now();
  const origin = buckets[0].tStart;
  const end = Math.max(snapTs, buckets[buckets.length - 1].tStart + BUCKET);
  const interval = Math.max(end - origin, BUCKET) / 9;
  const pts = Array.from({ length: 10 }, (_, i) => ({ tStart: origin + interval * i, runs: 0, errors: 0 }));
  for (const [bi, b] of buckets.entries()) {
    if (b.runs === 0 && b.errors === 0) continue;
    const mid = b.tStart + BUCKET / 2;
    const idx = bi === 0 ? 1 : Math.min(9, Math.max(1, Math.floor((mid - origin) / interval)));
    pts[idx].runs += b.runs;
    pts[idx].errors += b.errors;
  }
  return pts;
});

function updateCharts() {
  const snap = store.snapshot;
  if (!snap) return;
  if (barChart) {
    const top3 = snap.aggregates.slice(0, 3);   // 服务端已按涉及人数降序，只取 Top3（大屏可读性）
    barChart.data.labels = top3.map((g) => g.subtype);   // 只显示类型名（category 口径太粗，x 轴字数精简）
    barChart.data.datasets[0].data = top3.map((g) => g.count);
    barChart.update();
  }
  if (lineChart) {
    lineChart.data.labels = trendPoints.value.map((b) => new Date(b.tStart).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }));
    lineChart.data.datasets[0].data = trendPoints.value.map((b) => b.runs);
    lineChart.data.datasets[1].data = trendPoints.value.map((b) => b.errors);
    lineChart.update();
  }
}

onMounted(async () => {
  await nextTick();
  initBar(); initLine();
  updateCharts();
});
onBeforeUnmount(() => { barChart?.destroy(); lineChart?.destroy(); });
watch(
  () => store.snapshot,
  async () => {
    await nextTick();   // 等待空态→有数据切换后渲染出 canvas
    initBar(); initLine();
    updateCharts();
  },
  { deep: true },
);
</script>

<template>
  <section class="charts-row" v-if="store.snapshot">
    <div class="chart-card tech-card completion">
      <h2 class="tech-title">作业完成度</h2>
      <p v-if="!focusItem" class="empty">{{ completionEmpty }}</p>
      <div v-else class="focus">
        <div class="focus-name" :title="focusItem.displayName">{{ focusItem.title }}</div>
        <div class="focus-bar"><div class="focus-bar-fill" :style="{ width: focusPct + '%' }" /></div>
        <div class="focus-nums">
          <span class="ok">已完成 {{ focusItem.passed }} 人</span>
          <span class="no">待完成 {{ focusItem.total - focusItem.passed }} 人</span>
          <span class="pct">{{ focusPct }}%</span>
        </div>
      </div>
    </div>
    <div class="chart-card tech-card">
      <h2 class="tech-title">错误类型TOP3</h2>
      <p v-if="!store.snapshot.aggregates.length" class="empty">暂无错误数据</p>
      <div v-else class="chart-wrap"><canvas ref="barRef" /></div>
    </div>
    <div class="chart-card tech-card">
      <h2 class="tech-title">课堂节奏</h2>
      <p v-if="!store.snapshot.trend.length" class="empty">暂无运行数据</p>
      <div v-else class="chart-wrap"><canvas ref="lineRef" /></div>
    </div>
  </section>
</template>

<style scoped>
/* .charts-row 网格定义在全局 style.css（Step 5），此处只写卡内样式 */
.chart-card { padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.chart-card h2 { font-size: 18px; }
.comp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.comp-head .overall { font-size: 13px; color: var(--text-dim); white-space: nowrap; }
.comp-head .overall strong { font-family: var(--font-num); font-size: 26px; color: var(--tech-cyan); margin-left: 4px; font-variant-numeric: tabular-nums; text-shadow: 0 0 8px rgba(80, 220, 255, 0.8); }
.chart-wrap { flex: 1; min-height: 160px; position: relative; }   /* 高度随卡片弹性拉伸（chart.js responsive 自适应），不再写死 240px */
/* —— 单题水桶模式（完成度卡）—— */
.completion .focus { display: flex; flex-direction: column; gap: 12px; margin: auto 0; }
.completion .focus-name { color: var(--text-primary); font-size: 22px; font-weight: 700; text-align: center; text-shadow: 0 0 10px rgba(80, 160, 255, 0.6); }
.completion .focus-bar { height: 28px; background: rgba(255, 95, 109, 0.25); border: 1px solid var(--tech-card-border); border-radius: 3px; overflow: hidden; }
.completion .focus-bar-fill { height: 100%; background: linear-gradient(90deg, #16a34a, #22c55e); box-shadow: 0 0 12px rgba(34, 197, 94, 0.7); transition: width 0.6s ease; }
.completion .focus-nums { display: flex; justify-content: center; gap: 20px; font-size: 16px; }
.completion .focus-nums .ok { color: var(--tech-green); }
.completion .focus-nums .no { color: var(--tech-red); }
.completion .focus-nums .pct { font-family: var(--font-num); color: var(--tech-cyan); font-weight: 700; font-variant-numeric: tabular-nums; margin-left: 4px; }
.empty { margin: auto 0; color: var(--text-dim); font-size: 15px; text-align: center; }
</style>
