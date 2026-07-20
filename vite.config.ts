import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  build: {
    rollupOptions: {
      output: {
        // Split the heaviest vendor libraries into their own long-lived,
        // cacheable chunks. Combined with the route-level React.lazy split in
        // App.tsx (and the lazy MapView in the redesign), maplibre/recharts
        // load only on the routes that use them, not in the entry chunk.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("maplibre-gl")) return "maplibre";
          if (id.includes("recharts") || id.includes("/d3-") || id.includes("victory-vendor")) return "charts";
          if (id.includes("/@firebase/") || id.includes("/firebase/")) return "firebase";
          if (id.includes("/react-dom/") || id.includes("/react-router") || id.includes("/scheduler/")) return "react-vendor";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
}));
