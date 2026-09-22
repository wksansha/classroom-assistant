<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch } from "vue";
import {
  Chart, BarController, BarElement, CategoryScale, LinearScale,
  ArcElement, Tooltip, Legend, DoughnutController,
} from "chart.js";
import { useClassroom } from "../stores/classroom";

Chart.register(BarController, BarElement, CategoryScale, LinearScale, ArcElement, Tooltip, Legend, DoughnutController);

const store = useClassroom();
const barRef = ref<HTMLCanvasElement | null>(null);
let barChart: Chart | null = null;

const statusCounts = computed(() => {
  const counts = { red: 0, yellow: 0, green: 0 };
  for (const s of store.snapshot?.students ?? []) {
    counts[s.status]++;
  }
  return counts;
});

onMounted(() => {
  if (!barRef.value) return;
  barChart = new Chart(barRef.value, {
    type: "bar",
    data: {
      labels: ["🔴 红色", "🟡 黄色", "🟢 绿色"],
      datasets: [{
        label: "学生人数",
        data: [0, 0, 0],
        backgroundColor: ["#ef4444", "#f59e0b", "#22c55e"],
        borderRadius: 6,
        barPercentage: 0.6,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1 } },
      },
    },
  });
});

onBeforeUnmount(() => { barChart?.destroy(); });

watch(statusCounts, (v) => {
  if (barChart) {
    barChart.data.datasets[0].data = [v.red, v.yellow, v.green];
    barChart.update();
  }
}, { deep: true });
</script>

<template>
  <section class="overview" v-if="store.snapshot">
    <h2>全班状态概览</h2>
    <div class="chart-row">
      <div class="donut-wrap">
        <canvas ref="barRef" />
      </div>
      <div class="legend">
        <span class="item red">🔴 红色 {{ statusCounts.red }}</span>
        <span class="item yellow">🟡 黄色 {{ statusCounts.yellow }}</span>
        <span class="item green">🟢 绿色 {{ statusCounts.green }}</span>
        <span class="total">共 {{ statusCounts.red + statusCounts.yellow + statusCounts.green }} 人</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.overview { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
.overview h2 { margin: 0 0 10px; font-size: 15px; }
.chart-row { display: flex; align-items: center; gap: 16px; }
.donut-wrap { width: 160px; height: 160px; flex-shrink: 0; }
.legend { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.item { padding: 4px 10px; border-radius: 4px; }
.item.red { background: #fef2f2; color: var(--red); }
.item.yellow { background: #fffbeb; color: var(--yellow); }
.item.green { background: #f0fdf4; color: var(--green); }
.total { font-weight: 600; color: var(--text); }
</style>