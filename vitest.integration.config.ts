import { defineConfig } from "vitest/config";
import path from "path";

// Integration tests hit real external services (Postgres, Redis) and are
// gated out of the default `vitest.config.ts` run. This config includes ONLY
// *.integration.{test,spec}.ts and runs them in a node environment. Bring the
// services up first (docker compose up -d && cd server && npm run db:migrate),
// then run `npm run test:integration`.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: [
      "src/**/*.integration.{test,spec}.{ts,tsx}",
      "server/src/**/*.integration.{test,spec}.{ts,tsx}",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // External-service tests share DB rows/keys; don't run files in parallel.
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
