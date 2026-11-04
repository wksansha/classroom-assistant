# 大屏科技荧光风改版 + 四图表（二期 Task 16）设计

- 日期：2026-11-04
- 状态：已评审（风格与布局经草图对比后用户拍板）
- 上游文档：`2026-10-21-dashboard-v2-design.md`（V2 信息架构与数据口径）、`plans/2026-10-22-dashboard-v2.md`（一期 Task 1-15 已实施、Task 16 二期遗留）

## 1. 背景与目标

一期大屏（V2）已上线：按天窗口、题目当天涌现、登录态在线模型、全班矩阵、AI 建议卡、学生抽屉。遗留两项：

1. **Task 16 四图表**（spec 决策 #17 推迟到二期的 ChartsRow）：作业完成度、错误类型分布、全班状态占比、课堂节奏。
2. **视觉改版**：现版亮色基础风格升级为**科技荧光风**——参考华为运动大屏的信息层级与开源模板（IofTV-Screen-Vue3 / DataV / BigDataView）的深色大屏元素，但不照搬其整套科技荧光皮肤（经四版草图对比：华为深灰、军事风（否）、科技荧光、简约亮色精修，用户最终拍板科技荧光风）。

## 2. 决策记录

| # | 决策 | 说明 |
|---|---|---|
| 1 | 布局沿用方案 A 骨架 | 顶栏统计条 → 左矩阵（3fr）+ 右 AI 建议列（2fr）→ 底部四图表行（2fr 1fr 1fr 1fr）。信息架构零变化，纯换皮 + 新增图表行 |
| 2 | 风格定为科技荧光风 | 深蓝星空渐变底 + 网格纹理；发光描边卡片 + 四角折角标；标题发光 + 大字距；荧光图表色。无星空粒子动画、无扫描线动效（静态发光即可） |
| 3 | 措辞全部维持现状 | 「课堂教学实时助教 / 全班状态 / 在线 / 急需帮助 / 未在线 / 教学建议」；军事化措辞（在位/离位/态势）已否决 |
| 4 | 状态饼仅统计在线学生 | 三值 red/yellow/green 入饼，未在线不入（沿用 V2 决策 #19「未在线不占状态」，矩阵图例已有未在线计数） |
| 5 | 完成度卡按涌现口径重设计 | 旧设计的 notStarted/avgAttempts 随决策 #18 失效，不引入；详见 §5.1 |
| 6 | 深色主题作用域限定主视图 | `#/admin` 花名册管理、登录页、提交矩阵等 admin 域维持亮色现状；深色样式全部限定在主视图 `.app` 容器内（避免共享 token 翻车与无谓回归） |
| 7 | 大屏等比缩放不做 | YAGNI：当前 CSS 自适应 + 浏览器全屏已满足教室大屏场景；v-scale-screen 记入后续迭代清单 |
| 8 | 学生端/服务端零改动 | 纯 dashboard 前端包改造；快照协议（exerciseProgress/trend/stats）一期已就位 |

## 3. 设计系统（tokens）

### 3.1 颜色

```css
/* 主视图作用域（.app 容器内覆盖，不影响 admin 域） */
.app {
  --tech-bg-grad: radial-gradient(1200px 500px at 50% -100px, #0b1e3a 0%, #060d1a 55%, #04070d 100%);
  --tech-grid: rgba(56, 132, 255, 0.05);        /* 网格线 */
  --tech-card-grad: linear-gradient(180deg, rgba(16,42,80,.55), rgba(8,20,42,.75));
  --tech-card-border: rgba(63, 140, 255, 0.45);
  --tech-card-glow: 0 0 14px rgba(30,100,220,.25), inset 0 0 24px rgba(30,90,200,.12);
  --tech-corner: #7ce7ff;                        /* 四角折角标 */
  --text-primary: #d8ecff;                       /* 主文字 */
  --text-secondary: #9fd4ff;                     /* 卡片标题 */
  --text-dim: #5d7fa6;                           /* 弱化文字/空态 */
  --tech-cyan: #7ce7ff;                          /* 强调青 */
  --tech-blue: #3fa9ff;                          /* 主蓝 */
  /* 状态三值（荧光变体，语义不变） */
  --tech-red: #ff5f6d;
  --tech-yellow: #ffc53d;
  --tech-green: #22c55e;
  --tech-offline: rgba(90, 120, 160, 0.25);      /* 未在线 */
}
```

### 3.2 卡片规范

- 背景 `--tech-card-grad`、1px 描边 `--tech-card-border`、外发光+内辉光 `--tech-card-glow`、圆角 2px（硬朗）
- 四角折角标：`::before`（左上）+ `::after`（右下），10px L 形 2px 描边 `--tech-corner`
- 卡片标题：居中、`letter-spacing: 3px`、`--text-secondary`、`text-shadow: 0 0 8px rgba(80,160,255,.7)`，两侧 `››› ‹‹‹` 装饰符

### 3.3 字体与数字

- 数字一律 `font-variant-numeric: tabular-nums`；顶栏统计大数字 ≥16px
- 矩阵瓦片字号维持一期 ≥16px 规格

## 4. 布局与组件改造点

### 4.1 StatusBar（顶栏）

- 布局改居中式：统计胶囊（在线/急需帮助/运行次数）分列左右，标题居中发光，底部一条渐变发光线（`linear-gradient` + `box-shadow`）
- 标题「课堂教学实时助教」白字发光、字距 6px
- 统计数字青色发光；急需帮助红色发光
- 日期时钟右上弱化色；SSE 连接状态标识保留（右侧小字）

### 4.2 StudentMatrix（学生矩阵）

- 卡片套 §3.2 规范；图例由纯文字改「色点 + 文字」横排（红/黄/绿/未在线，沿用现有计数逻辑 `statusCounts`）
- 瓦片：深色底小卡（`rgba(20,50,100,.4)` + 状态色描边），状态圆点加同色 glow；`offline` 类维持变暗（opacity 0.45）+ 灰点
- 瓦片悬停/点击打开抽屉行为不变

### 4.3 AIPanel（AI 建议卡）

- 卡片套 §3.2 规范；AI 徽标紫色改**青色发光徽标**（科技风统一强调色，去紫色）
- 建议卡左侧色条维持 kind 语义（class-review 红 / group-discuss 黄 / individual 绿），底色改深色半透明

### 4.4 StudentDrawer（学生抽屉）

- 深色化：卡片底/文字/边框换 tokens，事件流样式微调（错误码等宽字色 `--tech-cyan`）
- 「本节课动态」措辞与数据口径不变

### 4.5 ChartsRow（新建，二期 Task 16 核心）

位置：`<main>` 之后、`<StudentDrawer />` 之前。网格 `2fr 1fr 1fr 1fr`，卡内图表高 240px。

### 4.6 背景（App 级）

- `.app` 背景 `--tech-bg-grad` + 两层 `linear-gradient` 网格纹理（36px 间距，`background-size`），`::before` 伪元素承载、`pointer-events: none`
- 无粒子、无动画

## 5. 四图表规格（数据源一期已就位，服务端零改动）

### 5.1 作业完成度卡（关注集，重设计）

- 数据源：`snapshot.exerciseProgress`（当天涌现三态；`total`=花名册人数、`passRate` 由装配层注入，决策 #18/#20）
- **关注集** = `passed < total` 的题；头部大数字「全班通过率」= `sum(passed)/sum(total)`（仅关注集计入，沿用决策 #16 口径）
- 堆叠柱：每题一根，三色堆叠——绿 `--tech-green`=已通过、红 `--tech-red`=卡住(fail)、蓝 `--tech-blue`=待评审(unreviewed)，均为当天人数；x 轴标签 `displayName` 45° 旋转
- 折叠：`passed === total` 的题不入柱，底部摘要「另有 N 题已全部通过」；关注集为空时：有涌现题→「全部作业已完成」，无涌现题→「暂无题目数据」

### 5.2 错误类型分布卡

- 数据源 `snapshot.aggregates`：柱状图，x=`category · subtype`，y=count；单系列 `--tech-blue`
- 空态：「暂无错误数据」

### 5.3 全班状态占比卡

- 环形图（doughnut），仅统计 `online === true` 学生三值；红/黄/绿三色（§3.1 状态色）
- 空态（无在线学生）：「暂无学生数据」

### 5.4 课堂节奏卡

- 数据源 `snapshot.trend`（5 分钟桶，当天过滤已在服务端完成）：双线图——运行 `--tech-cyan`（青，带渐变面积填充）、错误 `--tech-red`；x 轴 `HH:mm`
- 空态：「暂无运行数据」

### 5.5 工程约束

- chart.js 4 已在 dependencies（沿用）；按需 register；四卡各自独立 init/update + `watch(snapshot)` 深度监听，单卡无数据不阻塞其余卡
- 测试 mock chart.js（jsdom 无 canvas）；断言 DOM（标题、空态文案、关注集大数字、折叠摘要）
- tooltip 用 chart.js 内置（大屏现场无需自定义 HTML tooltip）

## 6. 非目标

- `#/admin`、登录页、提交矩阵样式不动（决策 #6）
- 服务端/shared DTO/学生端零改动
- 大屏等比缩放（v-scale-screen）记入后续迭代（决策 #7）
- 星空粒子、扫描线等动效不做（决策 #2）

## 7. 测试与验收

### 7.1 测试策略

- dashboard 组件测试全量回归（`pnpm --filter @classroom/dashboard exec vitest run`）：现有断言均为文案级（措辞不变），理论零破坏； ChartsRow 新建测试套件
- ChartsRow 测试：四卡标题渲染、完成度关注集大数字/折叠摘要/空态、其余三卡空态文案、canvas 数量（mock chart.js）

### 7.2 验收清单

1. 主视图深色科技风：星空渐变底 + 网格纹理 + 发光描边卡片 + 四角折角标
2. `#/admin` 亮色现状无变化
3. 四图表就位：有数据出图、无数据显示空态文案、单卡数据缺失不影响其余卡
4. 完成度卡口径正确：关注集通过率、三色堆叠、全员通过折叠摘要
5. 状态饼不含未在线学生
6. 措辞与一期完全一致
7. `pnpm -r test` 全量通过
