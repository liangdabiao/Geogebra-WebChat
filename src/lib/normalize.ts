/**
 * GeoGebra 命令规范化。
 * 容忍大模型输出的中文别名 / LaTeX / 全角标点 / 复合命令，统一成 GeoGebra 5 兼容的单条命令。
 * 背景：模型常输出 `ph = \frac{\pi}{4}` 这类 LaTeX，evalCommand 会静默失败，
 * 后续命令引用 ph 时 GeoGebra 报「未定义变量 ph」。
 */

const ALIAS: Record<string, string> = {
  // 多字别名（需排在单字前避免前缀误匹配）
  设置颜色: "SetColor",
  设置填充: "SetFilling",
  设置不透明度: "SetFilling",
  设置线宽: "SetLineThickness",
  设置线型: "SetLineStyle",
  设置定点: "SetFixed",
  设置标签模式: "SetLabelMode",
  显示标签: "ShowLabel",
  隐藏标签: "ShowLabel",
  设置标签: "SetCaption",
  球面: "Sphere",
  描点: "Point",
  角平分线: "AngleBisector",
  平行线: "ParallelLine",
  抛物线: "Parabola",
  双曲线: "Hyperbola",
  // 单字别名
  点: "Point",
  直线: "Line",
  射线: "Ray",
  线段: "Segment",
  圆: "Circle",
  半圆: "Semicircle",
  弧: "Arc",
  多边形: "Polygon",
  棱锥: "Pyramid",
  棱柱: "Prism",
  圆柱: "Cylinder",
  圆锥: "Cone",
  球: "Sphere",
  中点: "Midpoint",
  交点: "Intersect",
  垂线: "PerpendicularLine",
  切线: "Tangent",
  椭圆: "Ellipse",
};

/** 按 prefix 长度降序排列，确保 `球面` 优先于 `球` 匹配。 */
const ALIAS_ENTRIES = Object.entries(ALIAS).sort((a, b) => b[0].length - a[0].length);

/** 把单条命令里的中文别名前缀替换为英文命令。 */
function applyAlias(c: string): string {
  for (const [zh, en] of ALIAS_ENTRIES) {
    if (c.startsWith(zh)) return en + c.slice(zh.length);
  }
  return c;
}

/** 全角标点 → 半角（模型输出中文时常见）。 */
const FULLWIDTH: Record<string, string> = {
  "（": "(", "）": ")", "，": ",", "；": ";", "：": ":",
  "＝": "=", "＋": "+", "－": "-", "＊": "*", "／": "/",
  "［": "[", "］": "]", "｛": "{", "｝": "}", "　": " ",
};
function toHalfwidth(c: string): string {
  return c.replace(/[（），；：＝＋－＊／［］｛｝　]/g, (ch) => FULLWIDTH[ch] ?? ch);
}

/** 找到 openIdx 处 `{` 的配对 `}` 下标，找不到返回 -1。 */
function matchBrace(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `\frac{a}{b}` / `\dfrac` / `\tfrac` → `((a)/(b))`，支持嵌套。 */
function convertFrac(c: string): string {
  for (let guard = 0; guard < 20; guard++) {
    const m = /\\[dt]?frac\s*\{/.exec(c);
    if (!m || m.index === undefined) break;
    const openIdx = m.index + m[0].length - 1;
    const numEnd = matchBrace(c, openIdx);
    if (numEnd < 0) break;
    const dm = /^\s*\{/.exec(c.slice(numEnd + 1));
    if (!dm) break;
    const denOpen = numEnd + 1 + dm.index + dm[0].length - 1;
    const denEnd = matchBrace(c, denOpen);
    if (denEnd < 0) break;
    const num = c.slice(openIdx + 1, numEnd);
    const den = c.slice(denOpen + 1, denEnd);
    c = c.slice(0, m.index) + `((${num})/(${den}))` + c.slice(denEnd + 1);
  }
  return c;
}

/** LaTeX 希腊字母 → GeoGebra 可识别的 Unicode / 内置名。 */
const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
  theta: "θ", lambda: "λ", mu: "μ", omega: "ω", phi: "φ", varphi: "φ",
  psi: "ψ", rho: "ρ", sigma: "σ", pi: "pi",
};

/** 把命令里的 LaTeX 片段转成 GeoGebra 语法。 */
function convertLatex(c: string): string {
  c = convertFrac(c);
  c = c.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, "($2)^(1/($1))");
  c = c.replace(/\\sqrt\s*\{([^{}]*)\}/g, "sqrt($1)");
  c = c.replace(/\\operatorname\s*\{([^{}]*)\}/g, "$1");
  c = c.replace(/\\text\s*\{([^{}]*)\}/g, "$1");
  c = c.replace(/\\left|\\right/g, "");
  c = c.replace(/\\[,;!:> ]|\\quad|\\qquad/g, "");
  c = c.replace(/\^\s*\\circ|\^\s*\{\\circ\}|\\degree/g, "°");
  c = c.replace(/\\(alpha|beta|gamma|delta|epsilon|theta|lambda|mu|omega|varphi|phi|psi|rho|sigma|pi)\b/g, (_, name) => GREEK[name] ?? name);
  c = c.replace(/\\cdot|\\times/g, "*");
  c = c.replace(/\\div/g, "/");
  c = c.replace(/\^\s*\{([^{}]*)\}/g, "^($1)");
  c = c.replace(/_\s*\{([^{}]*)\}/g, "_$1");
  // 清理残留的反斜杠命令包裹符 $...$ / $$...$$
  c = c.replace(/^\$+|\$+$/g, "");
  return c;
}

/**
 * 规整一批 GeoGebra 命令。
 * - 全角标点 → 半角；LaTeX → GeoGebra 语法
 * - 按分号 / 换行拆分为独立命令（分号复合命令在 evalCommand 中会静默丢失后半段）
 * - 中文别名 → 英文命令
 * - SetOpacity → SetFilling
 */
export function normalizeGeoGebraCommands(commands: string[]): string[] {
  const out: string[] = [];
  for (const raw of commands) {
    let c = (raw ?? "").trim();
    if (!c) continue;
    c = toHalfwidth(c);
    c = convertLatex(c);
    // 拆分复合命令：换行与分号都视为分隔符
    for (let piece of c.split(/[\n;]/)) {
      piece = piece.trim();
      if (!piece) continue;
      piece = applyAlias(piece);
      piece = piece.replace(/^SetOpacity\b/, "SetFilling");
      out.push(piece);
    }
  }
  return out;
}
