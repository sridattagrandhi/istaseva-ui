// design/api/consents.ts — consent state (consent_records trail).
// Mirror of the web src/domains/legal/legal.service.ts (mobile shares no code
// with web). 'marketing' is the opt-in toggle; 'terms' records acceptance of
// the Terms + Privacy Policy at signup; 'analytics' mirrors the device
// cookie/analytics choice (LEG-014). The server rejects other types.
import { api } from "@/lib/api";

// 'analytics' mirrors the device cookie/analytics choice (LEG-014) into the
// server trail; 'age_confirmation' is the 18+ attestation (LEG-003). Keep in
// lockstep with the server enum (users.controller.ts).
export type ToggleableConsentType = "marketing" | "terms" | "analytics" | "age_confirmation";

export type ConsentState = {
  consentType: string;
  version: string;
  granted: boolean;
  createdAt: string;
};

/** Latest state per consent type for the signed-in user. */
export async function fetchConsents(): Promise<ConsentState[]> {
  const res = await api.get("/api/users/me/consents");
  const rows: any[] = res.data?.data ?? [];
  return rows.map((r) => ({
    consentType: r.consent_type,
    version: r.version,
    granted: !!r.granted,
    createdAt: r.created_at,
  }));
}

/** Latest 'marketing' state, false when never set. */
export async function hasMarketingConsent(): Promise<boolean> {
  try {
    const consents = await fetchConsents();
    return consents.find((c) => c.consentType === "marketing")?.granted ?? false;
  } catch {
    return false;
  }
}

/** Record a grant/withdrawal (appends to the trail; latest row wins). */
export async function setConsent(type: ToggleableConsentType, granted: boolean): Promise<void> {
  await api.put(`/api/users/me/consents/${type}`, { granted });
}
