# Geogebra Webchat — AI 驱动的数学几何画板

> 一句话在浏览器里创建可交互的数学图形。输入自然语言描述，AI 自动生成 GeoGebra 命令并在实时画板中呈现。

[![一键 EdgeOne Makers 部署](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/makers/new?repository-url=https%3A%2F%2Fgithub.com%2Fliangdabiao%2FGeogebra-WebChat)

## 在线体验（可直接打开测试）

| 定位 | 地址 | 说明 |
|---|---|---|
| EdgeOne（国内主站，国内用户推荐） | https://geogebra-webchat.liangdabiao.com/ | 国内线路更快，已绑自定义域、公开可访问 |
| Cloudflare 自定义域（海外推荐） | https://geogebra-webchat.348349.xyz/ | 公开可访问，无需任何配置 |
| Cloudflare Pages 默认域 | https://geogebra-webchat.pages.dev/ | 同一个部署的备用入口 |

三者部署的是同一份源码、同一组 `MODEL_*` 变量，功能一致，可直接测试自然语言作图、图片读题、`.ggb` / TikZ / PNG / SVG 导出与「打开 .ggb」。

> `edgeone makers deploy` 输出的 `*.edgeone.cool` 链接带 `eo_token`、有效期数小时，只是**临时预览地址**（直接打开裸预览域名会返回 401），不要写进对外文档；正式入口请在 EdgeOne 控制台「域名管理」绑定自定义域名。

---

## 快速配置（环境变量）

把 `.env.example` 复制为 `.env` 并填入自己的 Key；线上再用 `edgeone makers env set KEY VALUE -e production` 写入项目环境变量。

| 变量 | 必填 | 说明 |
|---|---|---|
| `MODEL_BASE_URL` | 是 | OpenAI 兼容接口地址，默认 `https://api.deepseek.com/v1` |
| `MODEL_NAME` | 是 | 模型名，默认 `deepseek-flash`（支持图片输入，可图片读题） |
| `MODEL_API_KEY` | 是 | 厂商 Key，仅由云函数服务端注入，不暴露给浏览器 |

也可以改用 EdgeOne Makers 内置网关（只填 `MAKERS_MODELS_KEY`），两组二选一，详见「环境变量」与「部署到 EdgeOne」。
Cloudflare Pages 用的是同一组变量，只是写入命令换成 `npx wrangler pages secret bulk .env --project-name <项目名>`，见「部署到 Cloudflare Pages」。

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
- **多格式导出**：一键导出 `.ggb`、TikZ `.tex`（完整 / 精简两种）、PNG、SVG，并可复制 `tikzpicture` 片段
- **打开 .ggb**：载入已有构造继续编辑
- **图片读题**：输入框支持上传 / 粘贴 / 拖入图片，模型读图后生成 GeoGebra 命令并作图
- **可拖拽分栏**：左右画板与聊天区之间有一条分隔条，可自由拖动调整宽度，比例自动记忆
- **生成中等待提示**：显示当前阶段（读题 / 执行作图命令 / 生成解答）与已等待秒数
- **公式可正常复制**：公式只渲染一份，回复下方可「复制原文」拿到规范 `$...$` Markdown
- **服务商一键切换**：顶栏下拉切换 DeepSeek / 通义千问 / 智谱 / Kimi / SiliconFlow / OpenAI，自动填好接口地址与模型名

---

## 导出与图片上传

画板上方工具栏提供 `.ggb`、TikZ（完整 / 精简）、PNG、SVG 导出与「打开 .ggb」。

- `.ggb` 走 GeoGebra 的 `getBase64()`，得到标准二进制构造文件；「打开 .ggb」用 `setBase64()` 回载。导出时先校验 ZIP 文件头，再补上桌面版常见的 `geogebra_thumbnail.png`（网页 applet 的 `getBase64()` 产物默认不带缩略图），以提高 GeoGebra 桌面软件的兼容性；补图失败会自动回退引擎原始产物，不会让导出失败。
- **「导出 TikZ」= 完整版**：直接采用本地 GeoGebra 5.0 构建里 `exportPGF(callback)` 的原生产物（该 API 未列入官方文档），保留坐标轴、网格、角度标记、线型与颜色，输出可编译的完整 `.tex`。
- **「精简 TikZ」= 精简版**：同一份引擎产物去掉 pgfplots 坐标轴/网格环境、合并重复绘图、坐标取整到 2 位小数，保留颜色、线型与标签，代码量小很多、更好二次编辑。
- **导出前会做覆盖校验**：用画板对象快照（线段端点、圆心半径）逐项比对引擎产物里的绘图元素，一旦发现某个对象没被画出来，会自动把它补进 `.tex` 并在提示条里说明补了几个。
- 引擎 `exportPGF` 超时或不可用时，两种模式都自动降级到**基于对象快照的自研生成器**（点 / 线段 / 直线 / 射线 / 圆 / 多边形 / 函数 / 文本，含颜色与虚线样式），最后再降级为导出 SVG。
- 「复制 TikZ」给的是 `tikzpicture` 片段。PGF/TikZ 只覆盖 2D 图形视图。

> **为什么 TikZ 生成器要读构造 XML？** applet 的 `getDefinitionString()` / `getCommandString()` 返回的是**本地化字符串**（中文环境下是「线段AB」「圆周(C, 1.5)」），按英文正则解析端点在中文下必然失效——这正是旧版降级生成器只能画出点、画不出线段的原因。只有 `getXML()` 里的定义始终是英文（`<command name="Segment"><input a0="B" a1="C"/>`），所以对象快照统一从 XML 还原英文定义。

- 图片上传后统一缩放到长边 ≤1280px 并转 JPEG，控制在几百 KB，最多 4 张。这是为了适应 EdgeOne Cloud Functions 6MB 请求体上限；图片只在工具循环首步发送，历史轮自动剥离，避免 6 步循环重复传图。
- 图片以 base64 嵌在 OpenAI 兼容的 `image_url` 里经 `/llm-proxy` 转发，因此**所用模型需要支持图片输入**。

---

## 「图形莫名消失」的两个根因与修复

这两个问题在浏览器里都表现为「画着画着少了一条线」，已逐条实测定位并修复：

**1. 同名覆盖（真正的元凶）**

GeoGebra 会给无名对象自动分配标签：`Segment(A,B)` 得到 `f`，`Segment(B,C)` 得到 `g`，多边形的边得到 `a`、`b`、`c_1`。而模型几乎必然会输出 `f(x)=…` 这类函数定义——**函数名 `f` 会静默顶掉那条线段**，对象数量甚至不变（名字被复用），所以画面上只是"少了一条线"，很难察觉。

修复：执行**每一条**命令之前检查它要定义的名字，若撞上一个自动标签就先给旧对象改名让路（样式、依赖关系都保留，新名字用 `ggbauto1` 这类避开 GeoGebra 函数名空间的形式），并在对话里提示「为避免同名覆盖，已自动重命名：f → ggbauto1」。显式命名（模型自己写的 `A`、`B`、`alpha`）允许覆盖，那是模型的有意行为。

> 顺带说明：`Rename("s","x")` 这种**带引号**的形式是错的——GeoGebra 会把 `"s"` 当字符串字面量，结果新建一个 text 对象、原对象纹丝不动。正确写法是 `Rename(s,"x")` 或 applet 的 `api.renameObject("s","x")`，本项目用的是后者。

**2. 样式命令被误判为失败 → 整板回滚**

GeoGebra 的 `evalCommand` 对 `SetLineStyle` / `SetColor` / `SetLineThickness` / `ShowLabel` / `SetVisibleInView` / `Rename` 这类脚本命令**一律返回 `false`**，但副作用完全生效（实测 `SetLineStyle(s,1)` 让 `getLineStyle` 从 0 变成 1，PGF 里也确实出现 `dash pattern=on 1pt off 1pt`）。旧版逻辑把 `false` 当成执行失败，于是**一条样式命令就会触发整块画板回滚**，用户看到的现象是"刚画好的图突然全没了"。

修复：脚本/样式命令不再按布尔返回值判失败；赋值命令改为「返回 false 但对象确实存在就算成功」；并且**只有整批命令全部失败才回滚**，个别命令失败时保留已画出的图形，把失败清单回灌给模型让它自己下一轮修正。

---

## 模型服务商一键切换

右上角新增服务商下拉框，选中即自动填好 Base URL 与模型名：

| 预设 | Base URL | 模型 | 支持读图 |
| --- | --- | --- | --- |
| 服务端默认（免填 Key） | 由部署方配置 | 由部署方配置 | 取决于所配模型 |
| DeepSeek 官方 | `https://api.deepseek.com` | `deepseek-flash` | ✅ |
| 通义千问（阿里云百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` | ✅ |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-plus` | ✅ |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | ❌ |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-VL-72B-Instruct` | ✅ |
| OpenAI 官方 | `https://api.openai.com/v1` | `gpt-4o-mini` | ✅ |
| 自定义 | 手动填写 | 手动填写 | 取决于所配模型 |

- 切换到「服务端默认」会恢复占位 Key，让云函数注入真实密钥；切到其它服务商时占位 Key 会自动清空并提示填写该服务商的 Key。
- **API Key 只存在浏览器 `localStorage`**，不写进仓库、不上传服务器。切换服务商只改 Base URL 与模型名。
- 预设里的域名必须都在 `/llm-proxy` 的白名单内，否则前端能选、云函数会拒（403 `target host not allowed`）。调整白名单见 `cloud-functions/llm-proxy/index.ts` 的 `ALLOWED_HOSTS`。

---

## 作图提示词（模型怎么写 GeoGebra 命令）

系统提示词里内置了一份 GeoGebra 官方指令速查（点 / 线段 / 直线射线 / 圆弧扇形 / 角与平分线 / 三角形四心 / 交点测量向量 / 变换 / 样式命令），以及三条硬规则：

- **依赖顺序**：先定义坐标已知的点，再画基本图元，最后生成依赖它们的派生对象；被依赖的对象必须先定义。
- **封闭多边形用 `Segment` 逐边绘制**（`Segment(A,B)`、`Segment(B,C)`、`Segment(C,A)`），不用 `Polygon`——`Polygon` 的填充与顶点顺序在导出 TikZ 时容易丢失。
- **要设置样式的对象必须显式命名**（`s = Segment(A,B)` 再 `SetLineStyle(s,1)`）。否则模型不知道自动分配的名字叫什么，一旦撞上函数名 `f(x)=…` 还会把线段顶掉。

这些指令语法都是 GeoGebra 官方文档里的公开事实（命令名 + 参数顺序），与任何第三方实现无关。

---

## 生成等待提示与公式复制

读图、多步工具循环和模型推理会让一次回答耗时十几秒到一分钟。请求发出后：

- 助手气泡里出现带跳点动画的等待条，按阶段显示「正在读题、分析图形关系…」→「正在生成并执行 GeoGebra 作图命令…」→「正在生成解答文字…」，并实时显示已等待秒数；
- 输入区上方同步显示一条精简状态，输入框提示语变为「助手正在处理，请稍候…」，发送按钮变为「生成中…」且不可重复提交；
- 回答结束或出错时等待提示自动消失。

公式渲染用 `katex.renderToString(..., { output: "html" })`，**只输出一份 HTML**。KaTeX 默认的 `htmlAndMathml` 会额外输出一层被 CSS 裁到 1px 的 MathML，它仍参与浏览器的文本选择，导致复制出的公式变成「`2 2`」「`B D E BDE`」「`x = A E x=AE`」这类重复字符。渲染正则也做了保护：行内公式不允许跨空行、长度上限 400 字符，避免流式输出时未闭合的 `$` 吞掉整段正文。

> 即使只输出一份 HTML，KaTeX 用 CSS 定位排版分式、根号、上下标，**直接框选页面复制**仍可能得到带换行的排版碎片。需要干净、可编辑的公式文本时，请点回复下方的「复制原文」，拿到的是未经渲染的 Markdown（公式保持 `$...$` / `$$...$$`）。剪贴板 API 被浏览器拒绝时会自动降级到临时 `textarea` + `execCommand`。

---

## 界面布局（分栏拖动与画板自适应）

左侧 GeoGebra 画板与右侧聊天区之间有一条带把手的**分隔条**：

- **左右拖动**即可改变两侧宽度，范围 25%～78%，比例写入 `localStorage`（`geochat-web-v3-split`），刷新后保留。
- **双击分隔条**或聚焦后按 `Enter` 恢复默认 58%；`←` / `→` 每次微调 2%（按住 Shift 为 5%）。
- 拖动时会盖一层临时遮罩，避免 GeoGebra 内部的 canvas / iframe 截走指针事件。
- 窄屏（≤900px）自动改为上下布局，分隔条隐藏。

画板尺寸通过 `ResizeObserver` 与容器实时同步：清理 GeoGebra 写入的 inline 尺寸 → 调用 `applet.setSize()` 重算内部视图 → 派发 `resize` 事件。容器宽度用 `width: 100% !important` 锁死为面板宽度（GeoGebra 的 resize handler 会往容器写回旧像素宽度，不锁住会形成「容器不缩 → 画板不缩」的死循环），再加 `overflow: hidden` 兜底。

因此窗口缩放、顶栏/导出按钮折行、提示条出现或分栏拖动时，GeoGebra 的 canvas 都会跟着重算，**不会再溢出盖住聊天区**。聊天区里的长 KaTeX 公式则改为自身横向滚动，不撑破窄栏。

> 如果桌面版仍提示打不开：优先升级到最新版 GeoGebra Classic，并改用软件内「菜单 → 打开 → 从本机选择」而不是双击文件（部分沙盒版桌面应用双击会报 Cannot open file）；也可以在网页版 `geogebra.org/classic` 里打开同一文件交叉验证。

> 3D 视图里斜着的白色四边形是坐标系的 xy 平面，是视角旋转后的正常显示，不是布局溢出；想看全可用画板自带的全屏按钮，或把分栏往右拖宽一些。

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
- **GeoGebra**：仓库自带 GeoGebra 5.0 web3d 静态资源（`public/geogebra/HTML5/5.0/web3d/`），由 `deployggb.js` 加载。导出 `.ggb` / PGF-TikZ / PNG / SVG 依赖该本地构建提供的 applet API，因此不能换回 CDN 版本
- **后端**：`cloud-functions/llm-proxy` 通用处理器，透明转发 + 解决 CORS + 服务端 Key 注入；EdgeOne 直接加载，Cloudflare Pages 由 `functions/llm-proxy.ts` 薄适配层复用
- **部署**：EdgeOne Pages（`edgeone makers deploy`）与 Cloudflare Pages（`wrangler pages deploy`）并存，前端代码零差异

## 目录

```
├── index.html
├── src/
│   ├── App.tsx              # 聊天 + 画板布局、导出工具栏、图片上传 UI
│   ├── ai-client.ts         # AI 工具循环（核心）、多模态消息、读图 prompt
│   ├── geogebra.ts          # 本地 GeoGebra 加载、命令执行、导出/检视 API 封装
│   ├── styles.css
│   └── lib/
│       ├── normalize.ts     # 命令规范化（中文别名→英文）
│       ├── export.ts        # 下载 / 复制等通用文件工具
│       ├── tikz.ts          # TikZ 生成、精简、覆盖校验与快照兜底
│       ├── providers.ts     # 预置模型服务商清单
│       ├── ggb.ts           # .ggb ZIP 缩略图补全与文件头校验
│       └── image.ts         # 图片压缩与 base64 产出
├── cloud-functions/
│   └── llm-proxy/           # 通用 LLM 请求代理（两个平台共用）
├── functions/
│   └── llm-proxy.ts         # Cloudflare Pages Functions 适配层 → /llm-proxy
├── public/geogebra/         # 本地 vendor 的 GeoGebra 5.0 静态资源
├── doc/                     # 效果截图与参考文档
├── .env.example             # 环境变量模板（复制为 .env 使用；.env 不入库）
└── edgeone.json             # EdgeOne 部署配置
```

---

## 部署到 EdgeOne（3 步）

### 准备

**① 模型 Key** —— 项目默认直连 DeepSeek 官方 `deepseek-flash`（自带视觉输入，可图片读题），需要一个 DeepSeek API Key。也可以改用 EdgeOne Makers 内置网关，见下面「环境变量」。

**② 部署工具**：

```bash
npm install -g edgeone     # 安装 EdgeOne CLI
edgeone login              # 登录你的 EdgeOne 账号
```

### 第 1 步：配置 .env

把 `.env.example` 复制为 `.env`，填入自己的 Key：

```
MODEL_BASE_URL=https://api.deepseek.com/v1
MODEL_NAME=deepseek-flash
MODEL_API_KEY=你的Key
```

Key 只保存在服务端，不会暴露给浏览器——访客打开网页无需任何配置。线上还要把这三个变量写入项目环境变量：

```bash
edgeone makers env set MODEL_BASE_URL "https://api.deepseek.com/v1" -e production
edgeone makers env set MODEL_NAME "deepseek-flash" -e production
edgeone makers env set MODEL_API_KEY "你的Key" -e production
```

### 第 2 步：部署

```bash
edgeone makers deploy -n geogebra-webchat --skip-ai-gateway-sync
```

`--skip-ai-gateway-sync` 会阻止 CLI 自动把内置网关 Key 写回配置（否则会覆盖自有厂商配置）。完成后输出专属网址。

### 第 3 步：打开即用

浏览器打开已绑定的自定义域名（本项目为 https://geogebra-webchat.liangdabiao.com/），直接输入数学题或上传题目图片；右上角可临时覆盖模型名与接口地址。CLI 输出的 `*.edgeone.cool` 只是带 `eo_token` 的临时预览链接，见「在线体验」。

## 部署到 Cloudflare Pages

本项目在 Cloudflare Pages 上还有一份部署，与 EdgeOne 站点并存、互不影响。两个入口都列在顶部「在线体验」：

- 默认访问：https://geogebra-webchat.pages.dev/
- 自定义域：https://geogebra-webchat.348349.xyz/（需按第 4 步补 CNAME 后生效）

**前端零改动**：`/llm-proxy` 是同源相对路径，GeoGebra 静态资源也是同源 `/geogebra/...`，服务端 Key 与默认模型通过 `GET /llm-proxy` 下发，都是平台无关的。唯一要适配的是请求体，已由 `functions/llm-proxy.ts` 处理。

### 第 1 步：构建

```bash
npm install
npm run build          # 产物 dist/，约 50MB / 206 个文件
```

Pages 免费版上限 20,000 文件、单文件 25 MiB；本项目最大单文件约 10 MB，余量充足。构建环境默认 Node 22，满足项目的 `>=20`。

### 第 2 步：创建项目并上传变量

```bash
npx wrangler login
npx wrangler pages project create geogebra-webchat --production-branch main
npx wrangler pages secret bulk .env --project-name geogebra-webchat
```

`.env` 里的 `MODEL_BASE_URL` / `MODEL_NAME` / `MODEL_API_KEY` 会作为加密 Secret 存进 Pages 的 production 环境，通过 `context.env` 注入函数，浏览器拿不到。也可以只把 `MODEL_API_KEY` 设为 Secret、另两个在控制台设为普通变量。

### 第 3 步：部署

```bash
npx wrangler pages deploy dist --project-name geogebra-webchat --branch main
```

Wrangler 会自动编译根目录的 `functions/`（部署日志出现 `Compiled Worker successfully` 与 `Uploading Functions bundle`），把 `functions/llm-proxy.ts` 映射到 `/llm-proxy`；静态资源仍由 CDN 直接提供。

### 第 4 步：自定义域（必须补 DNS）

Pages 自定义域**不会自动创建 DNS 记录**。无论用 API 绑定还是在控制台 Add a custom domain，都还要在 DNS 里加一条：

| 类型 | 名称 | 目标 | 代理状态 |
|---|---|---|---|
| CNAME | `geogebra-webchat`（或你的子域） | `geogebra-webchat.pages.dev` | 已代理 / Proxied（橙云） |

未加之前项目里的域会一直停在 `pending`，状态提示 `CNAME record not set`。Wrangler 的 OAuth 登录只授予 `pages:write` / `zone:read`，**不含 DNS 编辑权限**，所以 `POST /zones/{zone}/dns_records` 会返回 403 `Authentication error`；这一步请在 Cloudflare 控制台 DNS 页面操作，或改用带 `Zone:DNS:Edit` 权限的 API Token。记录生效后证书自动签发，几分钟内域名变 `active`。

### 也可以接 GitHub 自动部署

在 Pages 项目设置里连接 GitHub 仓库：构建命令 `npm run build`、输出目录 `dist`、生产分支 `main`，以后 push 即自动部署；环境变量在 Pages 设置页填（Key 用 Secret）。此方式与 `wrangler pages deploy` 直接上传二选一，不要混用同一个项目。

### 两个平台的差异（只有这一处）

| | EdgeOne 云函数 | Cloudflare Pages Functions |
|---|---|---|
| 入口 | `cloud-functions/llm-proxy/index.ts` → `/llm-proxy` | `functions/llm-proxy.ts` → `/llm-proxy`，内部复用同一份通用处理器 |
| 请求体 | 可能是已解析的字符串 / 对象，也可能是标准 `Request`（`ReadableStream`） | 标准 `Request`，body 是 `ReadableStream` |
| 处理 | 通用处理器优先 `await req.text()`，失败再回退 `req.body` | 适配层先 `await request.text()` 再交给通用处理器；不做这步所有 POST 都会变成空 body |
| 环境变量 | `edgeone makers env set KEY VALUE -e production` | `wrangler pages secret bulk` 或控制台 |

白名单、CORS、SSE 惰性流包装、5.5MB 请求体保护全部复用同一份代码；Cloudflare 侧额外用 `content-length` 做 6MB 前置拦截。

### 访问速度提醒

Cloudflare 免费版没有中国大陆节点，`pages.dev` 与自定义域在国内部分运营商存在 DNS 污染、晚高峰不稳；本项目首次要拉约 50MB GeoGebra 资源，国内加载会明显慢于 EdgeOne。建议把 Cloudflare 站定位为**海外镜像 / 演示 / 备份入口**，国内主站继续用 EdgeOne。KaTeX 的 CSS 与字体已随前端打包，两个站点都不再请求外部 CDN。

### 验收清单

`GET /llm-proxy` 返回 `{"serverKey":true,"provider":"custom","model":"deepseek-flash"}` → POST 文本有完整 body、SSE 能吐 `data:`、带图能读出颜色 → `/geogebra/deployggb.js` 与 10MB 的 `*.cache.js` 都 200 → 四种导出与「打开 .ggb」在新域下可用 → 回 EdgeOne 站回归一次确认没被影响。

## 本地开发（可选）

前置：安装 [Node.js 20+](https://nodejs.org) 和 [EdgeOne CLI](https://pages.edgeone.ai/document/edgeone-cli)（`npm install -g edgeone`）。

```bash
npm install
edgeone makers dev
```

打开 `http://localhost:8088` 即可边改边看（前端改动热更新，云函数改动自动重启）。

## 环境变量

**两组二选一，不要同时填写**：

| 变量 | 组别 | 说明 |
|---|---|---|
| `MODEL_BASE_URL` | A · 自有厂商 | OpenAI 兼容地址，默认 `https://api.deepseek.com/v1` |
| `MODEL_NAME` | A · 自有厂商 | 默认 `deepseek-flash`（自带视觉输入） |
| `MODEL_API_KEY` | A · 自有厂商 | 自有厂商 Key，服务端注入，不进浏览器 |
| `MAKERS_MODELS_KEY` | B · 内置网关 | EdgeOne Makers 网关 Key（免费额度 50 万 token/月） |
| `MAKERS_MODEL` | B · 内置网关 | 留空即用 `@makers/deepseek-v4-flash` |

> 填了 `MAKERS_MODELS_KEY` 会**整组**切到 EdgeOne 网关并忽略 `MODEL_*`；反之 Key 与端点必须成组切换，否则会「拿 A 的 Key 打 B 的网关」→ 401。
> 线上变量用 `edgeone makers env set KEY VALUE -e production` 写入，部署时加 `--skip-ai-gateway-sync`。
> 页面右上角的输入框仍可直接覆盖，方便临时调试。
> Cloudflare Pages 用 `npx wrangler pages secret bulk .env --project-name <项目名>` 一次性写入（三个值都作为加密 Secret），或在项目设置页分别配置；变量名完全一致。

## 常见问题

### Insufficient remaining quota（402）

这个错误只会在**使用 EdgeOne Makers 内置网关**时出现，表示内置模型免费额度已用尽：每月 50 万 token，**按账号维度计算、所有项目共享**，因此换一个新的网关 Key 不会重置额度，改用其它 `@makers/*` 模型也一样；账号未绑定 BYOK 厂商密钥时，网关里也没有可切换的付费模型。

可选处理：

1. **绑定自有厂商密钥（BYOK，改动最小）**：Makers 控制台 → Models 绑定厂商 Key，再把模型名改成 `provider/model`（如 `deepseek/deepseek-chat`）。
2. **提交工单提额，或等下个计费周期重置**：免费额度以开通 Makers 服务的日期为周期起点按月重置。
3. **直连第三方模型服务**：按上面 A 组配置 `MODEL_*`，或在页面右上角填写自己的 `Base URL` + 模型名 + `API Key`。切到与服务端配置不同的地址时，界面会自动清掉占位 Key，此时必须填真实 Key，否则会得到 401。

> 当前默认配置已是 DeepSeek 官方 API，不会出现该错误；若自有 Key 返回 402，通常是账户余额不足。

### Cloudflare 自定义域一直 pending / `CNAME record not set`

Pages 绑定自定义域不会自动创建 DNS 记录。需要在 zone 里手动加一条 **CNAME → `<项目名>.pages.dev`** 并开启代理（橙云），详见「部署到 Cloudflare Pages · 第 4 步」。Wrangler 的 OAuth 授权不含 DNS 编辑权限，DNS API 会返回 403，请在控制台操作或改用带 `Zone:DNS:Edit` 权限的 API Token。

### POST /llm-proxy 返回 200 但响应体为空

云函数曾直接把上游 `ReadableStream` 和全部响应头透传，EdgeOne 线上运行时会返回 200 却丢掉 body（本地 `makers dev` 正常，容易漏测）。修复方式：只透传 `content-type` / `cache-control` 等安全头，剔除 `transfer-encoding` / `content-length` / `connection`，并用惰性 `ReadableStream` 包一层上游 body。改动时不要退回 `new Headers(upstream.headers)` + `new Response(upstream.body)`。

### POST /llm-proxy 返回 422 `missing field messages`

EdgeOne 运行时可能把 `context.request` 直接给成标准 `Request`，其 `body` 是 `ReadableStream`；沿用 `JSON.stringify(req.body)` 会得到 `{}`，上游模型收到空对象就报 `missing field messages`（GET 探测仍正常，容易误判为额度或 Key 问题）。通用处理器现在优先 `await req.text()`，失败再回退到平台已解析的字符串 / 普通对象；Cloudflare 侧仍由 `functions/llm-proxy.ts` 预读 body，两条路径都覆盖。

### 画着画着少了一条线 / 画板突然全清空

这是两个已修复的历史问题，新版不会再出现：

- **少了一条线**：GeoGebra 给无名对象自动分配 `f`、`g`、`a` 这类标签，而模型输出的函数名 `f(x)=…` 会**静默顶掉**同名线段（对象总数甚至不变，只是名字被复用）。现在每条命令执行前都会检查名字冲突，撞上自动标签就先把旧对象改名让路，并在对话里提示「已自动重命名：f → ggbauto1」。若你在代数区看到 `ggbauto1` 这类名字，那就是被保护下来的原对象。
- **画板突然全清空**：旧逻辑把 `SetLineStyle` / `SetColor` 这类脚本命令的 `false` 返回值当成执行失败，而 GeoGebra 对这些命令**恰恰返回 `false` 却生效**，于是触发整板回滚。现在脚本命令不再按布尔值判失败，且只有整批命令全部失败才回滚。

如果你在旧版本部署上遇到，可以手动加一条线段同名的新对象（比如把 `f` 改成 `f1`）先绕开。

### 复制出来的公式重复、被拆成单字符

KaTeX 默认同时输出 MathML 与 HTML 两份，隐藏的 MathML 仍会被选中，于是 `2` 变成 `2 2`、`BDE` 变成 `B D E BDE`。现在固定 `output: "html"` 只输出一份。若仍看到带换行的排版碎片，那是 KaTeX 分式/根号的 CSS 定位所致，点「复制原文」即可拿到规范 Markdown。

## 工作原理

```
文字 / 题目图片 ──→ 浏览器内的 AI 工具循环（Vercel AI SDK）
                       │  图片先经 src/lib/image.ts 压缩，随首步请求发出
                       ▼
             /llm-proxy（EdgeOne 云函数 / Cloudflare Pages Functions）──转发──→ 模型服务
                       │  AI 生成 GeoGebra 命令
                       ▼
                 GeoGebra 画板逐条执行命令 → 图形出现
                       │
                       ├──→ AI 再用文字解释几何关系（流式输出）
                       └──→ 导出 .ggb / TikZ（完整·精简）/ PNG / SVG（src/lib/tikz.ts、src/lib/export.ts）
```

- **前端**：SolidJS + Vite，AI 逻辑跑在浏览器里（`src/ai-client.ts`），GeoGebra 用仓库自带的 5.0 本地构建加载
- **后端**：`cloud-functions/llm-proxy` 是唯一一份通用处理器，负责转发模型请求、解决跨域、隐藏你的 Key；EdgeOne 直接加载，Cloudflare Pages 经 `functions/llm-proxy.ts` 适配请求体后复用
- **命令规范化**：`src/lib/normalize.ts` 把中文命令别名自动转成 GeoGebra 英文命令
- **图片与体积**：图片压缩后经云函数转发，云函数有 5.5MB 请求体保护；工具循环只在首步携带图片，历史轮自动剥离

## 更新记录

### 2026-11 · 图形丢失修复、TikZ 双版本与服务商切换

- **修复「图形莫名消失」**：定位到两个真实根因并逐一修复——① 同名覆盖：GeoGebra 自动给无名对象分配 `f`/`g`/`a` 等标签，模型的 `f(x)=…` 会静默顶掉同名线段（对象数不变，极难察觉）；现逐条命令执行前检测并给旧对象改名让路，新名用 `ggbauto1` 这类避开 GeoGebra 函数名空间的形式。② 样式命令假失败：`SetLineStyle`/`SetColor` 等脚本命令的 `evalCommand` 恒返回 `false` 但副作用生效，旧逻辑据此触发**整板回滚**；现改为按命令类型判定，且只有整批全失败才回滚
- **TikZ 导出分两档**：「导出 TikZ」= 引擎 `exportPGF` 原生产物（保留坐标轴、角度标记、线型、颜色）；「精简 TikZ」= 去掉 pgfplots 坐标轴/网格、合并重复绘图、坐标取整到 2 位小数，代码更少更好改
- **导出前覆盖校验**：用对象快照逐项比对引擎产物的绘图元素，发现缺失自动补进 `.tex` 并在提示条说明补了几个
- **TikZ 生成器改读构造 XML**：applet 的 `getDefinitionString()`/`getCommandString()` 返回本地化字符串（中文环境下是「线段AB」），英文正则必然解析失败——这正是旧版降级生成器画不出线段的原因；现统一从 `getXML()` 还原英文定义，覆盖校验与快照兜底都能正确处理端点与圆心
- **系统提示词内置 GeoGebra 官方指令速查**（点 / 线段 / 直线射线 / 圆弧扇形 / 角与平分线 / 三角形四心 / 交点测量向量 / 变换 / 样式命令），并明确依赖顺序、封闭多边形用 `Segment` 逐边、样式对象必须显式命名三条规则
- **顶栏新增服务商下拉**：DeepSeek / 通义千问 / 智谱 GLM / Kimi / SiliconFlow / OpenAI 一键切换，自动填好 Base URL 与模型名；Key 仍只存 `localStorage`；白名单补 `open.bigmodel.cn`
- 无头 Chrome 实测：11 个对象全部保留（含虚线、红色样式），4 条线段与视口外线段在完整版/精简版中均在；人为删掉一条线段后覆盖校验能发现并补回；快照兜底能画出点、线段、圆与函数

### 2026-11 · 导出与多模态

- 新增 `.ggb` 导出与「打开 .ggb」回载（`getBase64` / `setBase64`），另有 PNG、SVG 导出
- 新增 PGF/TikZ 导出（完整可编译 `.tex` + 可复制的 `tikzpicture` 片段），保留三档降级：原生 `exportPGF` → 基于对象快照的自研生成器 → 导出 SVG
- 输入框新增图片上传 / 粘贴 / 拖入，模型读图后生成 GeoGebra 命令作图；最多 4 张、长边 ≤1280px、JPEG 重编码
- 画板工具栏增加能力探测与导出状态提示；云函数增加请求体大小保护
- 默认模型切换为支持视觉输入的 `deepseek-flash`（DeepSeek 官方 API），配置改为 `MODEL_*` 一组环境变量；详见「环境变量」
- 修复线上云函数返回 200 但响应体为空的问题，以及 402 额度错误、切换第三方服务商时的占位 Key 问题

### 2026-11 · Cloudflare Pages 双平台部署

- 新增 `functions/llm-proxy.ts`：把标准 `Request` 的流式 body 预读成字符串，再复用 EdgeOne 的通用处理器；前端代码零改动
- 同一份 `dist` 与同一组 `MODEL_*` 变量可分别部署到 EdgeOne 与 Cloudflare Pages，两套站点互不影响
- 补充 Cloudflare Pages 部署步骤、自定义域 CNAME 要求、平台差异与国内访问速度提醒

### 2026-11 · 公式样式本地化与在线入口

- 删除 `index.html` 里的 `cdn.jsdelivr.net` KaTeX `<link>`，改由 `src/main.tsx` 导入 `katex/dist/katex.min.css`；Vite 打包 CSS 与字体，首屏不再请求外部 CDN，样式也与本地 `katex` JS 版本一致
- README 列出三个在线体验地址；EdgeOne 使用已绑定的自定义域 `geogebra-webchat.liangdabiao.com`，`*.edgeone.cool` 仅为临时预览链接
- 云函数请求体读取兼容「标准 `Request` 流式 body」的新版 EdgeOne 运行时，修复线上 POST 返回 422 `missing field messages`

### 2026-11 · 分栏拖动、画板自适应与 .ggb 桌面兼容

- 左右面板改为可拖拽三列布局，新增常驻可见的把手；支持双击 / Enter / Home 重置、`←` `→` 微调、比例持久化，拖动时用全屏遮罩避免 GeoGebra 的 canvas / iframe 截走指针事件
- 修复「画板突然溢出」：GeoGebra 注入时固定了 canvas 像素尺寸，窗口缩放、工具栏折行或分栏拖动后不会跟随，旧 canvas 会盖住聊天区。现用 `ResizeObserver` + `setSize` 实时同步，并用 CSS 锁住容器宽度防止 GeoGebra 写回旧尺寸
- `.ggb` 导出新增 ZIP 头校验与 `geogebra_thumbnail.png` 缩略图补全（`src/lib/ggb.ts`，纯字节追加、不解压原条目、失败自动回退），提升桌面软件兼容性；实测产物 ZIP/CRC 全部有效，且能被 GeoGebra 引擎完整回载

### 2026-11 · 等待提示与公式复制修复

- 助手消息新增生成中状态：分阶段文案、跳点动画、已等待秒数；输入区同步显示状态条、提示语与按钮禁用，结束时自动清除
- 公式改为 `output: "html"` 单份渲染，修复复制时「`2 2` / `B D E BDE` / `x = A E x=AE`」的重复字符；渲染正则加跨空行与长度保护
- 助手回复新增「复制原文」按钮（复制规范 Markdown），`copyText` 增加 `execCommand` 降级，剪贴板 API 被拒绝时仍可用
- 无头 Chrome 实测：11 个公式全部渲染、`katex-mathml` 为 0、无 `$...$` 源码残留、复制文本无重复，等待计时 0→2 秒并在结束后消失

## 更多文档

- [GeoGebra Apps 嵌入说明](doc/GeoGebra%20Apps%20Embedding.md)
- [公式处理笔记](doc/公式处理.md)

## 许可证

MIT
