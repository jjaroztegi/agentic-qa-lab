import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Relative asset URLs: the same build is served by the server (with <base href="/">) and copied
// as-is into static replay exports that live in any sub-folder of a static host.
export default defineConfig({
  root: "web",
  base: "./",
  plugins: [preact()],
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022", assetsInlineLimit: 0 },
  server: { proxy: { "/api": "http://127.0.0.1:17000" } },
});
