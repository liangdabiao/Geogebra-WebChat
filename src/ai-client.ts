/**
 * AI 客户端（浏览器内运行）。
 * 用 Vercel ai SDK v6 的 streamText + stopWhen(stepCountIs) 跑「工具调用循环」：
 * 模型产出 executeGeoGebraCommands → execute 直接在画板执行 → 结果回灌 → 模型继续，直到出最终解释文本。
 * 关键：把 provider 的 fetch 改写到本地 /api/llm-proxy，解决浏览器 CORS 与可选的 Key 隐藏。
 */
import { streamText, tool, jsonSchema, stepCountIs, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { GeoGebraController } from "./geogebra";
import { normalizeGeoGebraCommands } from "./lib/normalize";

const SYSTEM_PROMPT = `你是一名数学几何作图助手。用户会描述数学/几何问题，你需要：
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
	- 数学公式中的 LaTeX 必须使用 $...$（行内）或 $$...$$（块级）定界，不要用 (...) 或 [...] 代替`;

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
  return fetch("/api/llm-proxy", { ...init, headers });
};

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
