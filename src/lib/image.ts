/**
 * 图片上传预处理（纯浏览器，零依赖）。
 *
 * EdgeOne Cloud Functions 的请求体上限是 6MB，而图片以 base64 嵌在 JSON 里会膨胀约 1/3，
 * 且多轮工具循环会重复携带消息。因此上传后统一在 canvas 里缩放 + JPEG 重编码，
 * 把单图控制在几百 KB，避免触发平台限制和不必要的 token/带宽开销。
 */

export interface PreparedImage {
  id: number;
  name: string;
  /** 发给模型的媒体类型，固定为 image/jpeg（重编码后）。 */
  mediaType: string;
  /** 纯 base64，可直接作为 AI SDK ImagePart.image。 */
  base64: string;
  /** 用于界面预览的 data URL。 */
  dataUrl: string;
  /** 压缩后的大致字节数。 */
  bytes: number;
}

export const MAX_IMAGES = 4;
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"];
const MAX_INPUT_BYTES = 12 * 1024 * 1024;
/** data URL 字符数上限，约对应 750KB 二进制。 */
const TARGET_DATA_URL_CHARS = 1_000_000;
const QUALITY_STEPS: Array<[number, number]> = [
  [1280, 0.82],
  [1024, 0.75],
  [800, 0.7],
  [640, 0.6],
];

let seq = 1;

export function isSupportedImage(file: File): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(file.type);
}

interface LoadedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function load(file: File): Promise<LoadedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
    } catch {
      /* 某些格式 createImageBitmap 不支持，回退到 Image */
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("图片解码失败"));
      img.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function render(loaded: LoadedImage, maxSide: number, quality: number): string {
  const scale = Math.min(1, maxSide / Math.max(loaded.width, loaded.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(loaded.width * scale));
  canvas.height = Math.max(1, Math.round(loaded.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 canvas 上下文");
  // JPEG 没有透明通道，先铺白底，避免透明区域变黑
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(loaded.source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

/** 校验、缩放、压缩一张图片，产出可直接发给视觉模型的 base64。 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!isSupportedImage(file)) {
    throw new Error(`不支持的图片格式：${file.type || "未知"}（仅支持 PNG / JPEG / WebP / GIF / BMP）`);
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error("单张图片不能超过 12MB");
  }

  const loaded = await load(file);
  try {
    let dataUrl = render(loaded, QUALITY_STEPS[0][0], QUALITY_STEPS[0][1]);
    for (const [maxSide, quality] of QUALITY_STEPS.slice(1)) {
      if (dataUrl.length <= TARGET_DATA_URL_CHARS) break;
      dataUrl = render(loaded, maxSide, quality);
    }
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return {
      id: seq++,
      name: file.name || "图片",
      mediaType: "image/jpeg",
      base64,
      dataUrl,
      bytes: Math.floor(base64.length * 3 / 4),
    };
  } finally {
    loaded.release();
  }
}
