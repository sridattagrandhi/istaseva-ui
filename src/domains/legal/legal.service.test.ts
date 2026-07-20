import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiRequest } from "@/lib/api-client";
import { LEGAL_DOCS_VERSION } from "@/lib/legal";
import { LegalService } from "./legal.service";

vi.mock("@/lib/api-client", () => ({
  apiRequest: vi.fn(),
  getJsonHeaders: vi.fn().mockReturnValue({}),
}));

const mockConsents = (rows: Array<{ consent_type: string; version: string; granted: boolean }>) => {
  vi.mocked(apiRequest).mockImplementation(async (path: string) => {
    if (path === "/api/users/me/consents") {
      return { success: true, data: { data: rows.map((r) => ({ ...r, created_at: "2026-07-15T00:00:00Z" })) } } as never;
    }
    return { success: true, data: { data: { consent_type: "terms", version: LEGAL_DOCS_VERSION, granted: true, created_at: "" } } } as never;
  });
};

/**
 * Terms re-consent (LEG-003, general mechanism): a stale/missing/withdrawn
 * 'terms' row must trigger the blocking re-accept; a current one must not.
 * Before this shipped LEGAL_DOCS_VERSION was stamped but never compared, so
 * Terms changes bound only new signups.
 */
describe("legal.service terms re-consent (LEG-003)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(apiRequest).mockReset();
  });

  it("no re-consent when the latest terms row matches the current version", async () => {
    mockConsents([{ consent_type: "terms", version: LEGAL_DOCS_VERSION, granted: true }]);
    await expect(new LegalService().needsTermsReconsent()).resolves.toBe(false);
  });

  it("re-consent when the terms row was recorded under an older version", async () => {
    mockConsents([{ consent_type: "terms", version: "1.2.0-draft", granted: true }]);
    await expect(new LegalService().needsTermsReconsent()).resolves.toBe(true);
  });

  it("re-consent when no terms row exists at all", async () => {
    mockConsents([{ consent_type: "marketing", version: "1.0.0", granted: true }]);
    await expect(new LegalService().needsTermsReconsent()).resolves.toBe(true);
  });

  it("fail-quiet: a failed consents read never blocks the app", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ success: false, error: "network" } as never);
    await expect(new LegalService().needsTermsReconsent()).resolves.toBe(false);
  });

  it("skipped while a signup terms write is still pending (retry owns it)", async () => {
    localStorage.setItem("istaseva:pending-terms-consent:v1", "1");
    await expect(new LegalService().needsTermsReconsent()).resolves.toBe(false);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("acceptCurrentTerms writes BOTH the terms row and the 18+ attestation", async () => {
    mockConsents([]);
    await expect(new LegalService().acceptCurrentTerms()).resolves.toBe(true);
    const puts = vi.mocked(apiRequest).mock.calls.filter(([, init]) => (init as RequestInit)?.method === "PUT");
    expect(puts.map(([path]) => path)).toEqual([
      "/api/users/me/consents/terms",
      "/api/users/me/consents/age_confirmation",
    ]);
  });

  it("recordSignupConsents records terms AND the age attestation", async () => {
    mockConsents([]);
    await new LegalService().recordSignupConsents(false);
    const puts = vi.mocked(apiRequest).mock.calls.filter(([, init]) => (init as RequestInit)?.method === "PUT");
    expect(puts.map(([path]) => path)).toContain("/api/users/me/consents/terms");
    expect(puts.map(([path]) => path)).toContain("/api/users/me/consents/age_confirmation");
  });
});
