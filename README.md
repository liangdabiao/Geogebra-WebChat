# Geogebra Webchat — AI 驱动的数学几何画板

> 一句话在浏览器里创建可交互的数学图形。输入自然语言描述，AI 自动生成 GeoGebra 命令并在实时画板中呈现。

[![使用 EdgeOne Makers 部署](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/makers/new?repository-url=https%3A%2F%2Fgithub.com%2Fliangdabiao%2FGeogebra-WebChat)

---

## 谁适合用这个项目？

- **学生和教师**：想要快速创建数学几何图形辅助学习和教学，无需学习复杂的 GeoGebra 命令语法
- **数学/科研爱好者**：需要可视化函数、几何关系或数学模型
- **前端开发者**：对 AI 集成（Vercel AI SDK）、SolidJS 实践、数学可视化感兴趣
- **教育技术探索者**：研究如何将大语言模型与专业软件结合，降低使用门槛

---

## 项目背景与解决的需求

GeoGebra 是一款优秀的动态数学软件（Geometry + Algebra），全球用户超过 1 亿。然而，使用 GeoGebra 需要掌握其特定的命令语法，对初学者构成门槛。

与此同时，大语言模型在理解和生成自然语言方面的能力不断提升。**Geogebra Webchat 的核心思路**：让用户用自然语言描述数学问题，AI 自动转化为 GeoGebra 命令，在画板上实时构造图形，并用文字解释几何关系。

这带来了几个根本性的变化：
- **降低门槛**：不用记命令，说人话就行
- **提高效率**：一句「画一个正四面体并标出外接球」秒出结果
- **拓展场景**：经济学图表、物理模型、3D 几何都可以用自然语言生成

---

## 核心功能

- **自然语言作图**：输入数学/几何问题，AI 自动生成并执行 GeoGebra 命令
- **实时交互画板**：拖拽、缩放、旋转，图形与代数区联动
- **流式 Markdown 渲染**：AI 解释步骤实时显示，公式用 KaTeX 渲染
- **2D / 3D 支持**：平面几何和立体图形均可
- **多模型兼容**：通过 OpenAI 兼容 API，可切换任意大模型（DeepSeek、通义千问、GPT 等）
- **服务端 Key 注入**：可选隐藏 API Key，不暴露给浏览器
- **多格式导出**：一键导出 `.ggb`、PGF/TikZ `.tex`、PNG、SVG，并可复制 `tikzpicture` 片段
- **打开 .ggb**：载入已有构造继续编辑
- **图片读题**：输入框支持上传 / 粘贴 / 拖入图片，模型读图后生成 GeoGebra 命令并作图

---

## 导出与图片上传

画板上方工具栏提供 `.ggb`、TikZ、PNG、SVG 导出与「打开 .ggb」。

- `.ggb` 走 GeoGebra 的 `getBase64()`，得到标准二进制构造文件，可被桌面版直接打开；「打开 .ggb」用 `setBase64()` 回载。
- TikZ 优先调用本地 GeoGebra 5.0 构建里的 `exportPGF(callback)`（该 API 未列入官方文档）；若超时或失败，自动降级到基于对象快照的自研生成器，最后再降级为导出 SVG。产物是可编译的完整 `.tex`，「复制 TikZ」给的是 `tikzpicture` 片段。PGF/TikZ 只覆盖 2D 图形视图。
- 图片上传后统一缩放到长边 ≤1280px 并转 JPEG，控制在几百 KB，最多 4 张。这是为了适应 EdgeOne Cloud Functions 6MB 请求体上限；图片只在工具循环首步发送，历史轮自动剥离，避免 6 步循环重复传图。
- 图片以 base64 嵌在 OpenAI 兼容的 `image_url` 里经 `/llm-proxy` 转发，因此**所用模型需要支持图片输入**。

---

## 实际效果

```
输入：Draw a triangular pyramid (tetrahedron) and then draw its circumscribed sphere
输入：美国总统证明勾股定理图示
输入：经济学的李嘉图贸易理论
输入：各种圆锥曲线
```

![](doc/图片1.png)
![](doc/图片2.png)
![](doc/ScreenShot_2026-07-24_102220_872.png)
![](doc/ScreenShot_2026-07-24_103552_276.png)

---

## 技术栈

- **前端**：SolidJS + Vite，`marked` 渲染 Markdown，KaTeX 渲染公式
- **AI**：Vercel `ai` SDK v6，浏览器内 `streamText({ stopWhen: stepCountIs(6) })` 跑工具调用循环
- **GeoGebra**：官方 CDN `deployggb.js`，无需本地 vendor 文件
- **后端**：EdgeOne 云函数 `cloud-functions/llm-proxy`，透明转发 + 解决 CORS + 服务端 Key 注入
- **部署**：EdgeOne Pages，`edgeone makers deploy` 一条命令上线

## 目录

```
├── index.html
├── src/
│   ├── App.tsx              # 聊天 + 画板 布局
│   ├── ai-client.ts         # AI 工具循环（核心）
│   ├── geogebra.ts          # CDN 加载 + 画板控制
│   ├── styles.css
│   └── lib/
│       ├── normalize.ts     # 命令规范化（中文别名→英文）
│       ├── export.ts        # .ggb / TikZ / SVG / PNG 导出与 TikZ 降级生成
│       └── image.ts         # 图片压缩与 base64 产出
├── cloud-functions/
│   └── llm-proxy/           # EdgeOne 云函数：LLM 请求代理
├── doc/                     # 效果截图与参考文档
└── edgeone.json             # EdgeOne 部署配置
```

---

## 部署到 EdgeOne（3 步，约 10 分钟）

### 准备：一个 EdgeOne 网关 Key

**① 模型 Key** —— 走 EdgeOne 平台内置模型，**不需要**任何第三方大模型厂商的 Key 或接口地址。

**② 部署工具**：服务器上或本机需要能执行部署命令——

```bash
npm install -g edgeone     # 安装 EdgeOne CLI
edgeone login              # 登录你的 EdgeOne 账号
```

### 第 1 步：拿一个 EdgeOne 免费 Key

项目默认走 **EdgeOne Makers 内置模型网关**，不需要对接任何第三方大模型厂商：

1. 打开 [Makers 控制台 → Models → API Key](https://console.tencentcloud.com/edgeone/makers?tab=models&subTab=apikey)
2. 创建一个网关 Key（新账号赠送免费 Token，限时 50 万）
3. 把项目里的 `.env.example` 复制一份改名为 `.env`，只填这一行：

```
MAKERS_MODELS_KEY=你的网关Key
```

网关地址和模型名都有内置默认值，不需要填：

- 网关：`https://ai-gateway.edgeone.link/v1`（OpenAI 兼容，原生 SSE 流式）
- 模型：`@makers/deepseek-v4-flash`（内置免费，无需绑定厂商密钥）

> Key 只保存在服务端，不会暴露给浏览器——访客打开网页无需任何配置。
> 想换模型不用改代码：在 `.env` 里加 `MAKERS_MODEL=@makers/其他内置模型` 即可（目前内置模型只有 `@makers/deepseek-v4-flash`）。

### 第 2 步：部署

在项目目录执行一条命令：

```bash
edgeone makers deploy -n geogebra-webchat
```

完成后会输出你的专属网址。

### 第 3 步：打开即用

浏览器打开网址，直接输入数学题——**不需要填任何 Key**（服务端已自动注入）。

想换模型？页面右上角直接修改模型名和接口地址即可。

## 本地开发（可选）

前置：安装 [Node.js 20+](https://nodejs.org) 和 [EdgeOne CLI](https://pages.edgeone.ai/document/edgeone-cli)（`npm install -g edgeone`）。

```bash
npm install
edgeone makers dev
```

打开 `http://localhost:8088` 即可边改边看（前端改动热更新，云函数改动自动重启）。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `MAKERS_MODELS_KEY` | 是 | EdgeOne Makers 网关 Key，部署时注入服务端，访客无需配置 |
| `MAKERS_MODEL` | 否 | 留空即用 `@makers/deepseek-v4-flash` |

> 填了 `MAKERS_MODELS_KEY` 后，云函数整组走 EdgeOne 网关，旧的 `MODEL_BASE_URL` / `MODEL_NAME` / `MODEL_API_KEY`（第三方配置）会被忽略。
> 想换模型不用改代码——在 `.env` 里改 `MAKERS_MODEL` 即可；
> 页面右上角的输入框也仍然可以直接覆盖，方便临时调试。

## 常见问题：Insufficient remaining quota

页面提示 `Insufficient remaining quota to process this request`（HTTP 402）时，表示 **EdgeOne Makers 内置模型免费额度已用尽**。免费版为每月 50 万 token，**按账号维度计算、所有项目共享**，因此换一个新的网关 Key 不会重置额度，改用其它 `@makers/*` 模型也一样；账号未绑定 BYOK 厂商密钥时，网关里也没有可切换的付费模型。

可选处理：

1. **绑定自有厂商密钥（BYOK，改动最小）**：在 Makers 控制台 → Models 绑定厂商 Key，然后在页面右上角把模型名改成 `provider/model` 格式（如 `deepseek/deepseek-chat`）。网关地址、服务端注入的 Key、云函数白名单都不需要改。
2. **提交工单提额，或等下个计费周期重置**：免费额度以开通 Makers 服务的日期为周期起点按月重置。
3. **直连第三方模型服务**：页面右上角填写自己的 `Base URL` + 模型名 + `API Key`（云函数白名单已含 `api.deepseek.com`、`api.openai.com`、`api.moonshot.cn` 等）。切换到非网关地址时，界面会自动清掉服务端注入的占位 Key，此时必须填入真实 Key，否则会得到 401。

> 云函数与前端会把 402 翻译成带上述处理建议的中文提示；若仍看到英文原文，说明访问的是旧部署。

## 工作原理

```
你输入数学题 ──→ 浏览器内的 AI 工具循环（Vercel AI SDK）
                    │  AI 生成 GeoGebra 命令
                    ▼
              云函数 /llm-proxy（EdgeOne）──转发──→ 模型服务
                    │
                    ▼
              GeoGebra 画板逐条执行命令 → 图形出现
                    │
                    ▼
              AI 再用文字解释几何关系（流式输出）
```

- **前端**：SolidJS + Vite，AI 逻辑跑在浏览器里（`src/ai-client.ts`），GeoGebra 用官方 CDN 加载
- **后端**：只有一个 EdgeOne 云函数 `cloud-functions/llm-proxy`，负责转发模型请求、解决跨域、隐藏你的 Key
- **命令规范化**：`src/lib/normalize.ts` 把中文命令别名自动转成 GeoGebra 英文命令

## 目录结构

```
├── index.html
├── src/
│   ├── App.tsx            # 聊天 + 画板 布局
│   ├── ai-client.ts       # AI 工具循环（核心）
│   ├── geogebra.ts        # 画板加载与控制
│   └── lib/normalize.ts   # 命令规范化（中文别名→英文）
├── cloud-functions/
│   └── llm-proxy/         # EdgeOne 云函数：LLM 请求代理
├── doc/                   # 效果截图与参考文档
├── edgeone.json           # EdgeOne 部署配置
├── .env.example           # 环境变量模板（复制为 .env 使用）
└── .env                   # 你的实际配置（不提交到仓库）
```

## 更多文档

- [GeoGebra Apps 嵌入说明](doc/GeoGebra%20Apps%20Embedding.md)
- [公式处理笔记](doc/公式处理.md)

## 许可证

MIT
