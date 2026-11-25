import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  // Monaco (the IDE editor) is one large lazy chunk by design; it loads only in IDE view.
  build: { outDir: "../dist/web", emptyOutDir: true, chunkSizeWarningLimit: 3500 },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:4317", "/preview": "http://127.0.0.1:4317" },
  },
});
