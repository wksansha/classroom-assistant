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
const barRef = ref<HTMLCanvasElement | null>(null);
const pieRef = ref<HTMLCanvasElement | null>(null);
const lineRef = ref<HTMLCanvasElement | null>(null);
let barChart: Chart | null = null;
let pieChart: Chart | null = null;
let lineChart: Chart | null = null;

// —— 完成度卡：焦点题模式（全班齐步走课堂——自动锁定活跃人数最多的进行中题）——
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
/** 焦点题 = 进行中题里三态人数最多者（exerciseProgress 服务端已按总和降序，取首个未通关题） */
const focusItem = computed(() => activeItems.value[0] ?? null);
const focusPct = computed(() =>
  focusItem.value ? Math.round((focusItem.value.passed / focusItem.value.total) * 100) : 0);
/** 其余进行中题（焦点之外），最多展示 4 行 */
const otherActive = computed(() => activeItems.value.slice(1, 5));
const otherActiveRest = computed(() => Math.max(0, activeItems.value.length - 1 - otherActive.value.length));

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

// 三卡各自独立 init/update：某卡无数据时不阻塞其余卡片（spec §5.5）
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
  initBar(); initPie(); initLine();
  updateCharts();
});
onBeforeUnmount(() => { barChart?.destroy(); pieChart?.destroy(); lineChart?.destroy(); });
watch(
  () => store.snapshot,
  async () => {
    await nextTick();   // 等待空态→有数据切换后渲染出 canvas
    initBar(); initPie(); initLine();
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
      <div v-else class="focus">
        <div class="focus-name">{{ focusItem!.displayName }}</div>
        <div class="focus-bar"><div class="focus-bar-fill" :style="{ width: focusPct + '%' }" /></div>
        <div class="focus-nums">
          <span class="ok">已完成 {{ focusItem!.passed }} 人</span>
          <span class="no">待完成 {{ focusItem!.total - focusItem!.passed }} 人</span>
          <span class="pct">{{ focusPct }}%</span>
        </div>
      </div>
      <div v-if="otherActive.length" class="minor-list">
        <div v-for="e in otherActive" :key="e.id" class="minor-row">
          <span class="n">{{ e.displayName }}</span>
          <span class="v">{{ e.passed }}/{{ e.total }}</span>
        </div>
        <div v-if="otherActiveRest > 0" class="minor-row rest">…另有 {{ otherActiveRest }} 题进行中</div>
      </div>
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
/* —— 焦点题模式（完成度卡）—— */
.completion .focus { display: flex; flex-direction: column; gap: 10px; margin: auto 0; }
.completion .focus-name { color: var(--text-primary); font-size: 20px; font-weight: 700; text-align: center; text-shadow: 0 0 10px rgba(80, 160, 255, 0.6); }
.completion .focus-bar { height: 22px; background: rgba(255, 95, 109, 0.25); border: 1px solid var(--tech-card-border); border-radius: 3px; overflow: hidden; }
.completion .focus-bar-fill { height: 100%; background: linear-gradient(90deg, #16a34a, #22c55e); box-shadow: 0 0 12px rgba(34, 197, 94, 0.7); transition: width 0.6s ease; }
.completion .focus-nums { display: flex; justify-content: center; gap: 18px; font-size: 14px; }
.completion .focus-nums .ok { color: var(--tech-green); }
.completion .focus-nums .no { color: var(--tech-red); }
.completion .focus-nums .pct { color: var(--tech-cyan); font-weight: 700; font-variant-numeric: tabular-nums; margin-left: 4px; }
.completion .minor-list { display: flex; flex-direction: column; gap: 4px; }
.completion .minor-row { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-dim); }
.completion .minor-row .v { font-variant-numeric: tabular-nums; color: var(--text-secondary); }
.completion .minor-row.rest { justify-content: center; }
.done-note { margin: 0; font-size: 12px; color: var(--text-dim); text-align: center; }
.empty { margin: auto 0; color: var(--text-dim); font-size: 13px; text-align: center; }
</style>
