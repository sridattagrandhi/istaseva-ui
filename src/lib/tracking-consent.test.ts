import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ANALYTICS_CONSENT_VERSION,
  getTrackingConsent,
  hasTrackingConsent,
  setTrackingConsent,
} from "./tracking-consent";

const CONSENT_KEY = "istaseva:tracking-consent:v1";
const VERSION_KEY = "istaseva:tracking-consent-version:v1";

describe("tracking-consent versioning (LEG-014 re-prompt)", () => {
  beforeEach(() => localStorage.clear());

  it("setTrackingConsent stamps the disclosure version alongside the choice", () => {
    setTrackingConsent(true);
    expect(localStorage.getItem(CONSENT_KEY)).toBe("granted");
    expect(localStorage.getItem(VERSION_KEY)).toBe(ANALYTICS_CONSENT_VERSION);
    expect(getTrackingConsent()).toBe("granted");
  });

  it("grandfathers a pre-versioning choice (no version key) instead of re-prompting", () => {
    // Users who chose before versioning shipped have only the bare value.
    localStorage.setItem(CONSENT_KEY, "granted");
    expect(getTrackingConsent()).toBe("granted");
    localStorage.setItem(CONSENT_KEY, "denied");
    expect(getTrackingConsent()).toBe("denied");
  });

  it("treats a choice made under an OLDER disclosure version as unset (re-prompt + suppress)", () => {
    localStorage.setItem(CONSENT_KEY, "granted");
    localStorage.setItem(VERSION_KEY, "0.9.0");
    expect(getTrackingConsent()).toBe("unset");
    expect(hasTrackingConsent()).toBe(false);
    // The stored choice is preserved (only the read is version-gated), so
    // legal.service.syncAnalyticsConsent — which no-ops on 'unset' — writes
    // no spurious register row.
    expect(localStorage.getItem(CONSENT_KEY)).toBe("granted");
  });

  it("re-choosing after a version bump restores normal behaviour", () => {
    localStorage.setItem(CONSENT_KEY, "granted");
    localStorage.setItem(VERSION_KEY, "0.9.0");
    expect(getTrackingConsent()).toBe("unset");
    setTrackingConsent(true);
    expect(getTrackingConsent()).toBe("granted");
  });
});

/**
 * 3-way parity guard, same convention as analytics-events-contract.test.ts:
 * the disclosure version is mirrored across server (canonical), web, and
 * mobile, which share no code. process.cwd() is correct here — this is a
 * web-side test and only runs from the repo root suite.
 */
describe("ANALYTICS_CONSENT_VERSION parity (server ⇄ web ⇄ mobile)", () => {
  const repoRoot = process.cwd();
  const readVersion = (relPath: string): string => {
    const src = readFileSync(resolve(repoRoot, relPath), "utf8");
    const m = src.match(/ANALYTICS_CONSENT_VERSION\s*=\s*['"]([^'"]+)['"]/);
    if (!m) throw new Error(`ANALYTICS_CONSENT_VERSION not found in ${relPath}`);
    return m[1];
  };

  it("web mirror matches the server canonical", () => {
    expect(ANALYTICS_CONSENT_VERSION).toBe(
      readVersion("server/src/modules/users/legal-docs-version.ts"),
    );
  });

  it("mobile mirror matches the server canonical", () => {
    expect(readVersion("mobile/src/design/api/analyticsEvents.ts")).toBe(
      readVersion("server/src/modules/users/legal-docs-version.ts"),
    );
  });
});
