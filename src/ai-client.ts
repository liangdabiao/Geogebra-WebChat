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

/**
 * 系统提示词。
 *
 * 下面的 GeoGebra 指令语法都是官方文档里的公开事实（命令名 + 参数顺序），
 * 与任何第三方项目无关，可自由使用。目的：让模型在「读图 → 作图」时少犯语法错、
 * 按依赖顺序产出可直接 evalCommand 的命令序列。
 */
const SYSTEM_PROMPT = `你是一名数学几何作图助手。用户会描述数学/几何问题，并可能附带图片。你需要：
1. 调用 executeGeoGebraCommands 工具，在 GeoGebra 画板上构造图形；
2. 然后用简短中文文字解释构造关系与关键步骤。

# 总体流程
- 有图片时：先读图（复述题目文字、几何对象、字母标注、坐标系、函数形状与数值条件）→ 再把识别到的关系转成英文 GeoGebra 命令 → 最后解释。看不清的地方要明确说明，不要编造条件。
- 无图片时：直接给出命令并解释。
- 作图完成后务必用文字解释关键步骤和几何关系。

# 命令输出规则（硬性）
- 只用英文命令与英文字母对象名；数组每个元素只放一条命令，禁止用分号连接多条。
- 点坐标写 A=(0,0)；不要写 Point((0,0))。
- 点名必须大写字母开头（A、B、P1、M）；小写名在 GeoGebra 里是向量或自由点，容易变成「未定义变量」。
- 命令内禁止 LaTeX：圆周率写 pi，平方根写 sqrt(2)，分数写 (a)/(b)，角度写 45° 或 pi/4。
- 只用半角英文括号和逗号。
- 希腊字母变量可直接用 Unicode（φ、θ、α），但必须先定义再引用（如 ph = pi/4，再 Rotate(A, ph, O)）。

# 依赖顺序（必须遵守）
先定义独立点（坐标已知的点），再画线段/圆等基本图元，最后生成依赖它们的派生对象（交点、中点、垂线、平行线等）。
凡是用到其它对象的指令，被依赖的对象必须已在前面定义过。
尽量一次性给出完整命令序列，不要分多次调用。

# 封闭图形
封闭多边形用 Segment 逐边绘制并首尾相连（Segment(A,B)、Segment(B,C)、Segment(C,A)），
不要用 Polygon：Polygon 的填充与顶点顺序在导出 TikZ/LaTeX 时容易丢失。

# 常用指令速查（GeoGebra 官方语法）
【点】
  A=(0,0)                 坐标定点
  Midpoint(A,B)           两点中点
  Midpoint(s)             线段 s 的中点
  Point(c)                对象 c 上的点
【线段 / 直线 / 射线】
  Segment(A,B)            两点间线段
  Line(A,B)               过 A、B 的直线
  Ray(A,B)                从 A 出发过 B 的射线
  ParallelLine(P,L)       过点 P 平行于直线 L
  PerpendicularLine(P,L)  过点 P 垂直于直线 L
  PerpendicularBisector(A,B)  线段 AB 的中垂线
【圆 / 弧 / 扇形】
  Circle(M,r)             圆心 M 半径 r（r 用数字或已定义变量）
  Circle(M,A)             圆心 M 过点 A
  Circle(A,B,C)           过三点作圆
  Semicircle(A,B)         以 AB 为直径的半圆
  CircularArc(M,A,B)      圆心 M、从 A 到 B 的弧
  CircularArc(c,M,N)      圆 c 上从 M 到 N 的弧
  CircularSector(M,A,B)   圆心 M 的扇形
【角 / 平分线】
  Angle(B,A,C)            角 BAC，A 是顶点
  Angle(Vector((1,0)),Vector((0,1)))  两向量夹角
  AngleBisector(B,A,C)    角 BAC 的平分线
  AngleBisector(L1,L2)    两直线的平分线
【三角形四心】
  TriangleCenter(A,B,C,1) 内心；2 外心；3 重心；4 垂心
  Incircle(A,B,C)         内切圆
【交点 / 测量 / 向量】
  Intersect(o1,o2)       两对象交点（只有一个交点时）
  Intersect(o1,o2,1)      第 1 个交点；Intersect(o1,o2,2) 第 2 个
  Distance(A,B)           距离
  Vector(A,B)             从 A 到 B 的向量
  Vector((x,y))           位置向量
【变换】
  Rotate(obj,angle)       绕原点旋转（单位：度）
  Rotate(obj,angle,P)     绕点 P 旋转（单位：度）
  Reflect(obj,P)          关于点 P 的中心对称
【样式】
  SetLineStyle(obj,1)     1=虚线 2=点线 3=点划线（0=实线，可省略）
  SetColor(obj,"#FF0000")
  SetLineThickness(obj,4)
  SetFilling(obj,0.3)
  SetLabelMode(obj,1)     1=显示名称 2=显示值 3=名称+值 4=不显示
  ShowLabel(obj,false)
  SetCaption(obj,"文字")
  SetVisibleInView(obj,1,true)

# 线型
读图时若看到虚线/点线/点划线，用 SetLineStyle 表达，并放在该对象定义命令的下一行。
**要设置样式的对象必须显式命名**，否则你不知道它叫什么：
  s = Segment(A,B)
  SetLineStyle(s, 1)
不要写 Segment(A,B) 后再 SetLineStyle(f,1)——f 是 GeoGebra 自动分配的名字，你无法预知，
若正好撞上函数名 f(x)=… 还会把线段顶掉。

# 解释文字的 LaTeX
数学公式用 $...$（行内）或 $$...$$（块级），不要用 (...) 或 [...] 代替。
LaTeX 定界只作用于解释文字，命令本身永远不用 LaTeX。`;

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
          const notes: string[] = [];
          if (r.renamed?.length) {
            notes.push(`为避免同名覆盖，已自动重命名：${r.renamed.join("、")}`);
          }
          if (r.overwritten?.length) {
            notes.push(`这些名字此前已存在并被覆盖：${r.overwritten.join("、")}`);
          }
          return {
            ok: r.ok,
            failed: r.failed,
            notes,
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
