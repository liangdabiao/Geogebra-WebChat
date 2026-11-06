/**
 * .ggb 文件兼容性处理。
 *
 * .ggb 本质是 ZIP。GeoGebra 网页 applet 的 getBase64() 产物是合法 ZIP，
 * 但不含 geogebra_thumbnail.png，而桌面版自己保存的 .ggb 都带这张缩略图，
 * 部分桌面版在读取预览图时会因此打开失败。
 *
 * 这里在不解压、不改动原有任何条目的前提下，往 central directory 之前追加一个
 * STORE 条目把缩略图补上。所有处理都有回退：异常时上层直接使用原始字节。
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function findEocd(view: DataView, length: number): number {
  // EOCD 固定 22 字节，末尾最多 65535 字节注释
  const from = Math.max(0, length - 22 - 0xffff);
  for (let i = length - 22; i >= from; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

/** 判断 ZIP 里是否已存在某个文件名（只看 central directory 的字节）。 */
function zipHasEntry(bytes: Uint8Array, name: string): boolean {
  const needle = new TextEncoder().encode(name);
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * 往现有 ZIP 追加一个不压缩（STORE）的条目，返回新的 ArrayBuffer。
 * 原条目（含 DEFLATE 压缩数据）原样保留，只重写 central directory 与 EOCD。
 */
export function appendZipEntry(buffer: ArrayBuffer, name: string, data: Uint8Array): ArrayBuffer {
  const src = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocd = findEocd(view, src.length);
  if (eocd < 0 || view.getUint32(0, true) !== SIG_LOCAL) throw new Error("不是有效的 ZIP 文件");

  const cdOffset = view.getUint32(eocd + 16, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const entryCount = view.getUint16(eocd + 10, true);
  if (cdOffset + cdSize > src.length || view.getUint32(cdOffset, true) !== SIG_CENTRAL) {
    throw new Error("ZIP 目录结构异常");
  }
  if (zipHasEntry(src, name)) return buffer;

  const nameBytes = new TextEncoder().encode(name);
  const crc = crc32(data);
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  // Local file header（30 字节 + 文件名）
  const local = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, SIG_LOCAL, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(6, 0, true); // flags
  lv.setUint16(8, 0, true); // method = STORE
  lv.setUint16(10, dosTime, true);
  lv.setUint16(12, dosDate, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nameBytes.length, true);
  lv.setUint16(28, 0, true); // extra length
  local.set(nameBytes, 30);

  // Central directory header（46 字节 + 文件名）
  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, SIG_CENTRAL, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(8, 0, true);
  cv.setUint16(10, 0, true);
  cv.setUint16(12, dosTime, true);
  cv.setUint16(14, dosDate, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, cdOffset, true); // 新 local header 的偏移
  central.set(nameBytes, 46);

  const newCdOffset = cdOffset + local.length + data.length;

  // End of central directory
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, entryCount + 1, true);
  ev.setUint16(10, entryCount + 1, true);
  ev.setUint32(12, cdSize + central.length, true);
  ev.setUint32(16, newCdOffset, true);

  const out = new Uint8Array(newCdOffset + cdSize + central.length + end.length);
  out.set(src.subarray(0, cdOffset), 0); // 原 local headers + 数据
  out.set(local, cdOffset);
  out.set(data, cdOffset + local.length);
  out.set(src.subarray(cdOffset, cdOffset + cdSize), newCdOffset); // 原 central directory
  out.set(central, newCdOffset + cdSize);
  out.set(end, newCdOffset + cdSize + central.length);
  return out.buffer;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.includes("base64,") ? base64.slice(base64.indexOf("base64,") + 7) : base64;
  const bin = atob(clean.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

/** 是否为 ZIP（.ggb）文件头。 */
export function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}
