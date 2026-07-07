import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => {
  const target = process.env.WX_API ?? "http://127.0.0.1:8080";
  return {
  plugins: [react()],
  server: {
    proxy: {
      // Everything under /api proxies unrewritten to the backend (WX_API env,
      // default local). For a remote backend: `WX_API=https://example.org pnpm
      // run dev`.
      "/api": { target, changeOrigin: true, secure: target.startsWith("https://") },
    },
  },
  build: {
    // Split vendored libs into separate chunks so the app bundle stays
    // small enough to parse on slow connections. Without this, MapLibre
    // (~800 KB) pads the main bundle to ~1.4 MB and blocks first paint.
    // Vite 8 uses rolldown; manualChunks here takes the function form.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/maplibre-gl")) return "maplibre";
          if (id.includes("node_modules/pmtiles")) return "pmtiles";
          if (
            id.includes("node_modules/react-dom") ||
            id.includes("node_modules/scheduler") ||
            /node_modules[\\/]react[\\/]/.test(id)
          ) {
            return "react";
          }
          return undefined;
        },
      },
    },
    // Warn threshold — the app / react / protobuf chunks stay well
    // under 250 KB; only maplibre-gl (~1 MB minified) trips the warn,
    // which is inherent to the library. Raise it just enough to let
    // maplibre through so the warning remains useful for app-code
    // regressions.
    chunkSizeWarningLimit: 1100,
  },
  };
});
