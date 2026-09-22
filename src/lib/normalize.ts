/**
 * 极简 GeoGebra 命令规范化。
 * 容忍大模型输出的中文别名 / 简写，统一成 GeoGebra 5 兼容命令。
 * （从 @geochat-ai/app 的 geogebra-command-normalization 精简而来）
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

/**
 * 规整一批 GeoGebra 命令。
 * - 去空白、去空行
 * - 中文别名 → 英文命令
 * - SetOpacity → SetFilling
 */
export function normalizeGeoGebraCommands(commands: string[]): string[] {
  const out: string[] = [];
  for (const raw of commands) {
    let c = (raw ?? "").trim();
    if (!c) continue;
    c = applyAlias(c);
    c = c.replace(/^SetOpacity\b/, "SetFilling");
    out.push(c);
  }
  return out;
}
