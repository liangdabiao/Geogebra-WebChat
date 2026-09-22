/**
 * LLM 代理（EdgeOne 云函数，替代原 Bun 版 server/proxy.ts）。
 *
 * 职责：
 *  1. 解决浏览器直连大模型供应商的 CORS 限制；
 *  2. 透明转发请求与流式响应（SSE）；
 *  3. 服务端注入 MODEL_API_KEY（设置后前端无需填写 Key）；
 *  4. GET 探测：返回 { serverKey } 告知前端是否已服务端注入。
 *
 * 路由约定：cloud-functions/llm-proxy/ → /llm-proxy
 * 前端通过 x-target-url 头携带真实上游地址（OpenAI 兼容端点）。
 */

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

function cors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

function json(obj: unknown, status = 200): Response {
  const res = new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  return cors(res);
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
  const serverKey = typeof env.MODEL_API_KEY === "string" ? env.MODEL_API_KEY.trim() : "";

  // CORS 预检
  if (method === "OPTIONS") {
    return cors(new Response(null, { status: 204 }));
  }

  // 探测端点：前端据此决定是否要求用户填写 Key
  if (method === "GET") {
    return json({ ok: true, serverKey: Boolean(serverKey) });
  }

  if (method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const headers = req.headers ?? {};
  const target = pickHeader(headers, "x-target-url");
  if (!target) return json({ error: "missing x-target-url" }, 400);

  let targetHost = "";
  try {
    targetHost = new URL(target).host;
  } catch {
    return json({ error: "bad target url" }, 400);
  }
  if (!targetHost) return json({ error: "bad target url" }, 400);

  // 转发头：优先服务端注入 Key；否则透传浏览器带来的鉴权头
  const fwd: Record<string, string> = {
    "content-type": pickHeader(headers, "content-type") || "application/json",
    accept: pickHeader(headers, "accept") || "*/*",
  };
  if (serverKey) {
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

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: fwd,
      body: body || undefined,
    });
  } catch (e) {
    return json({ error: "upstream fetch failed: " + (e as Error).message }, 502);
  }

  const resHeaders = new Headers(upstream.headers);
  return cors(new Response(upstream.body, { status: upstream.status, headers: resHeaders }));
}
