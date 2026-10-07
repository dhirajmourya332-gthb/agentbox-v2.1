import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy the API (and its WebSocket) to the orchestrator in the VM.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": { target: "http://localhost:7700", ws: true } },
  },
});
