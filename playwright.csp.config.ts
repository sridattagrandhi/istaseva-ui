import { defineConfig, devices } from '@playwright/test';

/**
 * Standalone Playwright config for the SEC-010 CSP audit (e2e/csp-audit.spec.ts).
 *
 * Separate from the repo's `playwright.config.ts` (which imports a Lovable
 * preset that isn't installed). Run against deployed staging:
 *
 *   CSP_TEST_EMAIL=... CSP_TEST_PASSWORD=... \
 *     npx playwright test --config playwright.csp.config.ts
 *
 * Override the target with CSP_TEST_BASE_URL. No local web server is started —
 * this drives a real deployed environment so the CloudFront header policy is
 * actually in effect.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /csp-audit\.spec\.ts/,
  timeout: 120_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.CSP_TEST_BASE_URL || 'https://staging.istaseva.com',
    viewport: { width: 1366, height: 900 },
    // Surface any TLS problems rather than hiding them.
    ignoreHTTPSErrors: false,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
