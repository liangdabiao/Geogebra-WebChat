/**
 * GeoGebra 画板控制器。
 * 通过本地 vendor 的 deployggb.js 注入 GGBApplet，提供命令执行 / 视角切换 / 清空 / 读 XML，
 * 以及文件导出（.ggb / TikZ / SVG / PNG）与 .ggb 打开能力。
 *
 * 本项目自带 GeoGebra 5.0 web3d 构建（/geogebra/HTML5/5.0/web3d/）。
 * 该构建暴露了 getBase64()（返回 base64 编码的标准 .ggb）、exportPGF(callback)、
 * exportSVG(callback)、getPNGBase64()、setBase64() 等 API；其中 exportPGF 未写入官方文档，
 * 因此所有调用都做能力检测 + 超时 + 由上层降级处理，不能假定一定可用。
 */

import { appendZipEntry, base64ToBytes, bytesToBase64, isZipBytes } from "./lib/ggb";
import { parseConstructionXml } from "./lib/tikz";

declare global {
  interface Window {
    GGBApplet?: any;
  }
}

const DEPLOY_URL = "/geogebra/deployggb.js";
const HTML5_CODEBASE = "/geogebra/HTML5/5.0/web3d/";

export interface ExecuteOptions {
  perspective?: string;
  resetBefore?: boolean;
  restoreOnError?: boolean;
}

export interface ExecuteResult {
  ok: boolean;
  failed: string[];
}

/** 画板导出能力探测结果。 */
export interface ExportCapabilities {
  ggb: boolean;
  tikz: boolean;
  svg: boolean;
  png: boolean;
  openGgb: boolean;
  version: string;
}

/** 供 TikZ 生成与覆盖校验使用的对象快照。 */
export interface GgbObjectInfo {
  name: string;
  type: string;
  x: number;
  y: number;
  z: number;
  value: string;
  definition: string;
  /** 英文定义（来自构造 XML）。applet 的 definition 是本地化的，中文环境下是「线段AB」。 */
  englishDef: string;
  color: string;
  visible: boolean;
  lineThickness: number;
  /** 线型：0 实线 / 1 虚线 / 2 点线 / 3 点划线 */
  lineStyle: number;
  pointSize: number;
  filling: number;
  caption: string;
  labelVisible: boolean;
}

export interface ExecuteResult {
  ok: boolean;
  failed: string[];
  /** 为避免同名覆盖而自动重命名的对象，格式 `旧名 → 新名`。 */
  renamed: string[];
  /** 批次中定义、但此前已存在的对象名（模型有意覆盖）。 */
  overwritten: string[];
}

export interface GeoGebraController {
  isReady: () => boolean;
  ready: () => Promise<void>;
  executeCommands: (commands: string[], opts?: ExecuteOptions) => Promise<ExecuteResult>;
  setPerspective: (mode: string) => Promise<void>;
  reset: () => Promise<void>;
  getXML: () => string;
  /** base64 编码的标准 .ggb 文件（不含 data URL 前缀）。 */
  getGgbBase64: () => Promise<string>;
  /** 载入 base64 编码的 .ggb 文件。 */
  openGgbBase64: (base64: string) => Promise<void>;
  /** GeoGebra 原生 PGF/TikZ 导出（未公开 API，可能失败）。 */
  exportTikZ: () => Promise<string>;
  exportSVG: () => Promise<string>;
  /** base64 编码的 PNG。 */
  exportPNGBase64: () => Promise<string>;
  getVersion: () => string;
  capabilities: () => ExportCapabilities;
  inspectObjects: () => GgbObjectInfo[];
  /** 按容器当前尺寸强制重设 applet 画布（窗口缩放 / 分栏拖动后调用）。 */
  resize: () => void;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let deployPromise: Promise<void> | null = null;
function loadDeployScript(): Promise<void> {
  if (deployPromise) return deployPromise;
  deployPromise = new Promise<void>((resolve, reject) => {
    if (window.GGBApplet) return resolve();
    const s = document.createElement("script");
    s.src = DEPLOY_URL;
    s.async = true;
    s.onload = () => (window.GGBApplet ? resolve() : reject(new Error("GeoGebra 脚本加载后未暴露 GGBApplet")));
    s.onerror = () => reject(new Error("加载 deployggb.js 失败（检查网络）"));
    document.head.appendChild(s);
  });
  return deployPromise;
}

/** 去掉可能存在的 data URL 前缀，只留纯 base64。 */
function stripDataUrl(s: string): string {
  const i = s.indexOf("base64,");
  return i >= 0 ? s.slice(i + 7) : s;
}

/**
 * 脚本 / 样式类命令。
 * 实测：GeoGebra 的 evalCommand 对这类命令返回 **false**，但副作用完全生效
 * （SetLineStyle 让 getLineStyle 从 0 变 1、SetColor 改了颜色、SetLineThickness 改了线宽）。
 * 早期版本把它们当成「执行失败」，进而触发整板回滚 —— 一条样式命令就能让画板变空。
 */
const SCRIPT_COMMAND =
  /^(Set|Show|Hide|Delete|Rename|Toggle|Zoom|Center|Move|Pan|Play|Pause|Start|Stop|Clear|Select|Unselect|Redraw|Animation|LabelColor|LabelPosition|CopyToClipboard|PasteFromClipboard|ExportToClipboard|SetActiveView|SetConstructionStep)\b/i;

/**
 * GeoGebra 自动分配给无名对象的标签池：单个小写字母（f、g、h…），
 * 占用后再用 `c_1`、`c_2` 这类形式。
 * 模型若用同一个名字定义函数，会静默顶掉那条自动命名的线段。
 */
const AUTO_LABEL = /^[a-z](_\d+)?$/;

/**
 * 改名让路时使用的新标签。
 * 必须避开 GeoGebra 的**函数名空间**（f、g、h… 以及 f1、g1 这类形式）：
 * 实测把线段改名为 `f1` 会被 GeoGebra 当成函数名，线段直接变成 text 对象而消失。
 */
const RENAME_PREFIX = "ggbauto";

/** 从命令里取出它会定义的对象名：`A=(0,0)` → A，`f(x)=x^2` → f。 */
function definedObjectName(cmd: string): string | null {
  const m = /^\s*([^\s(=<>]+)\s*(\([^)]*\))?\s*=/.exec(cmd);
  return m ? m[1] : null;
}

/**
 * 执行一条命令并判断是否真的失败。
 * 不能只看 evalCommand 的布尔返回值——脚本命令恒为 false 却有效。
 */
function runCommand(api: any, cmd: string): boolean {
  let ret: unknown;
  try {
    ret = api.evalCommand(cmd);
  } catch {
    return false;
  }
  if (ret === true) return true;
  // 脚本 / 样式命令：返回 false 是 GeoGebra 的正常语义，副作用已生效
  if (SCRIPT_COMMAND.test(cmd)) return true;
  // 赋值命令：返回 false 但对象已存在，说明只是返回语义问题
  const name = definedObjectName(cmd);
  if (name && typeof api.getAllObjectNames === "function") {
    try {
      return Array.from(api.getAllObjectNames() as Iterable<unknown>).some((n) => String(n) === name);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 安全改名。
 *
 * 实测（本项目在 GeoGebra 5.0 web3d 上逐个验证）：
 *   - `Rename("s","x")`  → **错**：引号让 GeoGebra 把 "s" 当字符串字面量，
 *     结果新建了一个 text 对象，原线段原封不动还在。
 *   - `Rename(s,"x")`    → 对，但依赖命令解析。
 *   - `api.renameObject("s","x")` → 对，且最直接，优先用它。
 * 每次都回读对象列表校验改名是否真的生效。
 */
function renameObjectSafe(api: any, from: string, to: string): boolean {
  const namesNow = (): string[] => {
    try {
      return Array.from(api.getAllObjectNames() as Iterable<unknown>).map(String);
    } catch {
      return [];
    }
  };
  const ok = () => {
    const names = namesNow();
    return names.includes(to) && !names.includes(from);
  };
  try {
    if (typeof api.renameObject === "function") {
      api.renameObject(from, to);
      if (ok()) return true;
    }
  } catch {
    /* 试命令形式 */
  }
  try {
    // 对象名不加引号，加引号会被当成字符串
    api.evalCommand(`Rename(${from},"${to}")`);
    if (ok()) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 同名覆盖保护。
 *
 * GeoGebra 给无名对象自动分配单字母标签（Segment(A,B) → f，多边形的边 → a、b、c_1）。
 * 模型几乎必然会输出 `f(x)=…` 这类函数定义，于是**函数会静默顶掉那条线段**——
 * 画面上少一条线，导出时才发现，正是「图形莫名消失」的根因。
 *
 * 策略：在执行**每一条**命令之前检查它要定义的名字。
 *  - 若该名字已被一个「自动标签」占用 → 先把旧对象改名让路（样式、依赖关系都保留）；
 *  - 若被一个显式命名的对象占用 → 允许覆盖（那是模型的有意行为），只做记录。
 *
 * 必须是逐条检查而不是整批检查：冲突常常发生在同一批命令内部
 * （先 `Segment(A,B)` 自动得到 f，后面 `f(x)=…` 就撞上了）。
 */
function protectNameBeforeCommand(api: any, cmd: string): { renamed: string[]; overwritten: string[] } {
  const renamed: string[] = [];
  const overwritten: string[] = [];
  const name = definedObjectName(cmd);
  if (!name) return { renamed, overwritten };
  if (typeof api?.getAllObjectNames !== "function") return { renamed, overwritten };

  let existing: string[];
  try {
    existing = Array.from(api.getAllObjectNames() as Iterable<unknown>).map(String);
  } catch {
    return { renamed, overwritten };
  }
  if (!existing.includes(name)) return { renamed, overwritten };

  if (!AUTO_LABEL.test(name)) {
    overwritten.push(name);
    return { renamed, overwritten };
  }

  // 找一个空闲标签（避开函数名空间）
  const taken = new Set(existing);
  let candidate = `${RENAME_PREFIX}1`;
  let i = 1;
  while (taken.has(candidate)) {
    i++;
    candidate = `${RENAME_PREFIX}${i}`;
  }
  if (renameObjectSafe(api, name, candidate)) {
    renamed.push(`${name} → ${candidate}`);
  }
  return { renamed, overwritten };
}

async function clearAll(api: any): Promise<void> {
  if (!api) return;
  try {
    const names: string[] = api.getAllObjectNames ? Array.from(api.getAllObjectNames()) : [];
    for (const n of names) {
      try {
        api.deleteObject(n);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

async function applyPerspective(api: any, mode: string): Promise<void> {
  if (!api) return;
  try {
    if (typeof api.setPerspective === "function") {
      api.setPerspective(mode);
      return;
    }
  } catch {
    /* fallthrough */
  }
  try {
    if (typeof api.evalCommand === "function") api.evalCommand(`SetPerspective("${mode}")`);
  } catch {
    /* ignore */
  }
}

/**
 * 调用「以回调函数交付字符串」的 GeoGebra API。
 * 这类方法（exportPGF / exportSVG / getBase64 / getScreenshotBase64）在不同版本里
 * 可能是同步返回，也可能是异步回调，甚至静默不回调，因此统一加超时。
 */
function callStringApi(api: any, method: string, timeoutMs = 10_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (typeof api?.[method] !== "function") {
      reject(new Error(`画板不支持 ${method}`));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${method} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof value === "string" && value.trim().length > 0) resolve(value);
      else reject(new Error(`${method} 未返回内容`));
    };
    try {
      api[method](finish);
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

function safeString(fn: () => unknown): string {
  try {
    const v = fn();
    return v == null ? "" : String(v);
  } catch {
    return "";
  }
}

function safeNumber(fn: () => unknown): number {
  try {
    const v = Number(fn());
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** 挂载 GeoGebra 画板到指定容器 id，返回控制器。 */
export async function mountGeoGebra(containerId: string): Promise<GeoGebraController> {
  await loadDeployScript();
  const container = document.getElementById(containerId);
  if (!container) throw new Error(`找不到容器 #${containerId}`);

  const width = container.clientWidth || 640;
  const height = container.clientHeight || 480;

  let api: any = null;
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("GeoGebra 画板加载超时")), 60_000);
    const applet = new window.GGBApplet(
      {
        appName: "classic",
        width,
        height,
        showMenuBar: false,
        showAlgebraInput: true,
        showToolBar: false,
        showResetIcon: true,
        enableRightClick: true,
        enableShiftDragZoom: true,
        showFullscreenButton: true,
        perspective: "AG",
        appletOnLoad: (a: any) => {
          api = a;
          clearTimeout(timeout);
          resolve();
        },
      },
      true,
    );
    applet.setHTML5Codebase(HTML5_CODEBASE);
    applet.inject(containerId);
  });

  await ready;

  // GeoGebra 注入时按容器「当时」的像素宽高创建 canvas，之后不会自动跟随容器。
  // 窗口缩放、顶栏/导出按钮折行、提示条出现或左右分栏拖动都会改变容器尺寸，
  // 旧 canvas 保持不变就会溢出并盖住聊天区。这里把 applet 尺寸与容器实时同步。
  let lastW = width;
  let lastH = height;
  let syncing = false;
  const syncSize = (w: number, h: number, force = false) => {
    if (syncing || w < 1 || h < 1) return;
    if (!force && w === lastW && h === lastH) return;
    syncing = true;
    lastW = w;
    lastH = h;
    try {
      // setSize 会顺手给容器写 inline 宽高，但 CSS 里 .ggb-container 的
      // width:100% !important 会压住它，容器始终等于面板宽度；
      // 这里只借用 setSize 让 GeoGebra 内部视图按新尺寸重算。
      container.style.removeProperty("width");
      container.style.removeProperty("height");
      if (typeof api?.setSize === "function") api.setSize(w, h);
      else if (typeof api?.recalculateEnvironments === "function") api.recalculateEnvironments();
      window.dispatchEvent(new Event("resize"));
    } catch {
      /* ignore */
    } finally {
      syncing = false;
    }
  };
  const onContainerResize = () => syncSize(container.clientWidth, container.clientHeight);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(onContainerResize).observe(container);
  }
  window.addEventListener("resize", onContainerResize);

  const has = (name: string) => typeof api?.[name] === "function";
  const getVersion = () => (has("getVersion") ? safeString(() => api.getVersion()) : "unknown");

  /** 遍历画板对象，取几何与样式信息，供 TikZ 生成与覆盖校验使用。 */
  const inspectObjects = (): GgbObjectInfo[] => {
    if (!has("getAllObjectNames")) return [];
    let names: string[] = [];
    try {
      names = Array.from(api.getAllObjectNames()).map(String);
    } catch {
      return [];
    }
    // applet 的 getDefinitionString / getCommandString 返回本地化字符串
    // （中文环境下是「线段AB」「圆周(C, 1.5)」），只有构造 XML 里是英文。
    let xmlDefs = new Map<string, string>();
    try {
      const parsed = parseConstructionXml(api.getXML());
      xmlDefs = new Map([...parsed.entries()].map(([k, v]) => [k, v.def]));
    } catch {
      /* ignore */
    }
    return names.map((name) => {
      const xmlDef = xmlDefs.get(name);
      const type = has("getObjectType")
        ? safeString(() => api.getObjectType(name)).toLowerCase()
        : "";
      return {
        name,
        type: type || (xmlDef ? "" : ""),
        x: has("getXcoord") ? safeNumber(() => api.getXcoord(name)) : 0,
        y: has("getYcoord") ? safeNumber(() => api.getYcoord(name)) : 0,
        z: has("getZcoord") ? safeNumber(() => api.getZcoord(name)) : 0,
        value: has("getValueString") ? safeString(() => api.getValueString(name, false)) : "",
        definition: has("getDefinitionString") ? safeString(() => api.getDefinitionString(name, false)) : "",
        englishDef: xmlDef ?? "",
        color: has("getColor") ? safeString(() => api.getColor(name)) : "",
        visible: has("getVisible")
          ? (() => { try { return !!api.getVisible(name); } catch { return true; } })()
          : true,
        lineThickness: has("getLineThickness") ? safeNumber(() => api.getLineThickness(name)) : 1,
        lineStyle: has("getLineStyle") ? safeNumber(() => api.getLineStyle(name)) : 0,
        pointSize: has("getPointSize") ? safeNumber(() => api.getPointSize(name)) : 3,
        filling: has("getFilling") ? safeNumber(() => api.getFilling(name)) : 0,
        caption: has("getCaption") ? safeString(() => api.getCaption(name, false)) : "",
        labelVisible: has("getLabelVisible")
          ? (() => { try { return !!api.getLabelVisible(name); } catch { return false; } })()
          : false,
      };
    });
  };

  return {
    isReady: () => !!api,
    ready: () => ready,
    executeCommands: async (commands, opts = {}) => {
      await ready;
      let savedXml: string | null = null;
      if (opts.restoreOnError) {
        try {
          savedXml = api.getXML();
        } catch {
          savedXml = null;
        }
      }
      if (opts.resetBefore) await clearAll(api);
      if (opts.perspective) await applyPerspective(api, opts.perspective);

      const renamed: string[] = [];
      const overwritten: string[] = [];
      const failed: string[] = [];
      for (let i = 0; i < commands.length; i++) {
        // 逐条执行前做同名覆盖保护（冲突常发生在同一批命令内部）
        const guard = protectNameBeforeCommand(api, commands[i]);
        renamed.push(...guard.renamed);
        overwritten.push(...guard.overwritten);

        const ok = runCommand(api, commands[i]);
        if (!ok) failed.push(commands[i]);
        if (i < commands.length - 1) await delay(80);
      }
      // 只有「整批都失败」才回滚：个别命令失败时保留已成功的图形，
      // 把失败清单回灌给模型让它自己修正，比整板清空友好得多。
      if (failed.length && failed.length === commands.length && opts.restoreOnError && savedXml) {
        try {
          api.setXML(savedXml);
        } catch {
          /* ignore */
        }
      }
      return { ok: failed.length === 0, failed, renamed, overwritten };
    },
    setPerspective: async (mode) => {
      await ready;
      await applyPerspective(api, mode);
    },
    reset: async () => {
      await ready;
      await clearAll(api);
    },
    getXML: () => {
      try {
        return api ? api.getXML() : "";
      } catch {
        return "";
      }
    },
    getGgbBase64: async () => {
      await ready;
      if (!has("getBase64")) throw new Error("画板不支持 .ggb 导出（缺少 getBase64）");
      // 5.0 构建：无参或 (_, false) 会同步返回打包好的 base64 .ggb
      let raw = "";
      for (const attempt of [() => api.getBase64(), () => api.getBase64(null, false)]) {
        try {
          const r = attempt();
          if (typeof r === "string" && r.length > 8) {
            raw = stripDataUrl(r);
            break;
          }
        } catch {
          /* 继续尝试下一种调用方式 */
        }
      }
      // 其他版本可能只提供 callback 形式
      if (!raw) raw = stripDataUrl(await callStringApi(api, "getBase64", 12_000));

      const bytes = base64ToBytes(raw);
      // 明确拦截非 ZIP 产物，避免静默写出一个桌面软件必然打不开的坏文件
      if (!isZipBytes(bytes)) {
        throw new Error("GeoGebra 返回的不是有效的 .ggb（缺少 ZIP 文件头），请重试或改用 PNG / SVG 导出");
      }
      // 网页 applet 的 getBase64() 不带 geogebra_thumbnail.png，而桌面版保存的 .ggb 都带。
      // 补上缩略图以提升桌面软件兼容性；任何异常都原样返回引擎产物，不影响导出。
      if (has("getThumbnailBase64")) {
        const thumb = safeString(() => api.getThumbnailBase64());
        if (thumb) {
          try {
            const merged = appendZipEntry(bytes.buffer as ArrayBuffer, "geogebra_thumbnail.png", base64ToBytes(thumb));
            return bytesToBase64(new Uint8Array(merged));
          } catch {
            /* 回退到原始文件 */
          }
        }
      }
      return raw;
    },
    openGgbBase64: async (base64) => {
      await ready;
      if (!has("setBase64")) throw new Error("画板不支持打开 .ggb（缺少 setBase64）");
      try {
        api.setBase64(base64);
      } catch (e) {
        throw new Error("载入 .ggb 失败：" + (e as Error).message);
      }
      // setBase64 在部分版本是异步生效，给构造一点加载时间
      await delay(400);
    },
    exportTikZ: async () => {
      await ready;
      // exportPGF 是未公开 API；超时后由上层走降级生成器，别让用户等太久
      return callStringApi(api, "exportPGF", 8_000);
    },
    exportSVG: async () => {
      await ready;
      return callStringApi(api, "exportSVG", 10_000);
    },
    exportPNGBase64: async () => {
      await ready;
      if (has("getPNGBase64")) {
        try {
          const r = api.getPNGBase64(1, false, 72);
          if (typeof r === "string" && r.length > 8) return stripDataUrl(r);
        } catch {
          /* 回退到截图 API */
        }
      }
      if (!has("getScreenshotBase64")) throw new Error("画板不支持 PNG 导出");
      return stripDataUrl(await callStringApi(api, "getScreenshotBase64", 10_000));
    },
    getVersion,
    capabilities: () => ({
      ggb: has("getBase64"),
      tikz: has("exportPGF"),
      svg: has("exportSVG"),
      png: has("getPNGBase64") || has("getScreenshotBase64"),
      openGgb: has("setBase64"),
      version: getVersion(),
    }),
    inspectObjects,
    resize: () => syncSize(container.clientWidth, container.clientHeight, true),
  };
}
