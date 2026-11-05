/**
 * LLM 代理（EdgeOne 云函数）。
 *
 * 职责：
 *  1. 解决浏览器直连大模型供应商的 CORS 限制；
 *  2. 透明转发请求与流式响应（SSE）；
 *  3. 服务端注入模型 Key——优先 EdgeOne Makers 网关 Key（MAKERS_MODELS_KEY，内置免费模型），
 *     回退旧的 MODEL_API_KEY；仅当转发目标与服务端配置的 MODEL_BASE_URL 同域时才注入，
 *     防止调用方通过 x-target-url 把服务端密钥引到任意外部主机（SSRF / 凭据外送）；
 *  4. GET 探测：返回 { serverKey } 告知前端是否已服务端注入。
 *
 * 路由约定：cloud-functions/llm-proxy/ → /llm-proxy
 * 前端通过 x-target-url 头携带真实上游地址（OpenAI 兼容端点），目标 host 必须在白名单内。
 */

// 主流 OpenAI 兼容 LLM 服务域名白名单（用户可在页面切换模型服务商，但只能切到这里列出的）
const ALLOWED_HOSTS = new Set([
  "tokenhub.tencentmaas.com",
  "ai-gateway.edgeone.link",
  "api.deepseek.com",
  "api.openai.com",
  "api.moonshot.cn",
  "api.zhipuai.cn",
  "dashscope.aliyuncs.com",
  "api.siliconflow.cn",
  "api-inference.modelscope.cn",
  "ark.cn-beijing.volces.com",
  "generativelanguage.googleapis.com",
  "api.anthropic.com",
  "openrouter.ai",
]);

// 内网 / 环回 / 元数据地址（纵深防御，白名单之外的二次拦截）
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[::1\]|.*\.(internal|local|lan)$)/i;

// EdgeOne Makers Models 统一网关（平台内置模型，账号赠送免费 token，无需绑定厂商密钥）。
// 未显式配置 MODEL_BASE_URL / MODEL_NAME 时，服务端默认就走这里。
const DEFAULT_BASE_URL = "https://ai-gateway.edgeone.link/v1";
const DEFAULT_MODEL = "@makers/deepseek-v4-flash";

function json(obj: unknown, status = 200, origin = ""): Response {
  const res = new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  applyCors(res, origin);
  return res;
}

/** 仅对可信来源（本站 / EdgeOne 部署域名 / 本地开发）放开 CORS；同源请求本就不依赖 CORS。 */
function corsAllowed(origin: string, selfHost: string): boolean {
  if (!origin) return false;
  try {
    const o = new URL(origin);
    if (o.hostname === selfHost) return true;
    if (/\.(edgeone\.cool|edgeone\.app|edgeone\.run)$/.test(o.hostname)) return true;
    if (o.hostname === "localhost" || o.hostname === "127.0.0.1") return true;
    return false;
  } catch {
    return false;
  }
}

function applyCors(res: Response, origin: string): void {
  res.headers.set("access-control-allow-headers", "content-type, authorization, x-api-key, x-target-url, x-custom-hostname, anthropic-version, anthropic-dangerous-direct-browser-access");
  res.headers.set("access-control-allow-methods", "POST, GET, OPTIONS");
  res.headers.set("vary", "origin");
  if (origin) res.headers.set("access-control-allow-origin", origin);
}

function pickHeader(headers: any, name: string): string {
  try {
    const v = headers?.get?.(name);
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

export async function onRequest(context: any) {
  const req = context?.request ?? {};
  const env = context?.env ?? {};
  const method = (req.method || "GET").toUpperCase();
  const headers = req.headers ?? {};

  // 模型 Key 优先级：EdgeOne Makers 网关 Key → 兼容旧的第三方配置 MODEL_API_KEY。
  // MAKERS_MODELS_KEY 在 Makers 控制台 Models / API Key 创建，一个 Key 可调所有内置模型。
  const makersKey = typeof env.MAKERS_MODELS_KEY === "string" ? env.MAKERS_MODELS_KEY.trim() : "";
  const legacyKey = typeof env.MODEL_API_KEY === "string" ? env.MODEL_API_KEY.trim() : "";
  const serverKey = makersKey || legacyKey;

  // Key 与端点必须「成组」切换，否则会出现「拿 A 的 Key 打 B 的网关」→ 401 / 模型不存在。
  // 配了 Makers Key 就整组走 EdgeOne 内置网关（忽略旧的 MODEL_*，它们指向第三方）；
  // 只有旧的第三方配置时才维持原行为，保证未迁移的部署不会突然不可用。
  const usesMakers = Boolean(makersKey);
  const legacyBaseURL = typeof env.MODEL_BASE_URL === "string" ? env.MODEL_BASE_URL.trim() : "";
  const legacyModel = typeof env.MODEL_NAME === "string" ? env.MODEL_NAME.trim() : "";
  const makersModel =
    typeof env.MAKERS_MODEL === "string" && env.MAKERS_MODEL.trim()
      ? env.MAKERS_MODEL.trim()
      : DEFAULT_MODEL;

  const serverBaseURL = usesMakers ? DEFAULT_BASE_URL : legacyBaseURL || DEFAULT_BASE_URL;
  const serverModel = usesMakers ? makersModel : legacyModel || DEFAULT_MODEL;
  let serverBaseHost = "";
  try {
    serverBaseHost = serverBaseURL ? new URL(serverBaseURL).host : "";
  } catch {
    serverBaseHost = "";
  }

  const reqOrigin = pickHeader(headers, "origin");
  const selfHost = pickHeader(headers, "host");
  const corsOrigin = corsAllowed(reqOrigin, selfHost) ? reqOrigin : "";

  // CORS 预检
  if (method === "OPTIONS") {
    const res = new Response(null, { status: 204 });
    applyCors(res, corsOrigin);
    return res;
  }

  // 探测端点：前端据此决定是否要求用户填写 Key，并取默认接口地址与模型名
  if (method === "GET") {
    return json(
      {
        ok: true,
        serverKey: Boolean(serverKey),
        // provider 供前端展示用：edgeone = 平台内置网关（免费额度）
        provider: serverBaseHost.toLowerCase() === "ai-gateway.edgeone.link" ? "edgeone" : "custom",
        baseURL: serverBaseURL,
        model: serverModel,
      },
      200,
      corsOrigin,
    );
  }

  if (method !== "POST") {
    return json({ error: "method not allowed" }, 405, corsOrigin);
  }

  const target = pickHeader(headers, "x-target-url");
  if (!target) return json({ error: "missing x-target-url" }, 400, corsOrigin);

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: "bad target url" }, 400, corsOrigin);
  }

  // 目标校验：仅 https、host 白名单（含服务端配置的 MODEL_BASE_URL host）、禁内网
  const targetHost = parsed.host;
  const allowed = new Set(ALLOWED_HOSTS);
  if (serverBaseHost) allowed.add(serverBaseHost);
  if (parsed.protocol !== "https:" || !targetHost || PRIVATE_HOST.test(targetHost) || !allowed.has(targetHost.toLowerCase())) {
    return json({ error: "target host not allowed" }, 403, corsOrigin);
  }

  // 转发头：服务端 Key 只发给它所属的服务端（与 MODEL_BASE_URL 同域）；
  // 其他白名单服务商只透传浏览器自带的鉴权头（用户自己的 Key）
  const fwd: Record<string, string> = {
    "content-type": pickHeader(headers, "content-type") || "application/json",
    accept: pickHeader(headers, "accept") || "*/*",
  };
  if (serverKey && serverBaseHost && targetHost.toLowerCase() === serverBaseHost.toLowerCase()) {
    fwd["authorization"] = `Bearer ${serverKey}`;
  } else {
    const auth = pickHeader(headers, "authorization");
    if (auth) fwd["authorization"] = auth;
    const xKey = pickHeader(headers, "x-api-key");
    if (xKey) fwd["x-api-key"] = xKey;
  }
  const av = pickHeader(headers, "anthropic-version");
  if (av) fwd["anthropic-version"] = av;
  const adba = pickHeader(headers, "anthropic-dangerous-direct-browser-access");
  if (adba) fwd["anthropic-dangerous-direct-browser-access"] = adba;

  // body 可能被运行时解析为对象，也可能是原始字符串
  let body: string;
  const raw = (req as any).body;
  if (typeof raw === "string") body = raw;
  else if (raw && typeof raw === "object") body = JSON.stringify(raw);
  else body = "";

  // EdgeOne Cloud Functions 请求体上限 6MB；图片以 base64 嵌在 JSON 里会膨胀约 1/3。
  // 超限时提前返回可读错误，避免被平台直接截断成难以定位的错误。
  const bodyBytes = new TextEncoder().encode(body).length;
  if (bodyBytes > 5_500_000) {
    return json(
      { error: `请求体过大（${Math.round(bodyBytes / 1024)}KB）：请减少图片数量或换用更小的图片` },
      413,
      corsOrigin,
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: fwd,
      body: body || undefined,
    });
  } catch (e) {
    return json({ error: "upstream fetch failed: " + (e as Error).message }, 502, corsOrigin);
  }

  // 上游非 2xx 时，把常见的额度/鉴权错误翻译成可操作的中文提示。
  // 错误响应不是流，可以安全读取；正常响应仍保持原样的 SSE 透传。
  if (!upstream.ok) {
    let detail = "";
    try {
      const rawText = await upstream.text();
      try {
        const parsedErr = JSON.parse(rawText);
        detail = String(parsedErr?.error?.message ?? parsedErr?.message ?? rawText);
      } catch {
        detail = rawText;
      }
    } catch { /* 响应体不可读时忽略 */ }
    detail = detail.slice(0, 400);

    const quota = upstream.status === 402 || /insufficient.*quota|quota.*exceed|额度/i.test(detail);
    let message: string;
    if (quota && parsed.host.toLowerCase() === "ai-gateway.edgeone.link") {
      message =
        "EdgeOne Makers 内置模型免费额度已用尽（50 万 token/月，按账号共享，重新创建 Key 无效）。" +
        "请绑定 BYOK、提交工单提额，或在页面右上角改用自己的模型服务地址与 API Key。";
    } else if (quota) {
      message =
        "模型服务返回额度或余额不足（402），请检查该服务商的账户余额与 API Key；" +
        "也可在页面右上角切换到别的模型服务。";
    } else {
      message = `模型服务返回 ${upstream.status}：${detail || "无详细信息"}`;
    }

    return json(
      { error: message, code: quota ? "quota_exhausted" : "upstream_error", upstreamStatus: upstream.status },
      upstream.status,
      corsOrigin,
    );
  }

  const resHeaders = new Headers(upstream.headers);
  const res = new Response(upstream.body, { status: upstream.status, headers: resHeaders });
  applyCors(res, corsOrigin);
  return res;
}
