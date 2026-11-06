/**
 * TikZ 生成、清洗与覆盖校验（纯函数，浏览器内运行，零依赖）。
 *
 * 三个关键事实（均由本项目在 GeoGebra 5.0 web3d 上实测得到）：
 *
 *  1. applet 的 `getDefinitionString` / `getCommandString` 返回的是**本地化字符串**
 *     （实测中文环境返回「线段AB」「圆周(C, 1.5)」），因此任何按英文正则解析定义的
 *     逻辑在中文环境下都会失效。唯一稳定的英文来源是 `getXML()`：
 *        <expression label="f" exp="f(x) = x^(2) / 3 - 2" type="function"/>
 *        <command name="Segment"><input a0="B" a1="C"/><output a0="t"/></command>
 *
 *  2. 引擎原生 `exportPGF` 的产物是忠实的：画面上有的图形它都会画。
 *     真正会让图形「消失」的是**同名覆盖**——GeoGebra 自动把线段命名为 f、g、h…，
 *     模型的 `f(x)=…` 会静默顶掉同名的线段。因此必须做「对象集合 ↔ PGF 绘图元素」
 *     的覆盖校验，缺什么就补什么。
 *
 *  3. 引擎原生 PGF 里带 pgfplots 的坐标轴/网格环境，且重复线段会被画多遍
 *     （同一条边的多个副本）。「精简版」= 去掉坐标轴环境 + 按几何签名去重 +
 *     坐标取整，同时保留颜色、线型、角度标记与标签。
 */

import type { GgbObjectInfo } from "../geogebra";

/* ------------------------------------------------------------------ *
 * 数值与文本工具
 * ------------------------------------------------------------------ */

/** 数字格式化：最多保留 digits 位小数，去掉尾随 0。 */
export function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return "0";
  let s = v.toFixed(digits);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0" || s === "") s = "0";
  return s;
}

/** 转义 LaTeX 特殊字符（用于标签 / 文本节点）。 */
export function texEscape(s: string): string {
  return s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&$#%_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

/* ------------------------------------------------------------------ *
 * 1. 从 XML 还原英文定义
 * ------------------------------------------------------------------ */

export interface XmlObject {
  label: string;
  /** GeoGebra 元素类型：point / segment / conic / polygon / function / angle … */
  type: string;
  /** 英文定义，如 Segment(B,C)、Circle(C,1.5)、x^(2)/3-2 */
  def: string;
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function xmlUnescape(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

function xmlAttr(tag: string, name: string): string {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? xmlUnescape(m[1]) : "";
}

/**
 * 解析 GeoGebra 构造 XML，得到「标签 → 英文定义」映射。
 * 只取每个 command 的第一个输出作为该命令的主对象；
 * 额外输出（如 Polygon 产生的边线）由多边形本身推导。
 */
export function parseConstructionXml(xml: string): Map<string, XmlObject> {
  const out = new Map<string, XmlObject>();
  if (!xml) return out;

  // 元素类型：<element type="point" label="A">
  const types = new Map<string, string>();
  for (const m of xml.matchAll(/<element\s+type="([^"]+)"\s+label="([^"]+)"/g)) {
    types.set(xmlUnescape(m[2]), m[1]);
  }

  // 独立对象：<expression label="A" exp="(0, 0)" type="point"/>
  for (const m of xml.matchAll(/<expression\s+label="([^"]+)"\s+exp="([^"]*)"([^/]*)\/>/g)) {
    const label = xmlUnescape(m[1]);
    const exp = xmlUnescape(m[2]);
    const typeAttr = /type="([^"]+)"/.exec(m[3] ?? "");
    out.set(label, {
      label,
      type: types.get(label) ?? typeAttr?.[1] ?? "",
      def: exp,
    });
  }

  // 命令对象：<command name="Segment"><input a0="B" a1="C"/><output a0="t"/></command>
  // 注意：input/output 是「一个元素带多个 a0/a1/a2 属性」，不是一个属性一个元素。
  for (const m of xml.matchAll(/<command\s+name="([^"]+)"\s*>([\s\S]*?)<\/command>/g)) {
    const name = xmlUnescape(m[1]);
    const inner = m[2];
    const inputs: string[] = [];
    for (const im of inner.matchAll(/<input\s+([^>]*?)\/>/g)) {
      for (const am of im[1].matchAll(/a\d+="([^"]*)"/g)) inputs.push(xmlUnescape(am[1]));
    }
    const outputs: string[] = [];
    for (const om of inner.matchAll(/<output\s+([^>]*?)\/>/g)) {
      for (const am of om[1].matchAll(/a\d+="([^"]*)"/g)) outputs.push(xmlUnescape(am[1]));
    }
    const main = outputs[0];
    if (!main) continue;
    const def = inputs.length ? `${name}(${inputs.join(",")})` : name;
    out.set(main, { label: main, type: types.get(main) ?? "", def });
  }

  // 没有在 expression/command 里出现、但存在于 element 里的对象，至少保留类型
  for (const [label, type] of types) {
    if (!out.has(label)) out.set(label, { label, type, def: "" });
  }
  return out;
}

/**
 * 给对象补齐英文定义。
 * applet 返回的 definition 是本地化的，这里用 XML 里的英文定义覆盖它。
 */
export function withEnglishDefinitions(
  objects: GgbObjectInfo[],
  xml: string,
): (GgbObjectInfo & { englishDef: string })[] {
  const defs = parseConstructionXml(xml);
  return objects.map((o) => {
    const d = defs.get(o.name);
    return {
      ...o,
      englishDef: o.englishDef || d?.def || "",
      type: o.type || d?.type || "",
    };
  });
}

/**
 * 内部兜底：对象若没带 englishDef，就从构造 XML 里补上。
 * 这样调用方即使忘了先合并定义，几何解析与兜底生成器依然能工作。
 */
function resolveDefs(
  objects: (GgbObjectInfo & { englishDef?: string })[],
  xml?: string,
): (GgbObjectInfo & { englishDef: string })[] {
  const need = objects.some((o) => !o.englishDef);
  if (!need || !xml) {
    return objects.map((o) => ({ ...o, englishDef: o.englishDef || o.definition || "" }));
  }
  return withEnglishDefinitions(objects as GgbObjectInfo[], xml);
}

/* ------------------------------------------------------------------ *
 * 2. 对象集合 → 期望几何
 * ------------------------------------------------------------------ */

/** 去掉定义里的空白，取出参数列表。 */
function defArgs(def: string): string[] {
  const m = /^[^(]*\((.*)\)\s*$/.exec(def.trim());
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 从定义里取出引用的对象名（支持 Unicode 标签，如 α）。 */
function defRefs(def: string): string[] {
  const args = defArgs(def);
  if (args.length) return args.filter((a) => !/^[-+]?[\d.]+$/.test(a));
  return (def.match(/[^\s(),]+/g) ?? []).filter((s) => !/^[-+]?[\d.]+$/.test(s));
}

export interface Geometry {
  /** 有限线段：端点键排序后拼接 */
  edges: Set<string>;
  /** 圆：圆心 + 半径 */
  circles: Set<string>;
  /** 点 */
  points: Set<string>;
}

const edgeKey = (x1: number, y1: number, x2: number, y2: number): string => {
  const a = `${fmt(x1, 4)},${fmt(y1, 4)}`;
  const b = `${fmt(x2, 4)},${fmt(y2, 4)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
};
const circleKey = (cx: number, cy: number, r: number): string =>
  `${fmt(cx, 4)},${fmt(cy, 4)}|${fmt(r, 4)}`;
const pointKey = (x: number, y: number): string => `${fmt(x, 4)},${fmt(y, 4)}`;

/**
 * 从对象快照推导「应该画出来」的几何。
 * 只统计有界的图元（线段 / 圆 / 点 / 多边形边），
 * 无限直线与射线在 PGF 里是被视口裁剪的，无法逐一比对，故跳过。
 */
export function expectedGeometry(
  rawObjects: (GgbObjectInfo & { englishDef?: string })[],
  xml?: string,
): Geometry {
  const objects = resolveDefs(rawObjects, xml);
  const g: Geometry = { edges: new Set(), circles: new Set(), points: new Set() };
  const byName = new Map(objects.map((o) => [o.name, o]));
  const pos = (name: string) => {
    const o = byName.get(name);
    if (!o) return null;
    return { x: o.x, y: o.y };
  };

  for (const o of objects) {
    if (!o.visible) continue;
    const def = o.englishDef || o.definition || "";
    const type = o.type;

    if (type === "point") {
      g.points.add(pointKey(o.x, o.y));
      continue;
    }

    if (type === "segment") {
      const refs = defRefs(def);
      const a = pos(refs[0]);
      const b = pos(refs[1]);
      if (a && b) g.edges.add(edgeKey(a.x, a.y, b.x, b.y));
      continue;
    }

    if (type === "polygon" || type === "polyline") {
      const refs = defRefs(def).map(pos).filter(Boolean) as { x: number; y: number }[];
      for (let i = 0; i + 1 < refs.length; i++) {
        g.edges.add(edgeKey(refs[i].x, refs[i].y, refs[i + 1].x, refs[i + 1].y));
      }
      if (type === "polygon" && refs.length > 2) {
        const last = refs[refs.length - 1];
        g.edges.add(edgeKey(last.x, last.y, refs[0].x, refs[0].y));
      }
      continue;
    }

    if (type === "circle" || type === "semicircle" || type === "arc" || type === "conic") {
      // Circle(C,1.5) / Circle[A, 2]
      const m = /^Circle\s*[\[(]\s*([^,]+),\s*(.+?)\s*[\])]$/i.exec(def);
      if (m) {
        const center = pos(m[1].trim());
        if (center) {
          let r = Number(m[2]);
          if (!Number.isFinite(r)) {
            const other = pos(m[2].trim());
            if (other) r = Math.hypot(other.x - center.x, other.y - center.y);
          }
          if (Number.isFinite(r) && r > 0) g.circles.add(circleKey(center.x, center.y, r));
        }
      }
      continue;
    }
  }
  return g;
}

/* ------------------------------------------------------------------ *
 * 3. PGF 文本 → 实际几何
 * ------------------------------------------------------------------ */

/** 解析引擎 PGF 里实际画出来的几何，用于覆盖校验。 */
export function parsePgfGeometry(pgf: string): Geometry {
  const g: Geometry = { edges: new Set(), circles: new Set(), points: new Set() };

  // 圆：(cx,cy) circle (r cm)
  for (const m of pgf.matchAll(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)\s*circle\s*\(\s*(\d+(?:\.\d+)?)\s*cm\s*\)/g)) {
    g.circles.add(circleKey(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  // 点：(cx,cy) circle (r pt)
  for (const m of pgf.matchAll(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)\s*circle\s*\(\s*(\d+(?:\.\d+)?)\s*pt\s*\)/g)) {
    g.points.add(pointKey(Number(m[1]), Number(m[2])));
  }
  // 线段：同一 draw 语句里相邻的坐标对
  for (const m of pgf.matchAll(/\\draw[^;]*;/g)) {
    const stmt = m[0];
    const pts = [...stmt.matchAll(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/g)].map((p) => ({
      x: Number(p[1]),
      y: Number(p[2]),
    }));
    for (let i = 0; i + 1 < pts.length; i++) {
      g.edges.add(edgeKey(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y));
    }
  }
  return g;
}

export interface MissingGeometry {
  edges: string[];
  circles: string[];
  points: string[];
  total: number;
}

/** 期望几何减去实际几何。 */
export function diffGeometry(expected: Geometry, actual: Geometry): MissingGeometry {
  const edges = [...expected.edges].filter((k) => !actual.edges.has(k));
  const circles = [...expected.circles].filter((k) => !actual.circles.has(k));
  const points = [...expected.points].filter((k) => !actual.points.has(k));
  return { edges, circles, points, total: edges.length + circles.length + points.length };
}

/* ------------------------------------------------------------------ *
 * 4. 补齐缺失图元
 * ------------------------------------------------------------------ */

interface ColorPool {
  defs: string[];
  map: Map<string, string>;
}

function createColorPool(): ColorPool {
  return { defs: [], map: new Map() };
}

/** 把 #RRGGBB 注册成 \\definecolor，返回引用名。 */
function colorRef(pool: ColorPool, hex: string): string {
  const h = (hex || "").trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) return "black";
  const key = h.toUpperCase();
  let ref = pool.map.get(key);
  if (!ref) {
    ref = `ggbc${pool.map.size}`;
    pool.map.set(key, ref);
    pool.defs.push(`\\definecolor{${ref}}{HTML}{${h.slice(1).toUpperCase()}}`);
  }
  return ref;
}

/**
 * 把缺失的图元补进引擎 PGF。
 * 引擎产物是忠实的，缺失通常来自「同名覆盖」，这里按对象快照补回。
 */
export function patchPgfWithMissing(
  pgf: string,
  missing: MissingGeometry,
  objects: (GgbObjectInfo & { englishDef?: string })[],
): { patched: string; added: number; pool: ColorPool } {
  const pool = createColorPool();
  if (missing.total === 0) return { patched: pgf, added: 0, pool };

  // 找出每个缺失边/圆对应的对象，用来取颜色
  const findColor = (pred: (o: GgbObjectInfo & { englishDef?: string }) => boolean): string => {
    const o = objects.find(pred);
    return o ? colorRef(pool, o.color) : "black";
  };

  const lines: string[] = [];

  for (const key of missing.edges) {
    const [a, b] = key.split("|").map((s) => s.split(",").map(Number) as [number, number]);
    const p1 = `${fmt(a[0])},${fmt(a[1])}`;
    const p2 = `${fmt(b[0])},${fmt(b[1])}`;
    const color = findColor((o) => {
      if (o.type !== "segment") return false;
      const def = o.englishDef || o.definition || "";
      const refs = defRefs(def);
      const byName = new Map(objects.map((x) => [x.name, x]));
      const p0 = byName.get(refs[0]);
      const p1o = byName.get(refs[1]);
      if (!p0 || !p1o) return false;
      return edgeKey(p0.x, p0.y, p1o.x, p1o.y) === key;
    });
    lines.push(`\\draw [line width=2pt,color=${color}] (${p1})-- (${p2});`);
  }

  for (const key of missing.circles) {
    const [c, r] = key.split("|");
    const [cx, cy] = c.split(",").map(Number);
    const color = findColor((o) => o.type === "circle" || o.type === "conic");
    lines.push(`\\draw [line width=2pt,color=${color}] (${fmt(cx)},${fmt(cy)}) circle (${fmt(Number(r))}cm);`);
  }

  for (const key of missing.points) {
    const [x, y] = key.split(",").map(Number);
    const color = findColor((o) => o.type === "point");
    lines.push(`\\draw [fill=${color}] (${fmt(x)},${fmt(y)}) circle (2.5pt);`);
  }

  if (!lines.length) return { patched: pgf, added: 0, pool };

  const marker = "\\end{tikzpicture}";
  const idx = pgf.lastIndexOf(marker);
  const patched =
    idx >= 0
      ? pgf.slice(0, idx) + lines.join("\n") + "\n" + pgf.slice(idx)
      : pgf + "\n" + lines.join("\n") + "\n";

  return { patched, added: lines.length, pool };
}

/* ------------------------------------------------------------------ *
 * 5. 精简版：去坐标轴 / 去重 / 取整
 * ------------------------------------------------------------------ */

export interface CompactStats {
  removedDuplicates: number;
  removedAxes: boolean;
  totalDraws: number;
}

/** 一条 draw 语句的几何签名（用于去重）。 */
function drawSignature(stmt: string): string {
  const pts = [...stmt.matchAll(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
  let coords = pts.map((p) => `${fmt(p.x, 4)},${fmt(p.y, 4)}`).join(" ");
  // 同一段线段正反两个方向视为同一条
  if (pts.length === 2 && stmt.includes("--")) {
    coords = [coords, [fmt(pts[1].x, 4), fmt(pts[1].y, 4)].join(",")].sort().join(" ");
  }
  const rest = stmt
    .replace(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/g, "(P)")
    .replace(/\d+(?:\.\d+)?/g, "N");
  return `${rest}|${coords}`;
}

/** 去掉 pgfplots 的坐标轴环境，保留其中的绘图内容；顺带去掉 clip 行。 */
export function stripAxes(pgf: string): { body: string; removed: boolean } {
  // 注意 `\begin{axis}[...]` 的选项块要一并去掉，否则会残留进精简产物
  const m = /\\begin\{axis\}(\[[\s\S]*?\])?([\s\S]*?)\\end\{axis\}/.exec(pgf);
  if (!m) return { body: pgf, removed: false };
  let inner = m[2] ?? "";
  // 去掉 clip 行（视口裁剪）
  inner = inner.replace(/\\clip\s*\([^)]*\)\s*rectangle\s*\([^)]*\)\s*;?/g, "");
  const body = pgf.replace(/\\begin\{axis\}(\[[\s\S]*?\])?[\s\S]*?\\end\{axis\}/, inner);
  return { body, removed: body !== pgf };
}

/** 按几何签名去重重复的 draw 语句。 */
export function dedupeDraws(body: string): { body: string; removed: number; total: number } {
  const seen = new Set<string>();
  const kept: string[] = [];
  let removed = 0;
  let total = 0;
  // 以 ";" 为句边界切分，保留分号
  const parts = body.split(/(;)/);
  for (const part of parts) {
    if (part === ";") {
      kept.push(part);
      continue;
    }
    if (!part.trim()) {
      kept.push(part);
      continue;
    }
    total++;
    const sig = drawSignature(part);
    if (seen.has(sig)) {
      removed++;
      continue;
    }
    seen.add(sig);
    kept.push(part);
  }
  return { body: kept.join(""), removed, total };
}

/** 把 (x,y) 形式的坐标取整到指定小数位。 */
export function roundCoords(body: string, digits = 2): string {
  return body.replace(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/g, (_m, x: string, y: string) => {
    const rx = Math.round(Number(x) * 10 ** digits) / 10 ** digits;
    const ry = Math.round(Number(y) * 10 ** digits) / 10 ** digits;
    return `(${fmt(rx, digits)},${fmt(ry, digits)})`;
  });
}

/* ------------------------------------------------------------------ *
 * 6. 文档组装
 * ------------------------------------------------------------------ */

export function wrapTikZDocument(snippet: string, extraPreamble: string[] = []): string {
  return [
    "\\documentclass[10pt]{article}",
    "\\usepackage{pgf,tikz}",
    "\\usepackage{mathrsfs}",
    "\\usetikzlibrary{arrows}",
    "\\pagestyle{empty}",
    "\\begin{document}",
    ...extraPreamble,
    snippet,
    "\\end{document}",
    "",
  ].join("\n");
}

/** 从任意文本里抽出 tikzpicture 片段。 */
export function extractTikzPicture(text: string): string {
  const m = /\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/.exec(text);
  return (m ? m[0] : text).trim();
}

/** 规整引擎产物：完整文档 + 片段。 */
export function normalizeTikZ(raw: string): { document: string; snippet: string } {
  const text = raw.trim();
  const snippet = extractTikzPicture(text);
  const document = /\\documentclass/.test(text) ? text : wrapTikZDocument(snippet);
  return { document, snippet };
}

/**
 * 组装最终 .tex。
 * 引擎产物自带 preamble（完整版还要保留 pgfplots 的坐标轴环境），
 * 补齐图元时新增的 \\definecolor 需要插进 \\begin{document} 之后。
 */
export function assembleDocument(pgf: string, extraColorDefs: string[] = []): { document: string; snippet: string } {
  const text = pgf.trim();
  const snippet = extractTikzPicture(text);
  const defs = extraColorDefs.filter(Boolean);
  if (!defs.length) return { document: /\\documentclass/.test(text) ? text : wrapTikZDocument(snippet), snippet };

  if (/\\documentclass/.test(text)) {
    const marker = "\\begin{document}";
    const idx = text.indexOf(marker);
    const document =
      idx >= 0
        ? text.slice(0, idx + marker.length) + "\n" + defs.join("\n") + "\n" + text.slice(idx + marker.length)
        : text;
    return { document, snippet };
  }
  return { document: wrapTikZDocument(snippet, defs), snippet };
}

/**
 * 生成精简版 TikZ：去坐标轴/网格、去重复绘图、坐标取整，保留颜色与线型。
 * 输入是引擎原生 PGF。
 */
export function buildCompactTikZ(
  rawPgf: string,
  opts: { digits?: number } = {},
): { document: string; snippet: string; stats: CompactStats } {
  const digits = opts.digits ?? 2;
  const { body: noAxes, removed: removedAxes } = stripAxes(rawPgf);
  const { body: deduped, removed, total } = dedupeDraws(noAxes);
  const rounded = roundCoords(deduped, digits);

  // 颜色定义在 tikzpicture 之外，原样保留
  const colorDefs = [...rawPgf.matchAll(/\\definecolor\{[^}]+\}\{[^}]+\}\{[^}]+\}/g)].map((m) => m[0]);
  // 取 tikzpicture 的内容（连同它自己的选项块一起换掉）
  const picture = /\\begin\{tikzpicture\}(\[[\s\S]*?\])?([\s\S]*?)\\end\{tikzpicture\}/.exec(rounded);
  if (!picture) throw new Error("引擎产物里没有 tikzpicture，无法生成精简版");
  const inner = (picture[2] ?? "").trim();

  const snippet = [
    colorDefs.length ? colorDefs.join("\n") : "",
    "\\begin{tikzpicture}[line cap=round,line join=round,>=triangle 45,x=1cm,y=1cm]",
    inner,
    "\\end{tikzpicture}",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    document: wrapTikZDocument(snippet),
    snippet,
    stats: { removedDuplicates: removed, removedAxes, totalDraws: total },
  };
}

/* ------------------------------------------------------------------ *
 * 7. 快照降级生成器（引擎 PGF 不可用时的兜底）
 * ------------------------------------------------------------------ */

function toPgfExpression(expr: string): string | null {
  let e = expr.trim();
  if (!e) return null;
  // 去掉 `f(x) = ` 前缀
  const eq = /^[^=]*=\s*(.+)$/.exec(e);
  if (eq) e = eq[1];
  e = e.replace(/\s+/g, "").replace(/\bpi\b/g, "pi");
  // x^(2) → (\x)^(2)  （先处理带括号的幂，避免后续替换二次命中）
  e = e.replace(/\bx\s*\^\s*\(([^)]+)\)/g, "(\\x)^($1)");
  // 其余独立的 x → \x
  e = e.replace(/\bx\b/g, "\\x");
  // 上一步可能把已经转义好的 \x 变成 \\x，收敛一次
  e = e.replace(/\\\\x/g, "\\x");
  if (!/^[0-9+\-*/().\\x^a-z]+$/i.test(e.replace(/\\x/g, ""))) return null;
  return e;
}

/**
 * 降级 TikZ 生成器：引擎 exportPGF 不可用或超时时，用对象快照生成可编辑的 TikZ。
 * 依赖英文定义（由 XML 提供），因此线段/圆的端点能被正确解析。
 */
export function buildSnapshotTikZ(
  rawObjects: (GgbObjectInfo & { englishDef?: string })[],
  xml?: string,
): string {
  const objects = resolveDefs(rawObjects, xml);
  const byName = new Map(objects.map((o) => [o.name, o]));
  const pool = createColorPool();
  const body: string[] = [];
  const skipped: string[] = [];
  let drawn = 0;

  const pointOf = (name: string) => {
    const o = byName.get(name);
    return o && o.type === "point" ? o : null;
  };

  for (const o of objects) {
    if (!o.visible) continue;
    const def = o.englishDef || o.definition || "";
    const color = colorRef(pool, o.color);
    const width = o.lineThickness > 0 ? Math.min(6, o.lineThickness) / 2 : 0.6;
    // GeoGebra 线型：0 实线 / 1 虚线 / 2 点线 / 3 点划线
    const dash =
      o.lineStyle === 1 ? ",dashed" : o.lineStyle === 2 ? ",dotted" : o.lineStyle === 3 ? ",dash dot" : "";
    const style = `[color=${color},line width=${fmt(width)}pt${dash}]`;

    if (o.type === "point") {
      body.push(`\\draw[color=${color}] (${fmt(o.x)},${fmt(o.y)}) circle (${fmt(Math.max(1, o.pointSize) * 0.5)}pt);`);
      const label = o.caption || (o.labelVisible ? o.name : "");
      if (label) {
        body.push(
          `\\draw[color=${color}] (${fmt(o.x + 0.12)},${fmt(o.y + 0.12)}) node[anchor=south west] {\\footnotesize $${texEscape(label)}$};`,
        );
      }
      drawn++;
      continue;
    }

    if (o.type === "segment") {
      const refs = defRefs(def);
      const p = pointOf(refs[0]);
      const q = pointOf(refs[1]);
      if (!p || !q) {
        skipped.push(`${o.name}(segment)：无法确定端点`);
        continue;
      }
      body.push(`\\draw${style} (${fmt(p.x)},${fmt(p.y)}) -- (${fmt(q.x)},${fmt(q.y)});`);
      drawn++;
      continue;
    }

    if (o.type === "line" || o.type === "ray") {
      const refs = defRefs(def);
      const p = pointOf(refs[0]);
      const q = pointOf(refs[1]);
      if (!p || !q) {
        skipped.push(`${o.name}(${o.type})：无法确定端点`);
        continue;
      }
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const ext = 20 / len;
      let x1 = p.x;
      let y1 = p.y;
      let x2 = q.x;
      let y2 = q.y;
      if (o.type === "line") { x1 -= dx * ext; y1 -= dy * ext; }
      x2 += dx * ext; y2 += dy * ext;
      body.push(`\\draw${style} (${fmt(x1)},${fmt(y1)}) -- (${fmt(x2)},${fmt(y2)});`);
      drawn++;
      continue;
    }

    if (o.type === "polygon" || o.type === "polyline") {
      const pts = defRefs(def)
        .map(pointOf)
        .filter(Boolean) as (GgbObjectInfo & { englishDef?: string })[];
      if (pts.length < 3) {
        skipped.push(`${o.name}(${o.type})：顶点不足`);
        continue;
      }
      const coords = pts.map((p) => `(${fmt(p.x)},${fmt(p.y)})`).join(" -- ");
      const fill = o.filling > 0 ? `fill=${color}!20,` : "";
      body.push(
        `\\draw[${fill}color=${color},line width=${fmt(width)}pt] ${coords}${o.type === "polygon" ? " -- cycle" : ""};`,
      );
      drawn++;
      continue;
    }

    if (o.type === "circle" || o.type === "conic" || o.type === "semicircle" || o.type === "arc") {
      const m = /^Circle\s*[\[(]\s*([^,]+),\s*(.+?)\s*[\])]$/i.exec(def);
      if (m) {
        const center = pointOf(m[1].trim());
        let radius = Number(m[2]);
        if (!Number.isFinite(radius)) {
          const other = pointOf(m[2].trim());
          radius = other && center ? Math.hypot(other.x - center.x, other.y - center.y) : 0;
        }
        if (center && radius > 0) {
          body.push(`\\draw${style} (${fmt(center.x)},${fmt(center.y)}) circle (${fmt(radius)});`);
          drawn++;
          continue;
        }
      }
      skipped.push(`${o.name}(${o.type})：无法解析圆心/半径`);
      continue;
    }

    if (o.type === "function") {
      const expr = toPgfExpression(def || o.value);
      if (expr) {
        body.push(`\\draw${style} [smooth,samples=100,domain=-5:5] plot(\\x,{${expr}});`);
        drawn++;
        continue;
      }
      skipped.push(`${o.name}(function)：表达式无法转换`);
      continue;
    }

    if (o.type === "text") {
      const label = o.caption || o.value;
      if (label) {
        body.push(`\\node[color=${color},anchor=west] at (${fmt(o.x)},${fmt(o.y)}) {${texEscape(label)}};`);
        drawn++;
        continue;
      }
    }

    skipped.push(`${o.name}(${o.type || "unknown"})：暂不支持该类型`);
  }

  if (drawn === 0) throw new Error("画板上没有可转换为 TikZ 的对象");

  const head = [
    "% GeoChat 快照 TikZ 导出（GeoGebra 原生 exportPGF 不可用时的兜底）",
    "% 覆盖：点 / 线段 / 直线 / 射线 / 圆 / 多边形 / 函数 / 文本；函数默认 domain=-5:5。",
  ];
  if (skipped.length) head.push(`% 已跳过 ${skipped.length} 个对象：${skipped.slice(0, 8).join("；")}`);

  const picture = [
    ...head,
    "\\begin{tikzpicture}[line cap=round,line join=round,>=triangle 45,x=1cm,y=1cm]",
    ...body,
    "\\end{tikzpicture}",
  ].join("\n");

  return wrapTikZDocument(picture, pool.defs);
}
