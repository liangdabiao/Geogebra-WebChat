/**
 * 文件导出工具（纯浏览器，零依赖）。
 * 负责：base64 → Blob → 下载、.ggb 文件读取、剪贴板复制。
 * TikZ 的生成 / 清洗 / 覆盖校验已移到 ./tikz.ts（需要构造 XML 与几何校验）。
 */
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
  // 优先用异步剪贴板 API；iframe、无用户手势、部分浏览器会拒绝，
  // 这时退回临时 textarea + execCommand，保证「复制原文 / 复制 TikZ」始终可用。
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 走降级 */
  }
  let ta: HTMLTextAreaElement | undefined;
  try {
    ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta?.remove();
  }
}
