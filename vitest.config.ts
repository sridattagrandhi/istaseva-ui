import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}", "server/src/**/*.{test,spec}.{ts,tsx}"],
    // *.integration.test.ts files need external services running (Redis,
    // Postgres, etc.) and are gated out of the default run so the suite
    // stays green in environments without those services. Run them
    // explicitly via the `test:integration` package script.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/*.integration.{test,spec}.{ts,tsx}",
    ],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
