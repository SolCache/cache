import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: { index: resolve(__dirname, "index.html"), app: resolve(__dirname, "app.html"), docs: resolve(__dirname, "docs.html") } },
  },
  define: { "process.env.NODE_DEBUG": "false", global: "globalThis" },
});
