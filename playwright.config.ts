import { defineConfig, devices } from "@playwright/test";

/**
 * Default Playwright config — drives the app's public user journeys against a
 * freshly-started Vite dev server (mock-backed marketplace, so no API/DB
 * needed). Replaces the previous config that imported an uninstalled
 * `lovable-agent-playwright-config` preset and so failed to load at all.
 *
 *   npm run test:e2e            # starts Vite on PORT and runs e2e/*.spec.ts
 *   E2E_BASE_URL=https://staging.istaseva.com npm run test:e2e   # against a deploy
 *
 * The CSP audit (e2e/csp-audit.spec.ts) targets a DEPLOYED origin and has its
 * own config (playwright.csp.config.ts), so it's excluded here.
 */
const PORT = Number(process.env.E2E_PORT ?? 4189);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "**/csp-audit.spec.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    viewport: { width: 1280, height: 860 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Only spin up a local server when we're not pointed at a deployed origin.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx vite --port ${PORT} --strictPort`,
        port: PORT,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
