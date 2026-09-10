import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  optimizeDeps: {
    // The jSquash packages ship .wasm alongside their JS and resolve it with
    // `new URL(..., import.meta.url)`. esbuild's dep pre-bundling rewrites those
    // URLs and the wasm 404s, so they have to stay unbundled in dev.
    exclude: [
      "@jsquash/jpeg",
      "@jsquash/png",
      "@jsquash/oxipng",
      "@jsquash/resize",
      "@jsquash/webp",
      "@jsquash/avif",
    ],
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
  },
});
