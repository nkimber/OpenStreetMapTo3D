import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // WorldWorkspace is lazy-loaded. Pre-bundle its heavy runtime dependencies
    // up front so Vite does not reload the page the first time a world opens.
    include: [
      "@dimforge/rapier3d-compat",
      "three",
      "three/examples/jsm/controls/OrbitControls.js",
      "zod",
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: true,
    target: "es2022",
  },
});
