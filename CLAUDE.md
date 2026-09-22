# CLAUDE.md

本文件为 AI 编码助手（Claude Code / ZCode 等）在本仓库工作时的项目说明。

## 项目概述

Geogebra Webchat — AI 驱动的数学几何画板。用户输入自然语言数学题，AI（浏览器内 Vercel AI SDK 工具循环）生成 GeoGebra 命令并在实时画板执行，随后用文字解释几何关系。

**部署平台：EdgeOne Pages**（本项目为纯 EdgeOne 架构，没有独立服务器/Node 进程）。

## 架构

- **前端**：SolidJS + Vite（`src/`），构建产物为 `dist/` 静态文件
  - `src/ai-client.ts` — 核心浏览器内 AI 工具循环：Vercel AI SDK `streamText` + `executeGeoGebraCommands` 工具；所有 LLM 请求经 `proxyFetch` 改写到 `/llm-proxy`（带 `x-target-url` 头）
  - `src/geogebra.ts` — GeoGebra CDN 加载 + 画板控制（evalCommand、XML 快照恢复）
  - `src/lib/normalize.ts` — 中文命令别名 → GeoGebra 英文命令规范化
- **后端**：唯一后端是云函数 `cloud-functions/llm-proxy/index.ts`（路由 `/llm-proxy`）
  - 职责：CORS、按 `x-target-url` 透明转发（含 SSE 流式）、`MODEL_API_KEY` 服务端注入、GET 探测（返回 `{ serverKey }`）
  - 注意：`context.request.headers` 是 Web Headers 实例，必须用 `.get(name)` 读取
- **无服务器进程**：没有 Node 服务、没有 Bun；本地开发与生产都由 EdgeOne 运行时承载

## 环境变量

- `MODEL_API_KEY` — 模型服务 Key（服务端注入，写在 `.env`，部署时同步；`.env` 不入库）
- 默认模型 `deepseek/deepseek-flash`，前端右上角可改（默认值在 `src/App.tsx`）

## 本地开发与部署

```bash
npm install
edgeone makers dev        # 本地开发：http://localhost:8088（前端+云函数一体）
edgeone makers deploy -n geogebra-webchat   # 部署到 EdgeOne
```

## 关键约定（改动时不要破坏）

1. **前端所有 LLM 请求必须经 `/llm-proxy`**（CORS + Key 注入都依赖此通道）；代理逻辑只改 `cloud-functions/llm-proxy/index.ts`
2. **云函数 headers 是 Web Headers 实例**——用 `.get(name)` 读取，不要当普通对象遍历
3. GeoGebra 命令一律英文；中文别名由 `src/lib/normalize.ts` 处理
4. 画板命令失败时恢复 XML 快照（`restoreOnError`），避免画板脏状态
5. 效果截图与参考文档在 `doc/` 目录
