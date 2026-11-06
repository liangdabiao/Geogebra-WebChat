/**
 * 预置模型服务商。
 *
 * 目的：让用户不用手抄 Base URL / 模型名，一键切到常见服务商。
 * 约束：
 *  - 只列 /llm-proxy 白名单允许的域名（见 cloud-functions/llm-proxy/index.ts 的 ALLOWED_HOSTS），
 *    否则前端能选、云函数却会拒（403 target host not allowed）。
 *  - API Key 只存在浏览器 localStorage，不写进仓库、不上传服务器。
 *  - vision 标记该服务商的推荐模型是否支持图片输入（读图作图依赖它）。
 */

export interface ProviderPreset {
  id: string;
  /** 下拉里的显示名。 */
  label: string;
  /** OpenAI 兼容接口的 Base URL；留空表示「跟随服务端配置」。 */
  baseURL: string;
  /** 推荐模型名。 */
  model: string;
  /** 推荐模型是否支持图片输入。 */
  vision: boolean;
  /** 备注，显示在下拉下方。 */
  note?: string;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "server",
    label: "服务端默认（免填 Key）",
    baseURL: "",
    model: "",
    vision: true,
    note: "使用部署方已配置的模型服务，Key 由服务端注入",
  },
  {
    id: "deepseek",
    label: "DeepSeek 官方",
    // 与服务端注入的默认配置保持一致（/v1 可省略，DeepSeek 两种都接受）
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    vision: true,
    note: "deepseek-flash 自带视觉能力，可直接读图",
  },
  {
    id: "qwen",
    label: "通义千问（阿里云百炼）",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-vl-max",
    vision: true,
    note: "读图请用 qwen-vl-max / qwen-vl-plus；纯文本可用 qwen-plus",
  },
  {
    id: "glm",
    label: "智谱 GLM",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4v-plus",
    vision: true,
    note: "glm-4v-plus 支持图片；纯文本可用 glm-4-flash",
  },
  {
    id: "kimi",
    label: "月之暗面 Kimi",
    baseURL: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    vision: false,
    note: "该系列默认不支持图片输入",
  },
  {
    id: "siliconflow",
    label: "硅基流动 SiliconFlow",
    baseURL: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen2.5-VL-72B-Instruct",
    vision: true,
    note: "聚合平台，模型名较多，可自行改成想要的视觉模型",
  },
  {
    id: "openai",
    label: "OpenAI 官方",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    vision: true,
    note: "需要可直连 api.openai.com 的网络环境",
  },
  {
    id: "custom",
    label: "自定义（手动填写）",
    baseURL: "",
    model: "",
    vision: true,
    note: "在右侧手填 Base URL、模型名与 API Key",
  },
];

export const CUSTOM_PROVIDER_ID = "custom";

/** 按 id 找预设。 */
export function findProvider(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * 猜测当前 Base URL 属于哪个预设，用于下拉框回显。
 * 只按 host 匹配（忽略路径），路径不同但同域也算同一个服务商。
 */
export function guessProviderId(baseURL: string, serverBaseURL: string): string {
  const host = (u: string) => {
    try { return new URL(u.trim()).host.toLowerCase(); } catch { return ""; }
  };
  const cur = host(baseURL);
  if (!cur) return "server";
  const srv = host(serverBaseURL);
  if (srv && cur === srv) return "server";
  for (const p of PROVIDERS) {
    if (p.id === "server" || p.id === CUSTOM_PROVIDER_ID) continue;
    if (host(p.baseURL) === cur) return p.id;
  }
  return CUSTOM_PROVIDER_ID;
}
