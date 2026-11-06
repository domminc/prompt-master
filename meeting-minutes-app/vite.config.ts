import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 프론트엔드: web/ → dist/client (wrangler assets 로 서빙)
// 개발 중에는 /api 를 wrangler dev(8787)로 프록시한다.
export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  // ffmpeg.wasm 은 자체 Web Worker 를 띄우므로 개발 서버의 사전 번들링에서 제외해야 한다.
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  build: { outDir: "../dist/client", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8787" } },
});
