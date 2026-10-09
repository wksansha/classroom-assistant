# 部署指南（V1 上行闭环）

## 教师机（1 台，课堂内网）

### 环境
- Node.js ≥ 20、pnpm ≥ 9
- Windows：防火墙放行 3000 端口入站（学生机要连进来）

### 安装与启动
```bash
pnpm install
pnpm --filter @classroom/server start        # 默认 3000，可用 PORT 覆盖
```

### LLM 配置（可选）
仓库根 `.env`（未配置时自动 mock 兜底，功能完整但解释为通用模板）：
```
LLM_API_KEY=sk-xxx
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
PORT=3000
```

### 仪表盘
- 开发期：`pnpm dev:dashboard` → http://localhost:5173（/api 已代理到 3000）
- 生产：`pnpm --filter @classroom/dashboard build` 后直接开 http://<教师机IP>:3000/

## 学生机（N 台，VS Code + pylearner 扩展）

用户级 settings.json：
```json
{
  "pylearner.teacher.enabled": true,
  "pylearner.teacher.url": "http://<教师机IP>:3000"
}
```
- `pylearner.student.id`：不配置（扩展用 SecretStorage 自动生成稳定 ID）
- **学生姓名/班级配置方案暂缓定案**（2026-09-17 用户决定）：当前取值来源为扩展内 SecretStorage，settings.json 写入不生效；未配置时矩阵显示 Unknown/默认班（服务端已兜底，属预期现象）。批量配置方案定案后补充本文档
- 需 Task 21 的 runSuccess 改动已打进扩展包，否则绿色状态仅表示「无错误」（上报管道编译问题已由用户于 2026-09-17 修复）

## 常见问题
| 现象 | 原因/处理 |
|---|---|
| 矩阵全是 Unknown | 学生姓名/班级配置方案暂缓（预期现象，见学生机段说明） |
| 教师端无任何数据 | `teacher.url` 指错 / 防火墙未放行 / `teacher.enabled` 未开 |
| 解释全是模板文案 | `LLM_API_KEY` 未配置或无效（mock 兜底生效，属预期降级） |
| 时间显示差 8 小时 | 渲染未走 `toLocaleTimeString('zh-CN')`（本版已内置，勿改） |
| 重启后课堂状态清零 | 设计如此（spec §6），历史事件 SQLite 可查（GET /api/events） |
