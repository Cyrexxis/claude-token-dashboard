import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = "http://127.0.0.1:47811";

export default defineConfig({
  plugins: [react()],
  // Served from localhost, never over a network: one bundle is fine.
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // changeOrigin rewrites Host for the host guard; the Origin rewrite lets dev writes pass the origin guard.
      "/api": { target: server, changeOrigin: true, headers: { origin: server } },
    },
  },
});
