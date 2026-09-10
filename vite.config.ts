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
    // These two are dynamic imports inside the worker, so Vite's startup
    // scanner never reaches them — it crawls from the HTML entry and does not
    // follow `new Worker(new URL(...))`. Left to discover them on first use,
    // it re-optimises and forces a full page reload, which in this app lands
    // in the middle of a batch and throws the queue away. Naming them here
    // gets them pre-bundled at boot instead.
    include: ["libheif-js/wasm-bundle", "utif2"],
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
  },
});
