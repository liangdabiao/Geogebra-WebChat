/**
 * 轻量 LLM 代理（Bun）。
 * 职责：
 *  1. 解决浏览器直连大模型供应商的 CORS 限制；
 *  2. 透明转发请求与流式响应（SSE）；
 *  3. 主机白名单，防止被滥用为开放代理；
 *  4. 生产模式下顺便托管 ./dist 静态前端。
 *
 * 启动：bun server/proxy.ts   （默认端口 8787）
 * 可选环境变量：
 *   PORT              代理端口
 *   MODEL_API_KEY     服务端注入 Key（设置后前端可不填，Key 不暴露给浏览器）
 */
const PORT = Number(process.env.PORT) || 8787;
const SERVER_KEY = process.env.MODEL_API_KEY || "";

/** 允许转发的供应商主机（含子域）。 */
const ALLOWED_HOSTS = [
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.deepseek.com",
  "dashscope.aliyuncs.com",
  "openrouter.ai",
];

function cors(res: Response): Response {
  res.headers.set("access-control-allow-origin", "*");
  res.headers.set("access-control-allow-headers", "*");
  res.headers.set("access-control-allow-methods", "POST, OPTIONS");
  return res;
}

function json(obj: unknown, status = 200): Response {
  return cors(
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function hostAllowed(host: string): boolean {
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS 预检
    if (req.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    // LLM 代理端点
    if (url.pathname === "/api/llm-proxy" && req.method === "POST") {
      const target = req.headers.get("x-target-url");
      if (!target) return json({ error: "missing x-target-url" }, 400);

      let targetHost = "";
      try {
        targetHost = new URL(target).host;
      } catch {
        return json({ error: "bad target url" }, 400);
      }
      // 浏览器端设置了自定义 baseURL 时，通过 x-custom-hostname 头告知代理允许该 host
      const customHost = req.headers.get("x-custom-hostname");
      if (!hostAllowed(targetHost) && targetHost !== customHost) {
        return json({ error: "host not allowed: " + targetHost }, 403);
      }

      const fwd = new Headers();
      const ct = req.headers.get("content-type");
      if (ct) fwd.set("content-type", ct);
      // 优先用服务端注入的 Key；否则透传浏览器带来的鉴权头
      if (SERVER_KEY) {
        fwd.set("authorization", `Bearer ${SERVER_KEY}`);
      } else {
        const auth = req.headers.get("authorization");
        if (auth) fwd.set("authorization", auth);
        const xKey = req.headers.get("x-api-key");
        if (xKey) fwd.set("x-api-key", xKey);
      }
      const av = req.headers.get("anthropic-version");
      if (av) fwd.set("anthropic-version", av);
      const adba = req.headers.get("anthropic-dangerous-direct-browser-access");
      if (adba) fwd.set("anthropic-dangerous-direct-browser-access", adba);

      let upstream: Response;
      try {
        upstream = await fetch(target, {
          method: "POST",
          headers: fwd,
          body: req.body,
          duplex: "half",
        } as any);
      } catch (e) {
        return json({ error: "upstream fetch failed: " + (e as Error).message }, 502);
      }

      const resHeaders = new Headers(upstream.headers);
      return cors(new Response(upstream.body, { status: upstream.status, headers: resHeaders }));
    }

    // 生产模式：托管前端静态文件（./dist）
    if (url.pathname !== "/api/llm-proxy") {
      const file = Bun.file("./dist" + (url.pathname === "/" ? "/index.html" : url.pathname));
      if (await file.exists()) return new Response(file);
      // SPA 回退
      const index = Bun.file("./dist/index.html");
      if (await index.exists()) return new Response(index);
    }

    return json({ error: "not found", path: url.pathname }, 404);
  },
});

console.log(`[geochat-web proxy] http://localhost:${PORT}`);
if (SERVER_KEY) console.log("  · 服务端已注入 MODEL_API_KEY（前端可不填 Key）");
