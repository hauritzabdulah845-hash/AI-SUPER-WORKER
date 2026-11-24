import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // 云端发布：允许反向代理域名访问（preview 服务生产构建）
  server: { host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
});
