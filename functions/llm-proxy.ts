/**
 * Cloudflare Pages Functions 适配层。
 *
 * 复用 EdgeOne 的云函数处理器（cloud-functions/llm-proxy/index.ts），
 * 让同一套白名单 / CORS / 服务端 Key 注入 / SSE 惰性流包装逻辑在两个平台共用。
 * functions/llm-proxy.ts 会被 Pages 映射到 /llm-proxy，与前端 fetch("/llm-proxy") 一致。
 *
 * 唯一的运行时差异：
 *   - EdgeOne：req.body 已被平台解析成字符串或对象；
 *   - Cloudflare：context.request 是标准 Request，body 是只读一次的 ReadableStream。
 * 因此这里先把 body 读成字符串，再构造 EdgeOne 风格的 request 交给通用 handler。
 * 不这么做的话，所有 POST 都会以空 body 转发（GET 探测正常，极易漏测）。
 */

import { onRequest as handleProxy } from "../cloud-functions/llm-proxy/index";

/** 请求体预检上限；图片以 base64 嵌在 JSON 里会膨胀约 1/3，留足余量。 */
const MAX_BODY_BYTES = 6_000_000;

export const onRequest = async (context: any): Promise<Response> => {
  const request = context.request as Request;
  const method = (request.method || "GET").toUpperCase();

  // POST 才需要读 body；GET 探测与 OPTIONS 预检直接透传空 body。
  let body = "";
  if (method === "POST") {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return new Response(
        JSON.stringify({ error: `请求体过大（约 ${Math.round(declared / 1024)}KB）：请减少图片数量或换用更小的图片` }),
        { status: 413, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
    body = await request.text();
    // 没有 content-length（分块传输）时兜底检查，避免把大图全读进 128MB 内存。
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
      return new Response(
        JSON.stringify({ error: "请求体过大：请减少图片数量或换用更小的图片" }),
        { status: 413, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
  }

  // 通用 handler 只使用 request.method / request.headers / request.body 与 env。
  return (await handleProxy({
    env: context.env ?? {},
    request: { method, headers: request.headers, body },
  })) as Response;
};
