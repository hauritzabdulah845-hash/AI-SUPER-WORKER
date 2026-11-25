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
  build: {
    rollupOptions: {
      output: {
        // 重依赖拆独立 chunk，避免业务主包 >500kB；业务代码 import 方式不变
        manualChunks(id) {
          // office 能力与其重依赖同 chunk，避免 cloud-core ↔ vendor-office 循环
          if (/[\\/]src[\\/]cloud[\\/]office\.ts$/.test(id)) return "office-core";
          if (/[\\/]node_modules[\\/](docx|pptxgenjs)[\\/]/.test(id)) return "office-core";
          // 业务代码按层拆：ui 组件库与 cloud 能力层独立成 chunk（cloud 不反向依赖 components，无循环）
          if (/[\\/]src[\\/]components[\\/]ui[\\/]/.test(id)) return "ui-kit";
          if (/[\\/]src[\\/]cloud[\\/]/.test(id)) return "cloud-core";
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "vendor-react";
          if (id.includes("@radix-ui")) return "vendor-radix";
          if (/[\\/]node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor)[\\/]/.test(id)) return "vendor-charts";
          if (/[\\/]node_modules[\\/]xlsx[\\/]/.test(id)) return "vendor-xlsx";
          if (/[\\/]node_modules[\\/]pdfjs-dist[\\/]/.test(id)) return "vendor-pdf";
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return "vendor-icons";
          // mammoth/fflate 与 misc 互相依赖，合并避免 Circular chunk
          return "vendor-misc";
        },
      },
    },
  },
});
