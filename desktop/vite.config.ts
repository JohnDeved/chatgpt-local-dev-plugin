import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: {
      "electrobun/view": fileURLToPath(
        new URL("./.hutch/devkit/api/browser/index.ts", import.meta.url),
      ),
    },
  },
  define: { __LD_TEST__: JSON.stringify(mode === "test") },
  build: {
    outDir: mode === "test" ? "dist/test-ui" : "dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
  },
}));
