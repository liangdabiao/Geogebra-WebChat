/**
 * 文件导出工具（纯浏览器，零依赖）。
 * 负责：base64 → Blob → 下载、.ggb 文件读取、TikZ 文本规整，
 * 以及 GeoGebra 原生 exportPGF 不可用时的 TikZ 降级生成器。
 */
import type { GgbObjectInfo } from "../geogebra";

/** 形如 geochat-20261106-0035.ggb 的文件名。 */
export function timestampName(ext: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `geochat-${stamp}.${ext.replace(/^\./, "")}`;
}

/** 纯 base64（或 data URL）→ ArrayBuffer。 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const clean = base64.includes("base64,") ? base64.slice(base64.indexOf("base64,") + 7) : base64;
  const bin = atob(clean.replace(/\s/g, ""));
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadBase64(base64: string, mime: string, filename: string): void {
  downloadBlob(new Blob([base64ToArrayBuffer(base64)], { type: mime }), filename);
}

export function downloadText(text: string, filename: string, mime = "text/plain;charset=utf-8"): void {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

/** 读取本地文件为纯 base64（用于「打开 .ggb」）。 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? "");
      const i = s.indexOf("base64,");
      resolve(i >= 0 ? s.slice(i + 7) : s);
    };
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface TikZParts {
  /** 可直接编译的完整 LaTeX 文档。 */
  document: string;
  /** 可粘贴进现有文档的 tikzpicture 片段。 */
  snippet: string;
}

/** 把 GeoGebra 的 PGF/TikZ 输出规整成「完整文档 + 片段」两种形态。 */
export function normalizeTikZ(raw: string): TikZParts {
  const text = raw.trim();
  const m = /\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/.exec(text);
  const snippet = m ? m[0] : text;
  const document = /\\documentclass/.test(text) ? text : wrapTikZDocument(snippet);
  return { document, snippet };
}

export function wrapTikZDocument(snippet: string): string {
  return [
    "\\documentclass[10pt]{article}",
    "\\usepackage{pgf,tikz}",
    "\\usepackage{mathrsfs}",
    "\\usetikzlibrary{arrows}",
    "\\pagestyle{empty}",
    "\\begin{document}",
    snippet,
    "\\end{document}",
    "",
  ].join("\n");
}

const num = (v: number): string => {
  if (!Number.isFinite(v)) return "0";
  const s = v.toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

/** 转义 LaTeX 特殊字符（用于标签 / 文本节点）。 */
function texEscape(s: string): string {
  return s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&$#%_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

/** 从 Segment(A,B) / Polygon(A,B,C) 之类定义里取出点对象。 */
function referencedPoints(def: string, byName: Map<string, GgbObjectInfo>): GgbObjectInfo[] {
  const names = def.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? [];
  const seen = new Set<string>();
  const out: GgbObjectInfo[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    const o = byName.get(n);
    if (o && o.type === "point") out.push(o);
  }
  return out;
}

/** GeoGebra 函数表达式 → pgf math 表达式。返回 null 表示无法安全转换。 */
function toPgfExpression(expr: string): string | null {
  let e = expr.trim();
  if (!e || /[\\{}]/.test(e)) return null;
  const eq = /=\s*(.+)$/.exec(e);
  if (eq) e = eq[1];
  e = e.replace(/\s+/g, "").replace(/\bpi\b/g, "pi").replace(/\bx\b/g, "\\x");
  // 只保留 pgf math 能处理的字符
  if (!/^[0-9+\-*/().\\x^a-z]+$/i.test(e.replace(/\\x/g, ""))) return null;
  return e;
}

/**
 * 降级 TikZ 生成器：exportPGF 不可用或超时时，用对象快照生成可编辑的 TikZ。
 * 覆盖点、线段、直线/射线、圆、多边形、函数曲线、文本；其余类型在注释里列出并跳过。
 * 没有任何可绘制对象时抛错，由上层继续降级到 SVG。
 */
export function buildTikZFallback(objects: GgbObjectInfo[]): string {
  const byName = new Map(objects.map((o) => [o.name, o]));
  const colorDefs: string[] = [];
  const colorMap = new Map<string, string>();
  const colorRef = (hex: string): string => {
    const h = (hex || "").trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(h)) return "black";
    let ref = colorMap.get(h.toUpperCase());
    if (!ref) {
      ref = `ggbc${colorMap.size}`;
      colorMap.set(h.toUpperCase(), ref);
      colorDefs.push(`\\definecolor{${ref}}{HTML}{${h.slice(1).toUpperCase()}}`);
    }
    return ref;
  };

  const body: string[] = [];
  const skipped: string[] = [];
  let drawn = 0;

  for (const o of objects) {
    if (!o.visible) continue;
    const color = colorRef(o.color);
    const width = o.lineThickness > 0 ? Math.min(6, o.lineThickness) / 2 : 0.6;
    const style = `[color=${color},line width=${num(width)}pt]`;
    const type = o.type;
    const def = o.definition || o.value;

    if (type === "point") {
      body.push(`\\draw[color=${color}] (${num(o.x)},${num(o.y)}) circle (${num(Math.max(1, o.pointSize) * 0.5)}pt);`);
      const label = o.caption || (o.labelVisible ? o.name : "");
      if (label) {
        body.push(`\\draw[color=${color}] (${num(o.x + 0.12)},${num(o.y + 0.12)}) node[anchor=south west] {\\footnotesize $${texEscape(label)}$};`);
      }
      drawn++;
      continue;
    }

    if (type === "segment" || type === "line" || type === "ray" || type === "vector") {
      const pts = referencedPoints(def, byName);
      if (pts.length < 2) {
        skipped.push(`${o.name}(${type || "unknown"})：无法确定端点`);
        continue;
      }
      const [p, q] = pts;
      let x1 = p.x, y1 = p.y, x2 = q.x, y2 = q.y;
      if (type === "line" || type === "ray") {
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const ext = 20 / len;
        if (type === "line") { x1 -= dx * ext; y1 -= dy * ext; }
        x2 += dx * ext; y2 += dy * ext;
      }
      body.push(`\\draw${style} (${num(x1)},${num(y1)}) -- (${num(x2)},${num(y2)});`);
      drawn++;
      continue;
    }

    if (type === "polygon" || type === "polyline") {
      const pts = referencedPoints(def, byName);
      if (pts.length < 3) {
        skipped.push(`${o.name}(${type})：顶点不足`);
        continue;
      }
      const coords = pts.map((p) => `(${num(p.x)},${num(p.y)})`).join(" -- ");
      const fill = o.filling > 0 ? `fill=${color}!20,` : "";
      body.push(`\\draw[${fill}color=${color},line width=${num(width)}pt] ${coords}${type === "polygon" ? " -- cycle" : ""};`);
      drawn++;
      continue;
    }

    if (type === "circle" || type === "semicircle" || type === "arc") {
      // getDefinitionString(name, false) 在非本地化模式下可能用方括号：Circle[A, 2]
      const m = /Circle\s*[\[(]\s*([A-Za-z][A-Za-z0-9_]*)\s*,\s*([^\])]+)[\])]/i.exec(def);
      if (m) {
        const center = byName.get(m[1]);
        const arg = m[2].trim();
        let radius = Number(arg);
        if (!Number.isFinite(radius)) {
          const other = byName.get(arg);
          radius = other && center ? Math.hypot(other.x - center.x, other.y - center.y) : 0;
        }
        if (center && radius > 0) {
          body.push(`\\draw${style} (${num(center.x)},${num(center.y)}) circle (${num(radius)});`);
          drawn++;
          continue;
        }
      }
      skipped.push(`${o.name}(${type})：无法解析圆心/半径`);
      continue;
    }

    if (type === "function" || type === "curve" || type === "parametriccurve") {
      const expr = toPgfExpression(o.value || o.definition);
      if (expr) {
        body.push(`\\draw${style} [smooth,samples=100,domain=-5:5] plot(\\x,{${expr}});`);
        drawn++;
        continue;
      }
      skipped.push(`${o.name}(${type})：表达式无法转换`);
      continue;
    }

    if (type === "text") {
      const label = o.caption || o.value;
      if (label) {
        body.push(`\\node[color=${color},anchor=west] at (${num(o.x)},${num(o.y)}) {${texEscape(label)}};`);
        drawn++;
        continue;
      }
    }

    skipped.push(`${o.name}(${type || "unknown"})：暂不支持该类型`);
  }

  if (drawn === 0) {
    throw new Error("画板上没有可转换为 TikZ 的对象");
  }

  const head = [
    "% GeoChat 降级 TikZ 导出（GeoGebra 原生 exportPGF 不可用）",
    "% 覆盖：点 / 线段 / 直线 / 射线 / 圆 / 多边形 / 函数 / 文本；函数默认 domain=-5:5，可按需调整。",
  ];
  if (skipped.length) head.push(`% 已跳过 ${skipped.length} 个对象：${skipped.slice(0, 8).join("；")}`);

  const picture = [
    ...head,
    "\\begin{tikzpicture}[line cap=round,line join=round,>=triangle 45,x=1.0cm,y=1.0cm]",
    ...body,
    "\\end{tikzpicture}",
  ].join("\n");

  const preamble = [
    "\\documentclass[10pt]{article}",
    "\\usepackage{pgf,tikz}",
    "\\usepackage{mathrsfs}",
    "\\usetikzlibrary{arrows}",
    "\\pagestyle{empty}",
    "\\begin{document}",
    ...colorDefs,
    picture,
    "\\end{document}",
    "",
  ].join("\n");

  return preamble;
}
