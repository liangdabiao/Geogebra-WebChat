/**
 * GeoGebra 画板控制器（极简版）。
 * 通过官方 CDN 加载 deployggb.js，注入 GGBApplet，并提供命令执行 / 视角切换 / 清空 / 读 XML 能力。
 * 从原项目 src/renderer/src/geogebra*.ts 精简而来，去掉 vendor 依赖与复杂重挂逻辑。
 */

declare global {
  interface Window {
    GGBApplet?: any;
  }
}

const DEPLOY_URL = "https://www.geogebra.org/apps/deployggb.js";

export interface ExecuteOptions {
  perspective?: string;
  resetBefore?: boolean;
  restoreOnError?: boolean;
}

export interface ExecuteResult {
  ok: boolean;
  failed: string[];
}

export interface GeoGebraController {
  isReady: () => boolean;
  ready: () => Promise<void>;
  executeCommands: (commands: string[], opts?: ExecuteOptions) => Promise<ExecuteResult>;
  setPerspective: (mode: string) => Promise<void>;
  reset: () => Promise<void>;
  getXML: () => string;
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

function evalOne(api: any, command: string): boolean {
  if (!api) return false;
  try {
    // evalCommand 同步返回 boolean，优先使用
    if (typeof api.evalCommand === "function") return !!api.evalCommand(command);
    // asyncEvalCommandResult 是异步的，拿不到返回值，只能乐观假设成功
    if (typeof api.asyncEvalCommandResult === "function") {
      api.asyncEvalCommandResult(command);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function clearAll(api: any): Promise<void> {
  if (!api) return;
  try {
    const names: string[] = api.getAllObjectNames ? api.getAllObjectNames() : [];
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
    applet.inject(containerId);
  });

  await ready;

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

      const failed: string[] = [];
      for (let i = 0; i < commands.length; i++) {
        const ok = evalOne(api, commands[i]);
        if (!ok) failed.push(commands[i]);
        if (i < commands.length - 1) await delay(80);
      }
      if (failed.length && opts.restoreOnError && savedXml) {
        try {
          api.setXML(savedXml);
        } catch {
          /* ignore */
        }
      }
      return { ok: failed.length === 0, failed };
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
  };
}
