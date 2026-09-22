<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from "chart.js";
import { useClassroom } from "../stores/classroom";

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

const store = useClassroom();
const expanded = ref<string | null>(null);
const chartRef = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;

onMounted(() => {
  if (!chartRef.value) return;
  chart = new Chart(chartRef.value, {
    type: "bar",
    data: {
      labels: [],
      datasets: [{
        label: "人数",
        data: [],
        backgroundColor: "#2563eb",
        borderRadius: 6,
        barPercentage: 0.6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1 } },
        x: { ticks: { maxRotation: 45, minRotation: 45 } },
      },
    },
  });
});

onBeforeUnmount(() => { chart?.destroy(); });

watch(
  () => store.snapshot?.aggregates,
  (aggregates) => {
    if (!chart) return;
    chart.data.labels = aggregates.map((g) => `${g.category} · ${g.subtype}`);
    chart.data.datasets[0].data = aggregates.map((g) => g.count);
    chart.update();
  },
  { deep: true },
);

function toggle(subtype: string) {
  expanded.value = expanded.value === subtype ? null : subtype;
}
</script>

<template>
  <section class="agg" v-if="store.snapshot">
    <h2>错误聚合</h2>
    <p v-if="!store.snapshot.aggregates.length" class="empty">暂无聚合数据</p>
    <template v-else>
      <div class="chart-wrap">
        <canvas ref="chartRef" />
      </div>
      <div class="group" v-for="g in store.snapshot.aggregates" :key="g.subtype">
        <div class="bar-row" @click="toggle(g.subtype)">
          <span class="category">{{ g.category }}</span>
          <span class="label">{{ g.subtype }} {{ g.count }} 人</span>
        </div>
        <p class="knowledge">{{ g.knowledge }}</p>
        <ul v-if="expanded === g.subtype" class="names">
          <li v-for="s in g.students" :key="s.studentId">{{ s.studentName }}</li>
        </ul>
      </div>
    </template>
  </section>
</template>

<style scoped>
.agg { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
.agg h2 { margin: 0 0 8px; font-size: 15px; }
.chart-wrap { height: 220px; margin-bottom: 10px; }
.group { margin-bottom: 10px; }
.bar-row { display: flex; align-items: center; gap: 8px; cursor: pointer; background: var(--bg); border-radius: 4px; overflow: hidden; }
.label { font-size: 13px; padding: 0 8px; white-space: nowrap; }
.category { font-size: 11px; padding: 1px 5px; border-radius: 3px; background: var(--muted); color: #fff; opacity: 0.85; }
.knowledge { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
.names { margin: 4px 0 0; padding-left: 20px; font-size: 13px; color: var(--text); }
.empty { color: var(--muted); font-size: 13px; }
</style>