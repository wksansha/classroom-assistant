<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, watch, nextTick, ref } from "vue";
import type { ExerciseProgressItem, TaskBucket } from "@classroom/shared";
import {
  Chart, BarController, BarElement,
  LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler,
} from "chart.js";
import { useClassroom } from "../stores/classroom";
import { baseName, findItemByBase, lessonFileOptions, pickDefaultTask, pickFocusFile } from "../focusSelection";

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler);
Chart.defaults.color = "#9fd4ff";
Chart.defaults.borderColor = "rgba(63, 140, 255, 0.2)";

/** 柱体垂直渐变（统一红色系：错误=红是本屏最强语义，类别信息由 x 轴标签与 tooltip 承载）：
 * 顶部亮、向下渐隐成光柱（chartArea 未布局完成的首帧回退纯色） */
const barGradient = (ctx: { chart: { chartArea?: { top: number; bottom: number }; ctx: CanvasRenderingContext2D } }) => {
  const area = ctx.chart.chartArea;
  if (!area) return "#ff5f6d";
  const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
  g.addColorStop(0, "#ffa2aa");
  g.addColorStop(0.35, "#ff5f6d");
  g.addColorStop(1, "#7e1d24");   // 底部深红收口：柱身瘦了之后拉大明暗差，光柱层次才立得住
  return g;
};

/** 柱顶数值标签：投影下无需悬浮即可读数（瘦柱后"高度"不再是唯一信息维度） */
const barValueLabels = {
  id: "barValueLabels",
  afterDatasetsDraw(chart: Chart) {
    const meta = chart.getDatasetMeta(0);
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = "700 19px Bahnschrift, Consolas, monospace";
    ctx.fillStyle = "#ffb3b9";
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(255, 95, 109, 0.6)";
    ctx.shadowBlur = 6;
    for (const el of meta.data) {
      const v = (el as unknown as { $context?: { raw?: number } }).$context?.raw;
      if (typeof v === "number") ctx.fillText(String(v), el.x, el.y - 9);
    }
    ctx.restore();
  },
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

/** 悬浮提示科技风（两图共用）：深蓝面板+青描边+大字号，色标为 8px 实心小圆点（与图例/全班状态圆点一致） */
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
  boxWidth: 8, boxHeight: 8,
  usePointStyle: true, pointStyle: "circle" as const,
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
  const offset = 21;   // 柱厚 30 的一半 + 间隙（瘦柱后锚点贴近柱体）
  const flip = !!area && el.x + offset + 160 > area.right;   // 预估悬浮框宽 160px
  return { x: flip ? el.x - offset : el.x + offset, y: el.y, xAlign: flip ? "right" : "left", yAlign: "center" };
};

const store = useClassroom();
const barRef = ref<HTMLCanvasElement | null>(null);
const lineRef = ref<HTMLCanvasElement | null>(null);
let barChart: Chart | null = null;
let lineChart: Chart | null = null;

// —— 作业完成度（单题水桶 + 多任务桶，spec 2026-11-09 §6）：文件下拉 + 任务 tab ——
const allItems = computed(() => store.snapshot?.exerciseProgress ?? []);
const completionEmpty = computed(() =>
  allItems.value.length === 0 ? "暂无题目数据" : "全员通过，干得漂亮");

// 文件焦点（用户 2026-11-10 交互重做）：有预选 → 下拉只列预选文件（保存顺序、默认第一个），
// 完全以教师选择为准（不混入涌现/自动模式）；无预选 → 无下拉，自动挑题，原下拉位置显示当前文件名
const lessonFiles = ref<string[]>([]);
const selectedFileId = ref<string | null>(null);
const fileOptions = computed(() => lessonFileOptions(lessonFiles.value));
// 预选清单变化（保存/清空）→ 默认第一个；选中项不在清单里 → 回第一个
watch(lessonFiles, (files) => {
  if (files.length && (!selectedFileId.value || !files.includes(selectedFileId.value))) {
    selectedFileId.value = files[0];
  }
  if (!files.length) selectedFileId.value = null;
}, { immediate: true });
// 「最新动态」自动挑题（无预选时）：有评审牵引（passed>0）优先 → 涌现时间最新
const autoFocusId = computed(() => pickFocusFile(allItems.value));
// 下拉绑定：清单就绪前 selectedFileId 尚未落值，get 回退第一个，避免 select 显示空白
const selectModel = computed({
  get: () => selectedFileId.value ?? lessonFiles.value[0] ?? "",
  set: (v: string) => { selectedFileId.value = v; },
});
// 预选清单：挂载拉取一次，失败静默（无预选 → 自动挑题模式）
onMounted(() => {
  fetch("/api/classroom/lesson-files")
    .then((r) => (r.ok ? r.json() : { files: [] }))
    .then((d: { files?: string[] }) => { lessonFiles.value = d.files ?? []; })
    .catch(() => { /* 接口未上线/离线：自动挑题模式 */ });
});

// 焦点题：教师预选优先，否则「最新动态」；预选按文件名匹配涌现题（路径带目录 vs 裸名），
// 未涌现 → 零进度虚拟桶（0/在线人数，液面 0%）
const displayItem = computed<ExerciseProgressItem | null>(() => {
  const targetId = selectedFileId.value ?? autoFocusId.value;
  if (!targetId) return null;
  const found = findItemByBase(allItems.value, targetId);
  if (found) return found;
  const label = baseName(targetId);
  return {
    id: targetId, displayName: label, isProject: false,
    passed: 0, stuck: 0, unreviewed: 0,
    total: store.snapshot?.stats.online ?? 0, passRate: 0,   // 在线口径（服务端已计入在线数，虚拟桶同分母）
    firstTs: 0, latestTs: 0, title: label,
  };
});

// 任务 tab：多任务题（任务声明 ≥2）显示；换文件重置选中；默认第一个未全员通过的桶
const selectedTaskId = ref<string | null>(null);
const activeTasks = computed<TaskBucket[]>(() => displayItem.value?.tasks ?? []);
watch(() => displayItem.value?.id, () => { selectedTaskId.value = null; });
const activeTask = computed<TaskBucket | null>(() => {
  const tasks = activeTasks.value;
  if (!tasks.length) return null;
  const total = displayItem.value?.total ?? 0;
  return tasks.find((b) => b.taskId === selectedTaskId.value)
    ?? tasks.find((b) => b.taskId === pickDefaultTask(tasks, total))
    ?? tasks[0];
});
const focusPassed = computed(() => activeTask.value?.passed ?? displayItem.value?.passed ?? 0);
// 液面高度 = 已通过/总人数，与中央百分比严格一致；绿液涨到顶 = 全员通过
const focusPct = computed(() => {
  const total = displayItem.value?.total ?? 0;
  return total > 0 ? Math.round((focusPassed.value / total) * 100) : 0;
});

/** 错误TOP3 数据引用（tooltip 悬停显示涉事学员名单用） */
const top3Agg = computed(() => store.snapshot?.aggregates.slice(0, 3) ?? []);

// 两卡（节奏/错误TOP3 chart.js）各自独立 init/update：某卡无数据时不阻塞其余卡片（spec §5.5）
function initBar() {
  if (!barRef.value) return;
  if (barChart) {
    if (barChart.canvas === barRef.value) return;
    barChart.destroy();
    barChart = null;
  }
  barChart = new Chart(barRef.value, {
    type: "bar",
    data: {
      labels: [],
      datasets: [{
        label: "涉及人数", data: [],
        backgroundColor: barGradient,
        borderColor: "#ff8a93",
        borderWidth: 1,
        borderRadius: { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 },
        barThickness: 30, maxBarThickness: 40,
      }],
    },   /* 瘦光柱：仅顶部圆角，红色系渐变+辉光负责质感 */
    plugins: [neonGlow, barValueLabels],
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
              return agg ? [`类别：${agg.category}`, ...agg.students.map((s) => `· ${s.studentName}`)] : [];
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
      // 图例用模板里的 HTML 自绘（.rhythm-legend），样式与全班状态图例行完全一致
      plugins: { legend: { display: false }, tooltip: { ...tooltipStyle } },
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
    <div class="chart-card tech-card">
      <h2 class="tech-title">课堂节奏</h2>
      <p v-if="!store.snapshot.trend.length" class="empty">暂无运行数据</p>
      <template v-else>
        <div class="chart-wrap"><canvas ref="lineRef" /></div>
        <!-- HTML 自绘图例：10px 实心发光圆点 + 15px 字号，逐条复制全班状态顶部图例行样式 -->
        <div class="rhythm-legend">
          <span class="runs"><i class="lg" />成功</span>
          <span class="errs"><i class="lg" />报错</span>
        </div>
      </template>
    </div>
    <div class="chart-card tech-card completion">
      <h2 class="tech-title">作业完成度</h2>
      <!-- 用户 2026-11-11 定稿：顶部（对齐「度」字）下拉/文件名只在多任务时显示；单任务时右列任务区放
           下拉（有预选，可直接切换）或文件名（无预选），顶部留空 -->
      <select v-if="lessonFiles.length && activeTasks.length >= 2" v-model="selectModel" class="file-select" title="切换焦点文件">
        <option v-for="o in fileOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
      </select>
      <!-- 无预选多任务：顶部显示当前文件名（17px 与已通过同字号） -->
      <span v-else-if="displayItem && activeTasks.length >= 2" class="focus-name" :title="displayItem.displayName">{{ displayItem.displayName }}</span>
      <!-- 层次（用户 2026-11-10 定稿）：左水桶居中，右列 = 任务 tab + 已通过/编码中 整体垂直居中 -->
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
        <div class="side-col">
          <div v-if="activeTasks.length >= 2" class="task-tabs">
            <button
              v-for="b in activeTasks" :key="b.taskId"
              class="task-tab" :class="{ active: activeTask?.taskId === b.taskId }"
              @click="selectedTaskId = b.taskId"
            >{{ b.taskId }}</button>
          </div>
          <!-- 单任务/无任务题（用户 2026-11-11 定稿）：任务区补位——有预选放下拉（流式，可切换文件），无预选放文件名；
               复用 task-tabs 容器保持布局高度稳定 -->
          <div v-else class="task-tabs">
            <select v-if="lessonFiles.length" v-model="selectModel" class="file-select in-task" title="切换焦点文件">
              <option v-for="o in fileOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
            </select>
            <span v-else class="task-tab file-name" :title="displayItem.displayName">{{ displayItem.displayName }}</span>
          </div>
          <div class="focus-nums">
            <span class="ok"><i class="dot" />已通过 <b>{{ focusPassed }} 人</b></span>
            <span class="doing"><i class="dot" />编码中 <b>{{ displayItem.total - focusPassed }} 人</b></span>
          </div>
        </div>
      </div>
    </div>
    <div class="chart-card tech-card">
      <h2 class="tech-title">错误类型TOP3</h2>
      <p v-if="!store.snapshot.aggregates.length" class="empty">暂无错误数据</p>
      <div v-else class="chart-wrap"><canvas ref="barRef" /></div>
    </div>
  </section>
</template>

<style scoped>
/* .charts-row 网格定义在全局 style.css（Step 5），此处只写卡内样式 */
.chart-card { padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.chart-card h2 { font-size: 20px; }
.chart-wrap { flex: 1; min-height: 160px; position: relative; }   /* 高度随卡片弹性拉伸（chart.js responsive 自适应），不再写死 240px */
.chart-wrap::before { content: ""; position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse at 50% 0%, rgba(63, 140, 255, 0.1), transparent 62%); }   /* 顶部微光：给图区垫一层纵深 */
/* —— 课堂节奏 HTML 自绘图例：逐条复制全班状态图例行样式（10px 实心发光圆点 + 15px 字号 + 同款间距）—— */
.rhythm-legend { flex: none; display: flex; justify-content: center; gap: 14px; font-size: 15px; }
.rhythm-legend .lg { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 6px; vertical-align: -1px; }
.rhythm-legend .runs { color: var(--tech-green); }
.rhythm-legend .runs .lg { background: var(--tech-green); box-shadow: 0 0 6px rgba(34, 197, 94, 0.7); }
.rhythm-legend .errs { color: var(--tech-red); }
.rhythm-legend .errs .lg { background: var(--tech-red); box-shadow: 0 0 6px rgba(255, 95, 109, 0.8); }
/* —— 单题水桶模式（完成度卡）：竖直水桶 + 液面随通过人数上涨；文件下拉 + 任务 tab（spec 2026-11-09 §6）——
 * 下拉框在标题下自成一行（右对齐，流式布局），物理上不可能遮挡标题 */
.completion .file-select {
  flex: none; width: 170px;   /* 与水桶同宽，右列视觉统一（用户 2026-11-10） */
  padding: 3px 8px; font-size: 17px; font-family: inherit; cursor: pointer;   /* 17px 与「已通过」同字号（用户 2026-11-11） */
  color: var(--text-secondary); background: rgba(20, 50, 100, 0.5);
  border: 1px solid rgba(63, 140, 255, 0.35); border-radius: 2px; outline: none;
  text-overflow: ellipsis;
}
.file-select:hover { border-color: var(--tech-cyan); }
.file-select option, .file-select optgroup { background: #0a1830; color: var(--text-primary); }
/* 任务 tab 竖排靠右（用户 2026-11-10 反馈）：focus 行内右侧栏，高度自适应任务数，
 * 极端超多任务 → 本列内部滚动（max-height 不超 focus 高），水桶/人数完全不受挤压 */
.task-tabs {
  width: 150px;   /* 固定宽：嵌套 flex 里百分比宽度会塌陷成 "t…"（38% 相对父列解析过小）；列内位置由 side-col 整体居中控制（margin-top:auto 沉底方案已弃——中间空洞不美观，用户 2026-11-10） */
  display: flex; flex-direction: column; align-items: stretch; justify-content: flex-start;
  gap: 4px; flex: 0 1 auto; min-height: 72px; max-height: 168px;   /* 任务区整体压缩（用户 2026-11-10）：高度只缩不涨（不抢水桶空间），保底约 3 个、封顶 168；超出内部滚动（滚动条已隐藏） */
  overflow-y: auto; padding: 2px;
}
.task-tabs { scrollbar-width: none; -ms-overflow-style: none; }   /* 隐藏滚动条（用户 2026-11-10），滚轮仍可滚动 */
.task-tabs::-webkit-scrollbar { display: none; }
.task-tab {
  flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 2px 14px; font-size: 14px; cursor: pointer; border-radius: 2px;
  border: 1px solid rgba(63, 140, 255, 0.3); background: transparent; color: var(--text-dim);
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.task-tab:hover { color: var(--text-secondary); }
.task-tab.file-name { cursor: default; color: var(--text-secondary); }   /* 单任务题文件名占位块（用户 2026-11-11）：静态不可点 */
.task-tab.active {
  border-color: var(--tech-cyan); color: var(--tech-cyan);
  background: rgba(63, 169, 255, 0.12); text-shadow: 0 0 6px rgba(80, 220, 255, 0.5);
}
.completion { gap: 14px; position: relative; }   /* 标题与内容拉开；relative 供下拉框 absolute 定位（用户 2026-11-10） */
/* 下拉框悬浮定位（用户 2026-11-10 重申）：垂直在「作业完成度」标题与桶顶之间的缝隙带（top 22px），
 * 水平左缘对齐标题「度」字左缘——标题 5 字居中，度字左缘 ≈ 卡中心 + 35px。
 * 不占文档流，标题保持绝对居中，不再被 grid 列挤偏 */
.completion .file-select { position: absolute; top: 50px; left: calc(50% + 35px); z-index: 2; }   /* top 50（用户 2026-11-10 指定）：标题行之下再往下沉，桶顶之上 */
.completion .file-select.in-task { position: static; width: 150px; }   /* 单任务补位下拉（用户 2026-11-11）：流式放进右列任务区，宽度对齐任务列 */
/* 无预选模式（用户 2026-11-10）：不下拉，原下拉位置静态显示当前焦点文件名（与下拉同位同字号） */
.completion .focus-name {
  position: absolute; top: 50px; left: calc(50% + 35px); z-index: 2;
  max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 17px; color: var(--text-secondary);   /* 17px 与「已通过」同字号（用户 2026-11-11） */
}
.completion .focus { flex: 1; display: flex; align-items: stretch; justify-content: center; gap: 48px; min-height: 0; }   /* 两列拉伸填满剩余高度（底部不留白，用户 2026-11-10）：水桶顶=下拉框顶、水桶底≈人数列底 */
.completion .side-col { flex: none; width: 150px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 24px; min-height: 0; height: 100%; }   /* 宽度锁 150：任务 tab 出现/消失不改变列宽，切换下拉时水桶不左右移动（用户 2026-11-10）；两块整体垂直居中，中线与水桶一致 */
.tank-wrap { flex: none; display: flex; flex-direction: column; align-items: center; gap: 6px; justify-content: center; }
.tank {
  position: relative; width: 170px; height: 100%; max-height: 380px; min-height: 260px;   /* 随卡片拉伸但收上限 380（用户 2026-11-10：去上限后太高，380 为平衡值），min 260 保底 */
  border: 1px solid var(--tech-card-border); border-top: none;
  border-radius: 4px 4px 16px 16px;
  /* 玻璃管容器感：底槽渐暗 + 两侧 1px 高光（::after 绘制），不再是画在背景上的涂色柱 */
  background: linear-gradient(180deg, rgba(8, 20, 42, 0.55), rgba(4, 10, 22, 0.8) 90%);
  box-shadow: inset 0 0 24px rgba(30, 90, 200, 0.18), 0 0 16px rgba(63, 140, 255, 0.22);
  overflow: hidden;
}
.tank::after {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 4;
  background: linear-gradient(90deg,
    rgba(255, 255, 255, 0.08) 0, rgba(255, 255, 255, 0.08) 1px,
    transparent 1px, transparent calc(100% - 1px),
    rgba(255, 255, 255, 0.08) calc(100% - 1px));
}
.tank-base { width: 200px; height: 6px; border-radius: 3px; background: rgba(63, 140, 255, 0.35); box-shadow: 0 0 12px rgba(63, 140, 255, 0.5); }
.ticks {
  position: absolute; inset: 0; pointer-events: none; z-index: 3;
  background: repeating-linear-gradient(to top, transparent 0 calc(10% - 1px), rgba(255, 255, 255, 0.07) calc(10% - 1px) 10%);
}
.liquid {
  position: absolute; bottom: 0; left: 0; right: 0; z-index: 1;
  /* 液体整体提亮：浅液位时"体"也读作实心绿，消除亮带下发黑的断层观感 */
  background: linear-gradient(180deg, rgba(74, 222, 128, 0.95), rgba(34, 197, 94, 0.9) 45%, rgba(28, 160, 80, 0.92));
  box-shadow: inset 0 0 24px rgba(34, 197, 94, 0.45), 0 0 18px rgba(34, 197, 94, 0.35);
  transition: height 0.8s ease;
}
.liquid .wave {
  position: absolute; top: -12px; left: -25%; width: 200%; height: 24px;
  border-radius: 50%; background: rgba(120, 235, 160, 0.9);   /* 波浪比液"体"再亮一档，作液面发光切线 */
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
.completion .focus-nums { flex: none; display: flex; flex-direction: column; gap: 16px; font-size: 17px; white-space: nowrap; margin-top: 2px; }   /* 人数列不收缩（用户 2026-11-10：不被任务列挤压，保持原样） */
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
