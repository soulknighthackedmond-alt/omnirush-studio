import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"` keeps the built asset URLs relative so Electron can load the
// bundle straight off disk with file://.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome122",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
