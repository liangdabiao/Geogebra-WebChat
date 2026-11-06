import { createSignal, onMount, onCleanup, For, Show, createEffect } from "solid-js";
import { marked } from "marked";
import { mountGeoGebra, type GeoGebraController } from "./geogebra";
import { runChat, buildUserContent, stripImageParts } from "./ai-client";
import type { ModelMessage } from "ai";
import katex from "katex";
import { prepareImage, MAX_IMAGES, type PreparedImage } from "./lib/image";
import {
  timestampName,
  downloadBase64,
  downloadText,
  fileToBase64,
  copyText,
  normalizeTikZ,
  buildTikZFallback,
  type TikZParts,
} from "./lib/export";

function preprocessMarkdown(text: string): string {
  // 1. Normalize LaTeX delimiters: \(→$, \)→$, \[→$$, \]→$$
  text = text
    .replace(/\\\(/g, "$")
    .replace(/\\\)/g, "$")
    .replace(/\\\[/g, "$$")
    .replace(/\\\]/g, "$$");
  // 2. Catch standalone [...] (not markdown links) with LaTeX content → $...$
  return text.replace(/\[([^\[\]]+)\](?!\s*\()/g, (match, content) => {
    if (/\\/.test(content)) return `$${content}$`;
    return match;
  });
}

/**
 * KaTeX 默认输出 htmlAndMathml 两份：MathML 层被 CSS 裁成 1px「视觉隐藏」，
 * 但仍然参与浏览器的文本选择与复制，于是复制出来的公式会变成
 * 「2 2」「B D E BDE」「x = A E x=AE」这类重复且被拆成单字符的文本。
 * 只输出 HTML 一份即可消除重复；需要规范 LaTeX 文本时用消息上的「复制原文」。
 */
function renderMath(text: string): string {
  const render = (code: string, displayMode: boolean): string | null => {
    try {
      return katex.renderToString(code.trim(), {
        displayMode,
        throwOnError: false,
        strict: "ignore",
        output: "html",
      });
    } catch {
      return null;
    }
  };
  // 在 marked.parse() 之前把公式换成 KaTeX HTML，避免 marked 碰到 < > & 等字符
  // 块级 $$...$$（允许跨行）
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, code: string) => render(code, true) ?? m);
  // 行内 $...$：允许同段内换行，但禁止跨空行并限制长度，
  // 防止流式输出时一个尚未闭合的 $ 把后面整段正文吞进公式。
  text = text.replace(/(?<!\$)\$([\s\S]{1,400}?)\$(?!\$)/g, (m, code: string) =>
    code.includes("\n\n") ? m : (render(code, false) ?? m)
  );
  return text;
}

interface UiMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  activity: string[];
  /** 用户消息里附带的图片预览（data URL）。 */
  images?: string[];
  /** 该助手消息仍在生成中，用于显示等待提示。 */
  pending?: boolean;
}

type WaitPhase = "reading" | "drawing" | "writing";
const WAIT_TEXT: Record<WaitPhase, string> = {
  reading: "正在读题、分析图形关系…",
  drawing: "正在生成并执行 GeoGebra 作图命令…",
  writing: "正在生成解答文字…",
};

type ExportKind = "ggb" | "tikz" | "png" | "svg";

let _id = 1;
const nextId = () => _id++;

// v3 前缀：默认模型切到 DeepSeek 官方 deepseek-flash（自带视觉输入）。
// 换前缀可让老访客 localStorage 里缓存的旧 baseURL / 模型名 / Key 自动失效，
// 不会被缓存悄悄带回已无额度的 EdgeOne 网关。
const LS_KEY = "geochat-web-v3-key";
const LS_MODEL = "geochat-web-v3-model";
const LS_BASE_URL = "geochat-web-v3-base-url";

// 左右分栏：默认 58%（对应原来的 1.4fr : 1fr），可拖动并记住用户选择
const LS_SPLIT = "geochat-web-v3-split";
const DEFAULT_SPLIT = 58;
const MIN_SPLIT = 25;
const MAX_SPLIT = 78;

// 402 额度/余额不足的统一提示：Makers 免费额度按账号共享（50 万 token/月），换 Key 不会重置。
const QUOTA_HELP =
  "模型服务返回额度或余额不足（402）。\n" +
  "若在用 EdgeOne Makers 内置模型：50 万 token/月按账号共享，重新创建 Key 无效，" +
  "请绑定 BYOK、提交工单提额或等下个计费周期重置；\n" +
  "若在用自有服务商：请检查账户余额与 API Key。\n" +
  "也可在右上角改用自己的 Base URL + 模型 + API Key。";

/** 服务端注入的 Key 只对「与服务端配置同域」的目标生效，不能硬编码某个网关域名。 */
function usesServerEndpoint(current: string, server: string): boolean {
  const c = current.trim();
  const s = server.trim();
  if (!c) return true;
  if (!s) return false;
  try {
    return new URL(c).host.toLowerCase() === new URL(s).host.toLowerCase();
  } catch {
    return false;
  }
}

/** 服务端注入场景下的占位 Key，绝不能透传给其它服务商。 */
function isPlaceholderKey(v: string): boolean {
  const t = v.trim();
  return t === "" || t === "server-injected";
}

function friendlyError(msg: string): string {
  if (/insufficient.*quota|quota_exhausted|额度或余额不足|余额不足/i.test(msg)) return QUOTA_HELP;
  if (/image|vision|multimodal|unsupported.*content|invalid.*content/i.test(msg)) {
    return msg + "\n（模型若提示不支持图片，请在右上角切换为支持视觉的模型或接口地址）";
  }
  return msg;
}

export default function App() {
  const [apiKey, setApiKey] = createSignal(localStorage.getItem(LS_KEY) ?? "");
  const [model, setModel] = createSignal(localStorage.getItem(LS_MODEL) ?? "");
  const [baseUrl, setBaseUrl] = createSignal(localStorage.getItem(LS_BASE_URL) ?? "");
  // 服务端下发的默认接口地址，用来判断当前是否仍在使用服务端注入的 Key
  const [serverBaseUrl, setServerBaseUrl] = createSignal("");
  const [messages, setMessages] = createSignal<UiMessage[]>([]);
  const [coreMessages, setModelMessages] = createSignal<ModelMessage[]>([]);
  const [input, setInput] = createSignal("");
  const [running, setRunning] = createSignal(false);
  const [ggbReady, setGgbReady] = createSignal(false);
  const [ggbStatus, setGgbStatus] = createSignal("正在加载 GeoGebra 画板…");
  const [pendingImages, setPendingImages] = createSignal<PreparedImage[]>([]);
  const [hint, setHint] = createSignal("");
  const [busy, setBusy] = createSignal("");
  const [dragOver, setDragOver] = createSignal(false);
  const [lastTikZ, setLastTikZ] = createSignal("");
  // 画板占主区的百分比；读回时做范围校验，避免旧缓存把某一栏挤没
  const savedSplit = Number(localStorage.getItem(LS_SPLIT));
  const [splitPct, setSplitPct] = createSignal<number>(
    Number.isFinite(savedSplit) && savedSplit >= MIN_SPLIT && savedSplit <= MAX_SPLIT
      ? savedSplit
      : DEFAULT_SPLIT,
  );
  const [resizing, setResizing] = createSignal(false);
  // 生成耗时较长（读图 + 多步工具循环），用阶段文案和计时明确告诉用户「正在处理」
  const [waitPhase, setWaitPhase] = createSignal<WaitPhase>("reading");
  const [waited, setWaited] = createSignal(0);

  createEffect(() => {
    if (!running()) return;
    const startedAt = Date.now();
    setWaited(0);
    const timer = window.setInterval(
      () => setWaited(Math.floor((Date.now() - startedAt) / 1000)),
      1000
    );
    onCleanup(() => window.clearInterval(timer));
  });

  let ggb: GeoGebraController | null = null;
  let mainRef: HTMLElement | undefined;
  let scrollRef: HTMLDivElement | undefined;
  let imageInputRef: HTMLInputElement | undefined;
  let ggbFileRef: HTMLInputElement | undefined;
  let hintTimer: number | undefined;

  function showHint(text: string) {
    setHint(text);
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => setHint(""), 5000);
  }

  /** 复制未经 KaTeX 渲染的 Markdown 原文，公式保持规范的 $...$ 形式。 */
  async function copyAnswer(text: string) {
    const ok = await copyText(text);
    showHint(ok ? "已复制 Markdown 原文（公式保持 $...$ 形式）" : "复制失败，请手动选择文本");
  }

  createEffect(() => {
    mainRef?.style.setProperty("--split", `${splitPct()}%`);
  });

  function persistSplit(pct: number) {
    localStorage.setItem(LS_SPLIT, pct.toFixed(1));
  }

  let lastSplitPointerDown = 0;

  /** 拖动分隔条：全屏遮罩接管指针，避免 GeoGebra 的 iframe/canvas 截走 move 事件。 */
  function startResize(e: PointerEvent) {
    // 不调用 preventDefault：它会抑制浏览器生成 dblclick。
    // 防选中/防滚动由 body.is-resizing 与 touch-action:none 承担。
    // 双击重置在这里自己判断，同时也保留 onDblClick 作为兜底。
    const now = Date.now();
    if (now - lastSplitPointerDown < 350) {
      lastSplitPointerDown = 0;
      resetSplit();
      return;
    }
    lastSplitPointerDown = now;
    if (!mainRef) return;
    const rect = mainRef.getBoundingClientRect();
    if (rect.width < 1) return;
    setResizing(true);
    document.body.classList.add("is-resizing");

    const onMove = (ev: PointerEvent) => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, pct)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("is-resizing");
      setResizing(false);
      persistSplit(splitPct());
      // ResizeObserver 已同步过尺寸，结束时再强制对齐一次
      ggb?.resize();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function resetSplit() {
    setSplitPct(DEFAULT_SPLIT);
    persistSplit(DEFAULT_SPLIT);
    ggb?.resize();
  }

  function onSplitKeyDown(e: KeyboardEvent) {
    const step = e.shiftKey ? 5 : 2;
    const current = splitPct();
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = Math.max(MIN_SPLIT, current - step);
    else if (e.key === "ArrowRight") next = Math.min(MAX_SPLIT, current + step);
    else if (e.key === "Enter" || e.key === "Home") next = DEFAULT_SPLIT;
    if (next === null) return;
    e.preventDefault();
    setSplitPct(next);
    persistSplit(next);
    ggb?.resize();
  }

  // 服务端配置探测：云函数返回默认接口地址/模型名，并告知 Key 是否已服务端注入
  onMount(async () => {
    try {
      const res = await fetch("/llm-proxy");
      const data = await res.json();
      const srv = String(data?.baseURL ?? "");
      setServerBaseUrl(srv);
      if (srv && !baseUrl()) setBaseUrl(srv);
      if (data?.model && !model()) setModel(data.model);
      // 只要目标仍是服务端配置的那个服务商，就用占位 Key 让云函数注入真 Key；
      // 用户手动切到别的服务商时不覆盖，避免把占位符透传过去。
      if (data?.serverKey && isPlaceholderKey(apiKey()) && usesServerEndpoint(baseUrl(), srv)) {
        setApiKey("server-injected");
      }
    } catch { /* 离线/后端不可用时维持原逻辑 */ }
  });

  onMount(async () => {
    try {
      ggb = await mountGeoGebra("ggb-container");
      setGgbReady(true);
      const cap = ggb.capabilities();
      const missing = [
        !cap.ggb && ".ggb",
        !cap.tikz && "TikZ（将走降级生成器）",
        !cap.svg && "SVG",
        !cap.png && "PNG",
        !cap.openGgb && "打开 .ggb",
      ].filter(Boolean);
      setGgbStatus(
        missing.length ? `画板就绪 ${cap.version} · 部分导出能力缺失：${missing.join("、")}` : `画板就绪 ${cap.version}`,
      );
    } catch (e) {
      setGgbStatus("画板加载失败：" + (e as Error).message);
    }
  });

  createEffect(() => {
    // 消息变化时滚到底
    messages();
    if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight;
  });

  function saveKey(v: string) {
    setApiKey(v);
    localStorage.setItem(LS_KEY, v);
  }
  function saveModel(v: string) {
    setModel(v);
    localStorage.setItem(LS_MODEL, v);
  }
  function saveBaseUrl(v: string) {
    setBaseUrl(v);
    localStorage.setItem(LS_BASE_URL, v);
    // 切到与服务端配置不同的服务商时，占位 Key 透传过去只会得到 401，先清掉并要求填真 Key；
    // 切回服务端配置的地址时若无自定义 Key，恢复占位符让云函数继续注入。
    if (serverBaseUrl() && !usesServerEndpoint(v, serverBaseUrl()) && isPlaceholderKey(apiKey())) {
      saveKey("");
      showHint("已切换到其它模型服务商，请在右上角填写该服务商的 API Key");
    } else if (usesServerEndpoint(v, serverBaseUrl()) && !apiKey().trim()) {
      saveKey("server-injected");
    }
  }

  function patchMessage(id: number, fn: (m: UiMessage) => UiMessage) {
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }

  // ---------- 图片上传 ----------

  async function addFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    const room = MAX_IMAGES - pendingImages().length;
    if (room <= 0) {
      showHint(`最多同时上传 ${MAX_IMAGES} 张图片`);
      return;
    }
    const picked = images.slice(0, room);
    const prepared: PreparedImage[] = [];
    for (const f of picked) {
      try {
        prepared.push(await prepareImage(f));
      } catch (e) {
        showHint(`「${f.name}」处理失败：${(e as Error).message}`);
      }
    }
    if (prepared.length) setPendingImages((prev) => [...prev, ...prepared]);
    if (images.length > room) showHint(`最多 ${MAX_IMAGES} 张，已忽略多余图片`);
  }

  function removeImage(id: number) {
    setPendingImages((prev) => prev.filter((img) => img.id !== id));
  }

  function onImageInput(e: Event & { currentTarget: HTMLInputElement }) {
    const el = e.currentTarget;
    void addFiles(Array.from(el.files ?? []));
    el.value = "";
  }

  function onComposerPaste(e: ClipboardEvent) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function onComposerDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    void addFiles(Array.from(e.dataTransfer?.files ?? []));
  }

  // ---------- 导出 ----------

  /** 取 TikZ：优先 GeoGebra 原生 exportPGF，失败则用对象快照降级生成。 */
  async function getTikZParts(): Promise<TikZParts> {
    let raw: string;
    try {
      raw = await ggb!.exportTikZ();
    } catch {
      raw = buildTikZFallback(ggb!.inspectObjects());
    }
    const parts = normalizeTikZ(raw);
    if (!/\\begin\{tikzpicture\}/.test(parts.snippet)) {
      throw new Error("返回的 TikZ 内容为空或格式异常");
    }
    return parts;
  }

  async function exportTikZ() {
    try {
      const parts = await getTikZParts();
      downloadText(parts.document, timestampName("tex"), "application/x-tex;charset=utf-8");
      setLastTikZ(parts.snippet);
      showHint("已导出 TikZ（完整 .tex）；点「复制 TikZ」可取片段");
    } catch (e) {
      // 最后一档降级：TikZ 完全不可用时导出 SVG，并明确告知用户
      try {
        const svg = await ggb!.exportSVG();
        downloadText(svg, timestampName("svg"), "image/svg+xml;charset=utf-8");
        showHint(`TikZ 不可用，已改为导出 SVG：${(e as Error).message}`);
      } catch {
        showHint(`TikZ 导出失败：${(e as Error).message}`);
      }
    }
  }

  async function doExport(kind: ExportKind) {
    if (!ggb || !ggbReady()) {
      showHint("画板尚未就绪，请稍候");
      return;
    }
    setBusy(kind);
    try {
      if (kind === "ggb") {
        const b64 = await ggb.getGgbBase64();
        downloadBase64(b64, "application/vnd.geogebra.file", timestampName("ggb"));
        showHint("已导出 .ggb 文件");
      } else if (kind === "png") {
        const b64 = await ggb.exportPNGBase64();
        downloadBase64(b64, "image/png", timestampName("png"));
        showHint("已导出 PNG 图片");
      } else if (kind === "svg") {
        const svg = await ggb.exportSVG();
        downloadText(svg, timestampName("svg"), "image/svg+xml;charset=utf-8");
        showHint("已导出 SVG 图片");
      } else {
        await exportTikZ();
      }
    } catch (e) {
      showHint(`导出失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  }

  async function copyTikZ() {
    if (!ggb) return;
    setBusy("copy");
    try {
      const snippet = lastTikZ() || (await getTikZParts()).snippet;
      setLastTikZ(snippet);
      showHint((await copyText(snippet)) ? "已复制 tikzpicture 片段" : "复制失败，请检查剪贴板权限");
    } catch (e) {
      showHint(`复制失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  }

  async function onGgbFile(e: Event & { currentTarget: HTMLInputElement }) {
    const el = e.currentTarget;
    const file = el.files?.[0];
    if (!file) return;
    try {
      if (!/\.ggb$/i.test(file.name)) throw new Error("请选择 .ggb 文件");
      const b64 = await fileToBase64(file);
      await ggb!.openGgbBase64(b64);
      showHint(`已打开 ${file.name}`);
    } catch (err) {
      showHint(`打开失败：${(err as Error).message}`);
    } finally {
      el.value = "";
    }
  }

  // ---------- 对话 ----------

  async function sendMessage() {
    const text = input().trim();
    const images = pendingImages();
    if ((!text && images.length === 0) || running()) return;
    if (!ggbReady() || !ggb) {
      setGgbStatus("画板尚未就绪，请稍候…");
      return;
    }
    if (serverBaseUrl() && !usesServerEndpoint(baseUrl(), serverBaseUrl()) && isPlaceholderKey(apiKey())) {
      alert(
        "当前使用的是与服务端配置不同的模型服务，请在右上角填写该服务商的 API Key。\n\n" +
          "若想用回服务端已配好的接口（免填 Key），把 Base URL 清空或改回默认地址即可。"
      );
      return;
    }
    if (!apiKey()) {
      alert(
        "服务端还没配置模型 Key。\n请在 EdgeOne Makers 控制台 → Models → API Key 创建一个网关 Key，" +
          "写入项目环境变量 MAKERS_MODELS_KEY 后重新部署；或直接在右上角填写自己的模型服务地址与 API Key。"
      );
      return;
    }

    const userMsg: UiMessage = {
      id: nextId(),
      role: "user",
      content: text,
      images: images.map((img) => img.dataUrl),
      activity: [],
    };
    const aId = nextId();
    const assistantMsg: UiMessage = { id: aId, role: "assistant", content: "", activity: [], pending: true };
    setMessages((p) => [...p, userMsg, assistantMsg]);

    // 历史里剥掉旧图片，只在本轮携带；工具循环后续 step 由 prepareStep 再剥一次
    const core: ModelMessage[] = [
      ...stripImageParts(coreMessages()),
      { role: "user", content: buildUserContent(text, images) },
    ];
    setModelMessages(core);
    setInput("");
    setPendingImages([]);
    setWaitPhase("reading");
    setRunning(true);

    let acc = "";
    try {
      const result = runChat({
        messages: core,
        apiKey: apiKey(),
        model: model(),
        baseURL: baseUrl() || undefined,
        controller: ggb,
      });
      for await (const part of result.fullStream) {
        if (part.type === "text-delta" && part.text) {
          acc += part.text;
          if (waitPhase() !== "writing") setWaitPhase("writing");
          patchMessage(aId, (m) => ({ ...m, content: acc }));
        } else if (part.type === "tool-call") {
          setWaitPhase("drawing");
          patchMessage(aId, (m) => ({
            ...m,
            activity: [...m.activity, `调用工具 ${part.toolName}`],
          }));
        } else if (part.type === "tool-result") {
          patchMessage(aId, (m) => ({
            ...m,
            activity: [...m.activity, `✓ 已写入画板`],
          }));
        } else if (part.type === "error") {
          const msg = friendlyError((part as any).error?.message ?? "未知错误");
          patchMessage(aId, (m) => ({ ...m, activity: [...m.activity, `⚠ ${msg}`] }));
        }
      }
      if (!acc.trim()) acc = "(已完成作图)";
      patchMessage(aId, (m) => ({ ...m, content: acc, pending: false }));
      setModelMessages([...core, { role: "assistant", content: acc }]);
    } catch (e) {
      const msg = friendlyError((e as Error).message ?? String(e));
      patchMessage(aId, (m) => ({
        ...m,
        content: m.content || `出错：${msg}`,
        activity: [...m.activity, `⚠ ${msg}`],
        pending: false,
      }));
    } finally {
      setRunning(false);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div class="app">
      <header class="topbar">
        <div class="brand">GeoChat Web</div>
        <div class="settings">
          <input
            class="input-key"
            type="password"
            placeholder="API Key（EdgeOne 已注入，无需填写）"
            value={apiKey()}
            onInput={(e) => saveKey(e.currentTarget.value)}
          />
          <input
            class="input-model"
            placeholder="模型（默认 @makers/deepseek-v4-flash）"
            value={model()}
            onInput={(e) => saveModel(e.currentTarget.value)}
          />
          <input
            class="input-base-url"
            placeholder="Base URL（默认 EdgeOne 网关）"
            value={baseUrl()}
            onInput={(e) => saveBaseUrl(e.currentTarget.value)}
          />
        </div>
      </header>

      <main class="main" ref={mainRef}>
        <section class="canvas-pane">
          <div class="canvas-toolbar">
            <span class="canvas-status" title={ggbStatus()}>{ggbStatus()}</span>
            <div class="export-actions">
              <button class="tool-btn" disabled={!ggbReady() || !!busy()} onClick={() => doExport("ggb")}>
                {busy() === "ggb" ? "导出中…" : "导出 .ggb"}
              </button>
              <button class="tool-btn" disabled={!ggbReady() || !!busy()} onClick={() => doExport("tikz")}>
                {busy() === "tikz" ? "导出中…" : "导出 TikZ"}
              </button>
              <button class="tool-btn" disabled={!ggbReady() || !!busy()} onClick={() => copyTikZ()}>
                {busy() === "copy" ? "处理中…" : "复制 TikZ"}
              </button>
              <button class="tool-btn" disabled={!ggbReady() || !!busy()} onClick={() => doExport("png")}>
                {busy() === "png" ? "导出中…" : "PNG"}
              </button>
              <button class="tool-btn" disabled={!ggbReady() || !!busy()} onClick={() => doExport("svg")}>
                {busy() === "svg" ? "导出中…" : "SVG"}
              </button>
              <button class="tool-btn" disabled={!ggbReady() || !!busy()} onClick={() => ggbFileRef?.click()}>
                打开 .ggb
              </button>
            </div>
          </div>
          <Show when={hint()}>
            <div class="export-hint">{hint()}</div>
          </Show>
          <input
            ref={ggbFileRef}
            type="file"
            accept=".ggb"
            style={{ display: "none" }}
            onChange={onGgbFile}
          />
          <div id="ggb-container" class="ggb-container" />
        </section>

        <div
          class={`splitter ${resizing() ? "active" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="左右拖动调整画板与聊天区宽度；双击或按 Enter 恢复默认，方向键微调"
          aria-valuemin={MIN_SPLIT}
          aria-valuemax={MAX_SPLIT}
          aria-valuenow={Math.round(splitPct())}
          tabindex={0}
          title="左右拖动调整宽度 · 双击恢复默认"
          onPointerDown={startResize}
          onDblClick={resetSplit}
          onKeyDown={onSplitKeyDown}
        >
          <span class="splitter-grip" aria-hidden="true">⋮</span>
        </div>

        <section class="chat-pane">
          <div class="messages" ref={scrollRef}>
            <Show
              when={messages().length > 0}
              fallback={<div class="empty">输入一道数学/几何题，或上传题目图片，例如「画一个抛物线 y=x²，并标出顶点」</div>}
            >
              <For each={messages()}>
                {(m) => (
                  <div class={`msg ${m.role}`}>
                    <div class="msg-role">{m.role === "user" ? "你" : "助手"}</div>
                    <Show when={m.role === "assistant"}>
                      <div class="activity">
                        <For each={m.activity}>{(a) => <span class="chip">{a}</span>}</For>
                      </div>
                    </Show>
                    <Show when={m.images && m.images.length > 0}>
                      <div class="msg-images">
                        <For each={m.images}>{(src) => <img src={src} alt="用户上传的图片" />}</For>
                      </div>
                    </Show>
                    <Show when={m.content}>
                      <div class="markdown" innerHTML={marked.parse(renderMath(preprocessMarkdown(m.content))) as string} />
                    </Show>
                    <Show when={m.pending}>
                      <div class="waiting" role="status" aria-live="polite">
                        <span class="waiting-dots" aria-hidden="true"><i /><i /><i /></span>
                        <span class="waiting-label">{WAIT_TEXT[waitPhase()]}</span>
                        <span class="waiting-time">已等待 {waited()} 秒</span>
                        <div class="waiting-note">读图与分步作图通常需要 10–60 秒，请稍候，无需重复发送</div>
                      </div>
                    </Show>
                    <Show when={m.role === "assistant" && !!m.content && !m.pending}>
                      <button
                        type="button"
                        class="copy-raw"
                        onClick={() => copyAnswer(m.content)}
                        title="复制 Markdown 原文（公式保持 $...$ 形式）"
                      >
                        复制原文
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <div
            class={`composer ${dragOver() ? "drag-over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onComposerDrop}
          >
            <Show when={running()}>
              <div class="composer-wait" role="status" aria-live="polite">
                <span class="waiting-dots" aria-hidden="true"><i /><i /><i /></span>
                {WAIT_TEXT[waitPhase()]} · 已等待 {waited()} 秒
              </div>
            </Show>
            <Show when={pendingImages().length > 0}>
              <div class="image-strip">
                <For each={pendingImages()}>
                  {(img) => (
                    <div class="image-chip">
                      <img src={img.dataUrl} alt={img.name} title={img.name} />
                      <button type="button" class="image-remove" onClick={() => removeImage(img.id)} aria-label="移除图片">×</button>
                    </div>
                  )}
                </For>
                <span class="image-meta">{pendingImages().length} 张 · 已压缩</span>
              </div>
            </Show>
            <div class="composer-row">
              <button
                type="button"
                class="attach"
                disabled={running()}
                onClick={() => imageInputRef?.click()}
                title="上传图片（也支持粘贴或拖入）"
              >
                ＋ 图片
              </button>
              <textarea
                placeholder={running() ? "助手正在处理，请稍候…" : "描述要画的图，或直接粘贴 / 拖入题目图片…（Enter 发送，Shift+Enter 换行）"}
                value={input()}
                onInput={(e) => setInput(e.currentTarget.value)}
                onKeyPress={onKey}
                onPaste={onComposerPaste}
                disabled={running()}
              />
              <button
                class="send"
                onClick={sendMessage}
                disabled={running() || (!input().trim() && pendingImages().length === 0)}
              >
                {running() ? "生成中…" : "发送"}
              </button>
            </div>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={onImageInput}
            />
          </div>
        </section>
      </main>

      <Show when={resizing()}>
        <div class="resize-mask" />
      </Show>
    </div>
  );
}
