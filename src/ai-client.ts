/**
 * AI 客户端（浏览器内运行）。
 * 用 Vercel ai SDK v6 的 streamText + stopWhen(stepCountIs) 跑「工具调用循环」：
 * 模型产出 executeGeoGebraCommands → execute 直接在画板执行 → 结果回灌 → 模型继续，直到出最终解释文本。
 * 关键：把 provider 的 fetch 改写到本地 /llm-proxy，解决浏览器 CORS 与可选的 Key 隐藏。
 *
 * 图片输入：用户消息用 UserContent 数组承载 ImagePart（AI SDK 会转成 OpenAI 的 image_url）。
 * 因为一轮对话最多跑 6 个 step，若每个 step 都重发图片会显著增加请求体与开销，
 * 所以用 prepareStep 只在首步携带图片，后续 step 用文字占位替代。
 */
import { streamText, tool, jsonSchema, stepCountIs, type ModelMessage, type UserContent } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { GeoGebraController } from "./geogebra";
import { normalizeGeoGebraCommands } from "./lib/normalize";
import type { PreparedImage } from "./lib/image";

const SYSTEM_PROMPT = `你是一名数学几何作图助手。用户会描述数学/几何问题，并可能附带图片，你需要：
1. 调用 executeGeoGebraCommands 工具，在 GeoGebra 画板上构造图形；
2. 然后用简短中文文字解释构造关系与关键步骤。

GeoGebra 命令必须使用英文（不接受中文别名），示例：
- 点/线/圆：A=(0,0)、B=(2,0)、Segment(A,B)、Circle(A,1)、Midpoint(A,B)
- 函数：f(x)=x^2、g(x)=2x+1、Intersect(f,g)
- 多边形/圆锥：Polygon(A,B,C)、Ellipse(F1,F2,3)、Parabola(A,1)
- 3D：C=(0,0,2)、Pyramid(A,B,C,D,2)、Sphere(A,1)

注意事项：
- 点坐标用 A=(0,0) 或 (1,2) 格式，不要用 Point((0,0))
- 点名称必须用大写字母开头（如 A、B、P1），小写名在 GeoGebra 中被视为向量
- 每一个命令要独立且完整，不要依赖前序命令的副作用
- 尽量一次性给出完整命令序列，避免分多次调用
- 作图后务必用文字解释关键步骤和几何关系

用户附带图片时：
- 先仔细读图，复述图中的题目文字、几何对象、字母标注、坐标系、函数形状与数值条件；
- 再把识别到的关系转成英文 GeoGebra 命令复现图形；
- 看不清或不确定的地方要明确说明，不要编造题目条件；
- 图片里若是纯文字题目，也要先转写成文字再作图。

命令语法硬性规则（违反会导致执行失败）：
- 命令内禁止任何 LaTeX 写法：圆周率写 pi（不是 \\pi），平方根写 sqrt(2)（不是 \\sqrt{2}），分数写 a/b 或 (a)/(b)（不是 \\frac{a}{b}）
- 角度用度数 45° 或弧度 pi/4 表示
- 希腊字母变量可直接用 Unicode（φ、θ、α），且必须先定义再引用（如先 ph = pi/4，再 Rotate(A, ph, O)）
- 只用半角英文括号、逗号；每个数组元素只放一条命令，禁止用分号连接多条
- LaTeX 定界规则只适用于解释文字：数学公式用 $...$（行内）或 $$...$$（块级），不要用 (...) 或 [...] 代替`;

/** 把对大模型供应商的请求改写到本地代理。 */
const proxyFetch = (input: any, init?: any): Promise<Response> => {
  const target = typeof input === "string" ? input : (input as Request).url;
  const headers = new Headers(init?.headers);
  headers.set("x-target-url", target);
  try {
    const host = new URL(target).host;
    if (host && host !== "api.openai.com") {
      headers.set("x-custom-hostname", host);
    }
  } catch { /* ignore */ }
  return fetch("/llm-proxy", { ...init, headers });
};

/** 构造一条可能带图片的 user 消息内容。 */
export function buildUserContent(text: string, images: PreparedImage[]): UserContent {
  if (images.length === 0) return text;
  type Part = { type: "text"; text: string } | { type: "image"; image: string; mediaType: string };
  const parts: Part[] = [];
  if (text.trim()) parts.push({ type: "text", text });
  for (const img of images) {
    parts.push({ type: "image", image: img.base64, mediaType: img.mediaType });
  }
  return parts as UserContent;
}

/** 移除消息里的图片 part（多轮历史 / 工具循环后续 step 用），避免重复传输大图。 */
export function stripImageParts(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== "user" || typeof m.content === "string") return m;
    const parts = m.content as Array<{ type: string; text?: string; mediaType?: string }>;
    const kept = parts.filter(
      (p) => !(p.type === "image" || (p.type === "file" && String(p.mediaType ?? "").startsWith("image/"))),
    );
    if (kept.length === 0) {
      return { ...m, content: "[此前上传了图片]" } as ModelMessage;
    }
    if (kept.length === 1 && kept[0].type === "text") {
      return { ...m, content: String(kept[0].text ?? "") } as ModelMessage;
    }
    return { ...m, content: kept } as unknown as ModelMessage;
  });
}

interface GeoGebraToolInput {
  commands: string[];
  perspective?: string;
  resetBefore?: boolean;
}

export interface RunChatOptions {
  messages: ModelMessage[];
  apiKey: string;
  model: string;
  baseURL?: string;
  controller: GeoGebraController;
}

export function runChat(opts: RunChatOptions) {
  const openai = createOpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, fetch: proxyFetch as any });
  return streamText({
    model: openai.chat(opts.model),
    system: SYSTEM_PROMPT,
    messages: opts.messages,
    stopWhen: stepCountIs(6),
    // 图片只在第一步发送：后续 step 已能从前文文本理解图片内容
    prepareStep: ({ stepNumber, messages }) =>
      stepNumber === 0 ? undefined : { messages: stripImageParts(messages) },
    tools: {
      executeGeoGebraCommands: tool({
        description:
          "在 GeoGebra 画板执行一批构造命令。commands 为 GeoGebra 命令字符串数组。",
        inputSchema: jsonSchema<GeoGebraToolInput>({
          type: "object",
          properties: {
            commands: {
              type: "array",
              items: { type: "string" },
              description: "GeoGebra 命令，如 A=(0,0)、f(x)=x^2、Segment(A,B)",
            },
            perspective: {
              type: "string",
              description: "可选视角码：G=2D图形、T=3D、AG=代数+图形（默认 AG）",
            },
            resetBefore: {
              type: "boolean",
              description: "执行前是否清空画板",
            },
          },
          required: ["commands"],
        }),
        execute: async ({ commands, perspective, resetBefore }) => {
          const norm = normalizeGeoGebraCommands(commands ?? []);
          const r = await opts.controller.executeCommands(norm, {
            perspective,
            resetBefore,
            restoreOnError: true,
          });
          return {
            ok: r.ok,
            failed: r.failed,
            xml: opts.controller.getXML(),
          };
        },
      }),
      resetCanvas: tool({
        description: "清空 GeoGebra 画板。",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => {
          await opts.controller.reset();
          return { ok: true };
        },
      }),
    },
  });
}
