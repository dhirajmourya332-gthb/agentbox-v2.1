import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy the API, the terminal and the screen (and their WebSockets) to the portal. The Host
// stays localhost:5173, so the portal's Origin check (Origin == Host) still holds.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(["/api", "/term", "/screen"].map((p) => [p, { target: "http://localhost:7700", ws: true }])),
  },
});
