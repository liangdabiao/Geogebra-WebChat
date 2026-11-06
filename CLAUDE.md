# CLAUDE.md

本文件为 AI 编码助手（Claude Code / ZCode 等）在本仓库工作时的项目说明。

## 项目概述

Geogebra Webchat — AI 驱动的数学几何画板。用户输入自然语言数学题，AI（浏览器内 Vercel AI SDK 工具循环）生成 GeoGebra 命令并在实时画板执行，随后用文字解释几何关系。

**部署平台：EdgeOne Makers**（本项目为纯 EdgeOne 架构，没有独立服务器/Node 进程）。

## 架构

- **前端**：SolidJS + Vite（`src/`），构建产物为 `dist/` 静态文件
  - `src/ai-client.ts` — 核心浏览器内 AI 工具循环：Vercel AI SDK `streamText` + `executeGeoGebraCommands` 工具；所有 LLM 请求经 `proxyFetch` 改写到 `/llm-proxy`（带 `x-target-url` 头）
  - `src/geogebra.ts` — 本地 vendor 的 GeoGebra 5.0（`public/geogebra/HTML5/5.0/web3d/`）加载 + 画板控制（evalCommand、XML 快照恢复、导出 API）
  - `src/lib/normalize.ts` — 中文命令别名 → GeoGebra 英文命令规范化
  - `src/lib/export.ts` — 下载工具、TikZ 文本规整、基于对象快照的 TikZ 降级生成器
  - `src/lib/image.ts` — 上传图片缩放 / JPEG 重编码，产出纯 base64
- **后端**：唯一后端是云函数 `cloud-functions/llm-proxy/index.ts`（路由 `/llm-proxy`）
  - 职责：CORS、按 `x-target-url` 透明转发（含 SSE 流式）、`MODEL_API_KEY` 服务端注入、GET 探测（返回 `{ serverKey }`）
  - 注意：`context.request.headers` 是 Web Headers 实例，必须用 `.get(name)` 读取
- **无服务器进程**：没有 Node 服务、没有 Bun；本地开发与生产都由 EdgeOne 运行时承载

## 环境变量

**两组二选一，不要同时填**（写在 `.env`，`.env` 不入库）：

- **A 组 · 自有厂商（当前默认）**：`MODEL_BASE_URL=https://api.deepseek.com/v1`、
  `MODEL_NAME=deepseek-flash`（自带视觉输入，可图片读题）、`MODEL_API_KEY`。
  Key 由云函数服务端注入，不进浏览器。
- **B 组 · EdgeOne 内置网关**：只填 `MAKERS_MODELS_KEY`，默认走
  `https://ai-gateway.edgeone.link/v1` + `@makers/deepseek-v4-flash`（免费额度 50 万 token/月，按账号共享）。
  两个默认值是 `cloud-functions/llm-proxy/index.ts` 里的 `DEFAULT_*` 常量。

- **Key 与端点必须成组切换**：配了 `MAKERS_MODELS_KEY` 就整组走 EdgeOne 网关并忽略 `MODEL_*`；
  反之不能只改端点不改 Key，否则「拿 A 的 Key 打 B 的网关」→ 401。
- 线上变量用 `edgeone makers env set KEY VALUE -e production` 写入；部署加
  `--skip-ai-gateway-sync`，防止 CLI 自动注入网关 Key 覆盖自有配置。

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
6. 导出走 `src/lib/export.ts` + `src/geogebra.ts` 接出的 API：`.ggb` 用 `getBase64()`、「打开 .ggb」用 `setBase64()`、TikZ 用未公开的 `exportPGF(cb)`（**必须保留三档降级**：原生导出 → 基于对象快照的生成器 → 导出 SVG）
7. 图片统一经 `src/lib/image.ts` 压缩后才发给模型；`/llm-proxy` 有 5.5MB 请求体保护，图片只在工具循环首步携带（`prepareStep`），历史轮自动剥离
8. 云函数成功响应**不要**退回 `new Headers(upstream.headers)` + `new Response(upstream.body)`：实测 EdgeOne 线上返回 200 但 body 为空，本地 `makers dev` 却正常。必须只透传 `content-type` / `cache-control` 等安全头（剔除 `transfer-encoding` / `content-length` / `connection`），并用惰性 `ReadableStream` 包一层上游 body，SSE 才不丢
9. 前端判断「是否仍在使用服务端注入的 Key」要对比云函数 GET 下发的 `baseURL` host（`usesServerEndpoint`），不要硬编码 `ai-gateway.edgeone.link`；换默认服务商时同步升级 `LS_*` 前缀，让老访客 localStorage 里的旧端点 / 模型名失效
10. 云函数里别再用 `body` 声明新变量（转发请求体已有 `let body`）——CLI 的 Babel 构建会直接报 `Identifier 'body' has already been declared` 并导致部署失败
