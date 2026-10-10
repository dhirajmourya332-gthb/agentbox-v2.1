import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The page is served at / (direct, with a one-time token) and at /setup/ (through the portal), so
// every URL in it is relative.
export default defineConfig({
  root: "web",
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
