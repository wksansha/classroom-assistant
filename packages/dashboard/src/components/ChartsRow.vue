<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, watch, nextTick, ref } from "vue";
import {
  Chart, BarController, BarElement,
  LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler,
  PieController, ArcElement,
} from "chart.js";
import { useClassroom } from "../stores/classroom";

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler, PieController, ArcElement);
Chart.defaults.color = "#9fd4ff";
Chart.defaults.borderColor = "rgba(63, 140, 255, 0.2)";

/** 柱体垂直渐变：顶部亮、向下渐隐成光柱（chartArea 未布局完成的首帧回退纯色） */
const barGradient = (ctx: { chart: { chartArea?: { top: number; bottom: number }; ctx: CanvasRenderingContext2D } }) => {
  const area = ctx.chart.chartArea;
  if (!area) return "#ff5f6d";
  const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
  g.addColorStop(0, "#ff8a93");
  g.addColorStop(0.4, "#ff5f6d");
  g.addColorStop(1, "#b62c37");   // 底部实色深红收口：光柱不悬空
  return g;
};

/** 霓虹辉光插件：为每个 dataset 的描边加同色光晕（折线=流动霓虹，柱体=光柱轮廓） */
const neonGlow = {
  id: "neonGlow",
  beforeDatasetDraw(chart: Chart, args: { index: number }) {
    const ds = chart.data.datasets[args.index] as { borderColor?: string };
    chart.ctx.save();
    chart.ctx.shadowBlur = 14;
    chart.ctx.shadowColor = ds.borderColor ?? "rgba(80, 200, 255, 0.55)";
  },
  afterDatasetDraw(chart: Chart) {
    chart.ctx.restore();
  },
};

/** 悬浮提示科技风（两图共用）：深蓝面板+青描边+大字号，替代 chart.js 默认小黑框 */
const tooltipStyle = {
  backgroundColor: "rgba(6, 14, 30, 0.95)",
  borderColor: "rgba(63, 140, 255, 0.5)",
  borderWidth: 1,
  titleColor: "#7fd7ff",
  bodyColor: "#dbe9ff",
  titleFont: { size: 15, weight: 700 as const },
  bodyFont: { size: 14 },
  padding: 10,
  cornerRadius: 2,
};

// 自定义悬浮定位（官方扩展点 Tooltip.positioners）：统一锚定柱体右侧柱顶高度，不随鼠标跳动；
// 靠右的柱按预估悬浮框宽度翻到柱体左侧防溢出。positioner 收到 tooltip item 数组（items[i].element 图元、
// items[i].chart 图表实例——与 chart.js 内置 average/nearest 的取法一致）
type TipItem = { element?: { x: number; y: number }; chart?: { chartArea?: { right: number; left: number } } };
const tooltipPositioners = (Tooltip as unknown as { positioners: Record<string, unknown> }).positioners ??= {};
tooltipPositioners.rightOfBar = (items: TipItem[]) => {
  const el = items[0]?.element;
  if (!el) return false;
  const area = items[0]?.chart?.chartArea;
  const offset = 46;   // 柱厚 85 的一半 + 3px 间隙
  const flip = !!area && el.x + offset + 160 > area.right;   // 预估悬浮框宽 160px
  return { x: flip ? el.x - offset : el.x + offset, y: el.y, xAlign: flip ? "right" : "left", yAlign: "center" };
};

const store = useClassroom();
const barRef = ref<HTMLCanvasElement | null>(null);
const lineRef = ref<HTMLCanvasElement | null>(null);
let barChart: Chart | null = null;
let lineChart: Chart | null = null;

// —— 全班状态占比（饼图）：状态口径与矩阵图例一致（需要协助/调试中/正常，未在线不入图）——
const pieRef = ref<HTMLCanvasElement | null>(null);
let pieChart: Chart | null = null;
const statusCounts = computed(() => {
  const ss = store.snapshot?.students ?? [];
  return [
    { label: "需要协助", count: ss.filter((s) => s.status === "red" && s.online).length, color: "#ff5f6d" },
    { label: "调试中", count: ss.filter((s) => s.status === "yellow" && s.online).length, color: "#ffc53d" },
    { label: "正常", count: ss.filter((s) => s.status === "green" && s.online).length, color: "#7ce7ff" },
  ];
});

/* ============================================================
 * 【注释保留】作业完成度模块（单题水桶模式）——想好了随时恢复：
 * 恢复步骤：① 取消本注释块；② 取消模板中「作业完成度」卡的注释；
 * ③ 把下方「全班状态占比」饼图卡换成完成度卡；④ 测试文件恢复对应用例
 *
 * const allItems = computed(() => store.snapshot?.exerciseProgress ?? []);
 * const activeItems = computed(() => allItems.value.filter((e) => e.passed < e.total));
 * const completionEmpty = computed(() =>
 *   allItems.value.length === 0 ? "暂无题目数据" : "全员通过，干得漂亮");
 * // 下拉选项：今天全部题目按涌现时间新→旧（一个文件夹多个 py 各自成题）
 * const sortedItems = computed(() => [...allItems.value].sort((a, b) => b.firstTs - a.firstTs));
 * // 教员选定题 id；未选/选题消失（课间重置、新一天）时回落到最新进行中题
 * const selectedId = ref<string | null>(null);
 * watch(sortedItems, (list) => {
 *   if (selectedId.value && !list.some((e) => e.id === selectedId.value)) selectedId.value = null;
 *   if (!selectedId.value && activeItems.value.length) {
 *     selectedId.value = [...activeItems.value].sort((a, b) => b.firstTs - a.firstTs)[0].id;
 *   }
 * });
 * const displayItem = computed(() =>
 *   allItems.value.find((e) => e.id === selectedId.value) ?? null);
 * const focusPct = computed(() =>
 *   displayItem.value ? Math.round((displayItem.value.passed / displayItem.value.total) * 100) : 0);
 * // 液面高度 = 已通过/总人数，与中央百分比严格一致；绿液涨到顶 = 全员通过
 * ============================================================ */

// —— 状态占比已移除（全班状态矩阵已表达三值信息）——

/** 错误TOP3 数据引用（tooltip 悬停显示涉事学员名单用） */
const top3Agg = computed(() => store.snapshot?.aggregates.slice(0, 3) ?? []);

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
    data: { labels: [], datasets: [{ label: "涉及人数", data: [], backgroundColor: barGradient, borderColor: "#ff8a93", borderWidth: 1, borderRadius: 8, barThickness: 85 }] },   // 光柱渐变+描边：1-3 根也不变粗
    plugins: [neonGlow],
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipStyle,
          displayColors: false,
          position: "rightOfBar" as never,   // 自定义定位器：柱体右侧统一锚定（见文件头 Tooltip.positioners 注册）
          callbacks: {
            label: (ctx) => `涉及 ${ctx.parsed.y} 人`,   // 竖向柱：数值轴是 y
            afterBody: (items) => {
              const agg = top3Agg.value.find((g) => g.subtype === items[0].label);
              return agg?.students.map((s) => `· ${s.studentName}`) ?? [];
            },
          },
        },
      },
      scales: {
        x: { beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { stepSize: 1, precision: 0, maxRotation: 0, minRotation: 0, color: "#5d7fa6", font: { size: 15 } } },
        y: {
          beginAtZero: true,
          border: { display: false },
          grid: { color: "rgba(63, 140, 255, 0.08)" },   // 极淡横向参考线：填补背景又不形成方框
          ticks: { maxTicksLimit: 6, precision: 0, color: "#5d7fa6" },   // 最多 6 档且恒为整数
        },
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
    plugins: [neonGlow],
    data: {
      labels: [],
      datasets: [
        { label: "成功", data: [], borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,0.18)", tension: 0.4, fill: true, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.5 },
        { label: "报错", data: [], borderColor: "#ff5f6d", backgroundColor: "rgba(255,95,109,0.15)", tension: 0.4, fill: true, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.5 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, color: "#9fd4ff", font: { size: 13 } } }, tooltip: { ...tooltipStyle } },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: "#5d7fa6", maxRotation: 0, minRotation: 0, font: { size: 15 } } },
        y: {
          beginAtZero: true,
          border: { display: false },
          grid: { color: "rgba(63, 140, 255, 0.08)" },   // 极淡横向参考线
          ticks: { maxTicksLimit: 6, color: "#5d7fa6" },
        },
      },
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
    type: "pie",
    data: {
      labels: [],
      datasets: [{
        data: [],
        backgroundColor: statusCounts.value.map((s) => s.color),
        borderColor: "rgba(4, 10, 22, 0.9)",   // 深色分隔线：扇区切分感
        borderWidth: 2,
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: 6 },
      plugins: {
        legend: { position: "right", labels: { boxWidth: 12, color: "#9fd4ff", font: { size: 14 }, padding: 10 } },
        tooltip: { ...tooltipStyle, displayColors: true, boxWidth: 10, callbacks: { label: (ctx) => ` ${ctx.label}：${ctx.parsed} 人` } },
      },
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
    const top3 = top3Agg.value;                 // 服务端已按涉及人数降序，只取 Top3（大屏可读性）
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
  if (pieChart) {
    pieChart.data.labels = statusCounts.value.map((s) => s.label);
    pieChart.data.datasets[0].data = statusCounts.value.map((s) => s.count);
    pieChart.update();
  }
}

onMounted(async () => {
  await nextTick();
  initBar(); initLine(); initPie();
  updateCharts();
});
onBeforeUnmount(() => { barChart?.destroy(); lineChart?.destroy(); pieChart?.destroy(); });
watch(
  () => store.snapshot,
  async () => {
    await nextTick();   // 等待空态→有数据切换后渲染出 canvas
    initBar(); initLine(); initPie();
    updateCharts();
  },
  { deep: true },
);
</script>

<template>
  <section class="charts-row" v-if="store.snapshot">
    <!-- 【注释保留】作业完成度卡（恢复步骤见脚本区注释块）：
    <div class="chart-card tech-card completion">
      <h2 class="tech-title">作业完成度</h2>
      <p v-if="!displayItem" class="empty">{{ completionEmpty }}</p>
      <div v-else class="focus">
        <div class="tank-wrap">
          <div class="tank">
            <div class="ticks" />
            <div class="liquid" :style="{ height: focusPct + '%' }">
              <i class="wave w1" /><i class="wave w2" />
              <i class="bubble b1" /><i class="bubble b2" /><i class="bubble b3" />
            </div>
            <div class="tank-pct">{{ focusPct }}<small>%</small></div>
          </div>
          <div class="tank-base" />
        </div>
        <div class="focus-info">
          <div class="focus-name" :title="displayItem.displayName">{{ displayItem.title }}</div>
          <div class="focus-nums">
            <span class="ok"><i class="dot" />已通过 <b>{{ displayItem.passed }} 人</b></span>
            <span class="doing"><i class="dot" />编码中 <b>{{ displayItem.total - displayItem.passed }} 人</b></span>
          </div>
        </div>
      </div>
      <select v-if="sortedItems.length" v-model="selectedId" class="ex-select" title="选择要展示的作业">
        <option v-for="e in sortedItems" :key="e.id" :value="e.id">{{ e.title }}（{{ e.passed }}/{{ e.total }}）</option>
      </select>
    </div>
    -->
    <div class="chart-card tech-card">
      <h2 class="tech-title">全班状态占比</h2>
      <p v-if="!store.snapshot.students.length" class="empty">暂无学员数据</p>
      <div v-else class="chart-wrap"><canvas ref="pieRef" /></div>
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
.chart-card h2 { font-size: 20px; }
/* 作业选择下拉框：右上角贴角（tech-card 已 relative），深色科技风 */
.completion .ex-select {
  position: absolute; right: 10px; top: 8px; z-index: 5; max-width: 52%;
  background: rgba(8, 20, 42, 0.85); color: var(--text-secondary);
  border: 1px solid var(--tech-card-border); border-radius: 2px;
  font-size: 13px; padding: 3px 6px; cursor: pointer; outline: none;
}
.completion .ex-select:hover, .completion .ex-select:focus { border-color: var(--tech-cyan); box-shadow: 0 0 8px rgba(124, 231, 255, 0.35); }
.completion .ex-select option { background: #0c1d38; color: var(--text-primary); }
.comp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.comp-head .overall { font-size: 13px; color: var(--text-dim); white-space: nowrap; }
.comp-head .overall strong { font-family: var(--font-num); font-size: 26px; color: var(--tech-cyan); margin-left: 4px; font-variant-numeric: tabular-nums; text-shadow: 0 0 8px rgba(80, 220, 255, 0.8); }
.chart-wrap { flex: 1; min-height: 160px; position: relative; }   /* 高度随卡片弹性拉伸（chart.js responsive 自适应），不再写死 240px */
.chart-wrap::before { content: ""; position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse at 50% 0%, rgba(63, 140, 255, 0.1), transparent 62%); }   /* 顶部微光：给图区垫一层纵深 */
/* —— 单题水桶模式（完成度卡）：竖直水桶 + 液面随通过人数上涨 —— */
.completion .focus { flex: 1; display: flex; align-items: center; justify-content: center; gap: 56px; min-height: 0; }   /* 居中：左右空白近似相等 */
.tank-wrap { display: flex; flex-direction: column; align-items: center; gap: 6px; align-self: stretch; justify-content: center; }
.tank {
  position: relative; width: 170px; height: 100%; max-height: 380px; min-height: 260px;
  border: 1px solid var(--tech-card-border); border-top: none;
  border-radius: 4px 4px 16px 16px;
  background: rgba(8, 20, 42, 0.6);
  box-shadow: inset 0 0 24px rgba(30, 90, 200, 0.18), 0 0 16px rgba(63, 140, 255, 0.22);
  overflow: hidden;
}
.tank-base { width: 200px; height: 6px; border-radius: 3px; background: rgba(63, 140, 255, 0.35); box-shadow: 0 0 12px rgba(63, 140, 255, 0.5); }
.ticks {
  position: absolute; inset: 0; pointer-events: none; z-index: 3;
  background: repeating-linear-gradient(to top, transparent 0 calc(10% - 1px), rgba(255, 255, 255, 0.14) calc(10% - 1px) 10%);
}
.liquid {
  position: absolute; bottom: 0; left: 0; right: 0; z-index: 1;
  background: linear-gradient(180deg, rgba(34, 197, 94, 0.9), rgba(21, 128, 61, 0.95));
  box-shadow: inset 0 0 24px rgba(34, 197, 94, 0.4), 0 0 18px rgba(34, 197, 94, 0.35);
  transition: height 0.8s ease;
}
.liquid .wave {
  position: absolute; top: -12px; left: -25%; width: 200%; height: 24px;
  border-radius: 50%; background: rgba(34, 197, 94, 0.85);   /* 波浪与绿液同色，只作液面高光 */
  box-shadow: 0 0 14px rgba(34, 197, 94, 0.55);
}
.liquid .wave.w1 { animation: tank-wave 5s ease-in-out infinite alternate; }
.liquid .wave.w2 { animation: tank-wave 8s ease-in-out infinite alternate-reverse; opacity: 0.6; }
@keyframes tank-wave {
  /* 轻微起伏：±2.5° 摇摆 + 平移（往复动画无缝循环），不再整体旋转（旋转会让细长波条扫成对角斜线） */
  from { transform: translateX(-4%) rotate(2.5deg); }
  to { transform: translateX(4%) rotate(-2.5deg); }
}
.liquid .bubble {
  position: absolute; bottom: 0; width: 8px; height: 8px; border-radius: 50%;
  background: rgba(255, 255, 255, 0.35); box-shadow: 0 0 6px rgba(120, 255, 190, 0.6); animation: tank-bubble 4s ease-in infinite;
}
.liquid .bubble.b1 { left: 22%; animation-delay: 0s; }
.liquid .bubble.b2 { left: 55%; width: 5px; height: 5px; animation-delay: 1.4s; }
.liquid .bubble.b3 { left: 78%; width: 6px; height: 6px; animation-delay: 2.3s; }
@keyframes tank-bubble {
  0% { transform: translateY(0); opacity: 0; }
  15% { opacity: 0.7; }
  100% { transform: translateY(-160px); opacity: 0; }
}
.tank-pct {
  position: absolute; top: 34%; left: 0; right: 0; z-index: 2; text-align: center;
  font-family: var(--font-num); font-size: 44px; font-weight: 800; color: #fff;
  text-shadow: 0 0 16px rgba(80, 220, 255, 0.9); font-variant-numeric: tabular-nums;
}
.tank-pct small { font-size: 20px; font-weight: 600; }
.completion .focus-info { display: flex; flex-direction: column; gap: 52px; max-width: 230px; align-self: center; }   /* 贴内容收缩（写死宽度会在右侧留一大块空白导致视觉不居中）；题名超长时按 230px 换行 */
.completion .focus-name { color: var(--text-primary); font-size: 20px; font-weight: 700; line-height: 1.45; text-align: left; margin: 0; overflow-wrap: anywhere; text-shadow: 0 0 10px rgba(80, 160, 255, 0.6); }
.completion .focus-nums { display: flex; flex-direction: column; gap: 16px; font-size: 17px; }
.completion .focus-nums span { display: flex; align-items: center; gap: 9px; }
.completion .focus-nums .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.completion .focus-nums b { margin-left: 14px; font-family: var(--font-num); font-weight: 700; font-variant-numeric: tabular-nums; }   /* 人数紧跟状态名固定间距，两行等宽标签天然上下对齐 */
.completion .focus-nums .ok .dot { background: var(--tech-green); box-shadow: 0 0 6px rgba(34, 197, 94, 0.7); }
.completion .focus-nums .doing .dot { background: var(--tech-blue); box-shadow: 0 0 6px rgba(63, 169, 255, 0.7); }
.completion .focus-nums .ok { color: var(--tech-green); }
.completion .focus-nums .doing { color: var(--tech-blue); }   /* 只有已通过/正在进行中两态：报错细节由全班状态与错误TOP3表达 */
@media (prefers-reduced-motion: reduce) {
  .liquid .wave, .liquid .bubble { animation: none; }
}
.empty { margin: auto 0; color: var(--text-dim); font-size: 15px; text-align: center; }
</style>
