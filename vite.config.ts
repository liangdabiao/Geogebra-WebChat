import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5173,
    proxy: {
      // 开发期把 /api 转发到本地 LLM 代理（默认 8787）
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
