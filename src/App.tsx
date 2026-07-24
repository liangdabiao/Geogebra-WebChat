import { createSignal, onMount, For, Show, createEffect } from "solid-js";
import { marked } from "marked";
import { mountGeoGebra, type GeoGebraController } from "./geogebra";
import { runChat } from "./ai-client";
import type { ModelMessage } from "ai";

interface UiMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  activity: string[];
}

let _id = 1;
const nextId = () => _id++;

const LS_KEY = "geochat-web-key";
const LS_MODEL = "geochat-web-model";
const LS_BASE_URL = "geochat-web-base-url";

export default function App() {
  const [apiKey, setApiKey] = createSignal(localStorage.getItem(LS_KEY) ?? "");
  const [model, setModel] = createSignal(localStorage.getItem(LS_MODEL) ?? "gpt-4o-mini");
  const [baseUrl, setBaseUrl] = createSignal(localStorage.getItem(LS_BASE_URL) ?? "");
  const [messages, setMessages] = createSignal<UiMessage[]>([]);
  const [coreMessages, setModelMessages] = createSignal<ModelMessage[]>([]);
  const [input, setInput] = createSignal("");
  const [running, setRunning] = createSignal(false);
  const [ggbReady, setGgbReady] = createSignal(false);
  const [ggbStatus, setGgbStatus] = createSignal("正在加载 GeoGebra 画板…");

  let ggb: GeoGebraController | null = null;
  let scrollRef: HTMLDivElement | undefined;

  onMount(async () => {
    try {
      ggb = await mountGeoGebra("ggb-container");
      setGgbReady(true);
      setGgbStatus("画板就绪");
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
  }

  function patchMessage(id: number, fn: (m: UiMessage) => UiMessage) {
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }

  async function sendMessage() {
    const text = input().trim();
    if (!text || running()) return;
    if (!ggbReady() || !ggb) {
      setGgbStatus("画板尚未就绪，请稍候…");
      return;
    }
    if (!apiKey()) {
      alert("请先在右上角填写模型 API Key");
      return;
    }

    setInput("");
    const userMsg: UiMessage = { id: nextId(), role: "user", content: text, activity: [] };
    const aId = nextId();
    const assistantMsg: UiMessage = { id: aId, role: "assistant", content: "", activity: [] };
    setMessages((p) => [...p, userMsg, assistantMsg]);

    const core: ModelMessage[] = [...coreMessages(), { role: "user", content: text }];
    setModelMessages(core);
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
          patchMessage(aId, (m) => ({ ...m, content: acc }));
        } else if (part.type === "tool-call") {
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
          const msg = (part as any).error?.message ?? "未知错误";
          patchMessage(aId, (m) => ({ ...m, activity: [...m.activity, `⚠ ${msg}`] }));
        }
      }
      if (!acc.trim()) acc = "(已完成作图)";
      patchMessage(aId, (m) => ({ ...m, content: acc }));
      setModelMessages([...core, { role: "assistant", content: acc }]);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      patchMessage(aId, (m) => ({
        ...m,
        content: m.content || `出错：${msg}`,
        activity: [...m.activity, `⚠ ${msg}`],
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
            placeholder="OpenAI API Key"
            value={apiKey()}
            onInput={(e) => saveKey(e.currentTarget.value)}
          />
          <input
            class="input-model"
            placeholder="模型"
            value={model()}
            onInput={(e) => saveModel(e.currentTarget.value)}
          />
          <input
            class="input-base-url"
            placeholder="API Base URL (可选)"
            value={baseUrl()}
            onInput={(e) => saveBaseUrl(e.currentTarget.value)}
          />
        </div>
      </header>

      <main class="main">
        <section class="canvas-pane">
          <div class="canvas-status">{ggbStatus()}</div>
          <div id="ggb-container" class="ggb-container" />
        </section>

        <section class="chat-pane">
          <div class="messages" ref={scrollRef}>
            <Show
              when={messages().length > 0}
              fallback={<div class="empty">输入一道数学/几何题，例如「画一个抛物线 y=x²，并标出顶点」</div>}
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
                    <Show when={m.content}>
                      <div class="markdown" innerHTML={marked.parse(m.content) as string} />
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <div class="composer">
            <textarea
              placeholder="描述要画的图…（Enter 发送，Shift+Enter 换行）"
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
              onKeyPress={onKey}
              disabled={running()}
            />
            <button class="send" onClick={sendMessage} disabled={running() || !input().trim()}>
              {running() ? "生成中…" : "发送"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
