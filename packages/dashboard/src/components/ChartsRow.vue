<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, watch, nextTick, ref } from "vue";
import {
  Chart, DoughnutController, ArcElement, BarController, BarElement,
  LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler,
} from "chart.js";
import { useClassroom } from "../stores/classroom";

Chart.register(DoughnutController, ArcElement, BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler);
Chart.defaults.color = "#9fd4ff";
Chart.defaults.borderColor = "rgba(63, 140, 255, 0.2)";

const store = useClassroom();
const completionRef = ref<HTMLCanvasElement | null>(null);
const barRef = ref<HTMLCanvasElement | null>(null);
const pieRef = ref<HTMLCanvasElement | null>(null);
const lineRef = ref<HTMLCanvasElement | null>(null);
let completionChart: Chart | null = null;
let barChart: Chart | null = null;
let pieChart: Chart | null = null;
let lineChart: Chart | null = null;

// —— 完成度卡关注集（spec 决策 #5，沿用 V2 决策 #16/#18/#20）——
const allItems = computed(() => store.snapshot?.exerciseProgress ?? []);
const activeItems = computed(() => allItems.value.filter((e) => e.passed < e.total));
const doneCount = computed(() => allItems.value.length - activeItems.value.length);
const overall = computed(() => {
  const passedSum = activeItems.value.reduce((s, i) => s + i.passed, 0);
  const totalSum = activeItems.value.reduce((s, i) => s + i.total, 0);
  return totalSum === 0 ? 0 : Math.round((passedSum / totalSum) * 100);
});
const completionEmpty = computed(() =>
  allItems.value.length === 0 ? "暂无题目数据" : "全部作业已完成");

// —— 状态占比（spec 决策 #4：仅统计在线学生三值）——
const statusCounts = computed(() => {
  const counts = { red: 0, yellow: 0, green: 0 };
  for (const s of store.snapshot?.students ?? []) {
    if (!s.online) continue;
    if (s.status === "red") counts.red++;
    else if (s.status === "yellow") counts.yellow++;
    else counts.green++;
  }
  return counts;
});

// 四卡各自独立 init/update：某卡无数据时不阻塞其余卡片（spec §5.5）
function initCompletion() {
  if (!completionRef.value) return;
  if (completionChart) {
    if (completionChart.canvas === completionRef.value) return;
    completionChart.destroy();
    completionChart = null;
  }
  completionChart = new Chart(completionRef.value, {
    type: "bar",
    data: {
      labels: [],
      datasets: [
        { label: "已通过", data: [], backgroundColor: "#22c55e", stack: "s", borderRadius: 2 },
        { label: "卡住", data: [], backgroundColor: "#ff5f6d", stack: "s", borderRadius: 2 },
        { label: "待评审", data: [], backgroundColor: "#3fa9ff", stack: "s", borderRadius: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } },
      scales: {
        x: { stacked: true, ticks: { maxRotation: 45, minRotation: 45 } },
        y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1, precision: 0 } },
      },
    },
  });
}
function initBar() {
  if (!barRef.value) return;
  if (barChart) {
    if (barChart.canvas === barRef.value) return;
    barChart.destroy();
    barChart = null;
  }
  barChart = new Chart(barRef.value, {
    type: "bar",
    data: { labels: [], datasets: [{ label: "涉及人数", data: [], backgroundColor: "#3fa9ff", borderRadius: 2, barPercentage: 0.6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } }, x: { ticks: { maxRotation: 45, minRotation: 45 } } },
    },
  });
}
function initPie() {
  if (!pieRef.value) return;
  if (pieChart) {
    if (pieChart.canvas === pieRef.value) return;
    pieChart.destroy();
    pieChart = null;
  }
  pieChart = new Chart(pieRef.value, {
    type: "doughnut",
    data: {
      labels: ["卡住", "有错误", "正常"],
      datasets: [{ data: [0, 0, 0], backgroundColor: ["#ff5f6d", "#ffc53d", "#22c55e"], borderColor: "rgba(63,140,255,0.3)", borderWidth: 1 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "62%",
      plugins: { legend: { position: "right", labels: { boxWidth: 10 } } },
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
// 以第一个运行事件（成功或报错）的时间点倒推 5 分钟为原点，到当前时刻的区间十等分；
// 每段求和为一个点，固定展示 10 个点。课堂越长每段越宽（横轴自动压缩），5 分钟原始桶只做求和原料
const trendPoints = computed(() => {
  const buckets = store.snapshot?.trend ?? [];
  const BUCKET = 5 * 60_000;
  if (buckets.length === 0) return [];
  const snapTs = store.snapshot?.ts ?? Date.now();
  const origin = buckets[0].tStart - BUCKET;   // 原点倒推 5 分钟
  const end = Math.max(snapTs, buckets[buckets.length - 1].tStart + BUCKET);
  const seg = Math.max(end - origin, BUCKET * 10) / 10;
  const pts: { tStart: number; runs: number; errors: number }[] = [];
  let bi = 0;
  for (let i = 0; i < 10; i++) {
    const segStart = origin + seg * i;
    const segEnd = segStart + seg;
    let runs = 0, errors = 0;
    while (bi < buckets.length && buckets[bi].tStart < segEnd) {
      if (buckets[bi].tStart >= segStart) {
        runs += buckets[bi].runs;
        errors += buckets[bi].errors;
      }
      bi++;
    }
    pts.push({ tStart: segStart, runs, errors });
  }
  return pts;
});

function updateCharts() {
  const snap = store.snapshot;
  if (!snap) return;
  if (completionChart) {
    completionChart.data.labels = activeItems.value.map((e) => e.displayName);
    completionChart.data.datasets[0].data = activeItems.value.map((e) => e.passed);
    completionChart.data.datasets[1].data = activeItems.value.map((e) => e.stuck);
    completionChart.data.datasets[2].data = activeItems.value.map((e) => e.unreviewed);
    completionChart.update();
  }
  if (barChart) {
    const top3 = snap.aggregates.slice(0, 3);   // 服务端已按涉及人数降序，只取 Top3（大屏可读性）
    barChart.data.labels = top3.map((g) => `${g.category} · ${g.subtype}`);
    barChart.data.datasets[0].data = top3.map((g) => g.count);
    barChart.update();
  }
  if (pieChart) {
    pieChart.data.datasets[0].data = [statusCounts.value.red, statusCounts.value.yellow, statusCounts.value.green];
    pieChart.update();
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
  initCompletion(); initBar(); initPie(); initLine();
  updateCharts();
});
onBeforeUnmount(() => { completionChart?.destroy(); barChart?.destroy(); pieChart?.destroy(); lineChart?.destroy(); });
watch(
  () => store.snapshot,
  async () => {
    await nextTick();   // 等待空态→有数据切换后渲染出 canvas
    initCompletion(); initBar(); initPie(); initLine();
    updateCharts();
  },
  { deep: true },
);
</script>

<template>
  <section class="charts-row" v-if="store.snapshot">
    <div class="chart-card tech-card completion">
      <div class="comp-head">
        <h2 class="tech-title">作业完成度</h2>
        <span v-if="activeItems.length" class="overall">全班通过率 <strong>{{ overall }}%</strong></span>
      </div>
      <p v-if="!activeItems.length" class="empty">{{ completionEmpty }}</p>
      <div v-else class="chart-wrap"><canvas ref="completionRef">{{ activeItems.map((e) => e.displayName).join(" ") }}</canvas></div>
      <p v-if="doneCount > 0" class="done-note">另有 {{ doneCount }} 题已全部通过</p>
    </div>
    <div class="chart-card tech-card">
      <h2 class="tech-title">错误类型TOP3</h2>
      <p v-if="!store.snapshot.aggregates.length" class="empty">暂无错误数据</p>
      <div v-else class="chart-wrap"><canvas ref="barRef" /></div>
    </div>
    <div class="chart-card tech-card">
      <h2 class="tech-title">全班状态占比</h2>
      <p v-if="!store.snapshot.students.some((s) => s.online)" class="empty">暂无学生数据</p>
      <div v-else class="chart-wrap"><canvas ref="pieRef" /></div>
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
.chart-card h2 { font-size: 13px; }
.comp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.comp-head .overall { font-size: 12px; color: var(--text-dim); white-space: nowrap; }
.comp-head .overall strong { font-size: 22px; color: var(--tech-cyan); margin-left: 4px; font-variant-numeric: tabular-nums; text-shadow: 0 0 8px rgba(80, 220, 255, 0.8); }
.chart-wrap { flex: 1; min-height: 160px; position: relative; }   /* 高度随卡片弹性拉伸（chart.js responsive 自适应），不再写死 240px */
.done-note { margin: 0; font-size: 12px; color: var(--text-dim); text-align: center; }
.empty { margin: auto 0; color: var(--text-dim); font-size: 13px; text-align: center; }
</style>
