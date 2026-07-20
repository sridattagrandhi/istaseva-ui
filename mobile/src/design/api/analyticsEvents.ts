// design/api/analyticsEvents.ts — first-party behavioural-event client.
//
// Mobile mirror of the web `src/domains/analytics/events.service.ts`. Fires the
// canonical event envelope to POST /api/analytics/events, which appends to the
// `analytics_events` DynamoDB table. Fire-and-forget: failures are swallowed so
// analytics never disrupts the UI. optionalAuth on the endpoint means the axios
// client's token injection captures the userId when signed in, and the
// device-scoped id keeps anonymous sessions coherent.
//
// PRIVACY (DPDP): never put PII (names, emails, phone numbers) in `props`.
//
// NOTE: this is the Phase-0/1 pipe. Full funnel instrumentation lands in the
// Phase-3 mobile pass; for now it carries the in-chat `provider_call_clicked`
// event.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "@/lib/api";
import { EVENT_CONTRACT_VERSION, type EventName } from "./analyticsEventsContract";
import i18n from "@/i18n";

const DEVICE_ID_KEY = "istaseva:analytics:device-id:v1";
const TRACKING_CONSENT_KEY = "istaseva:tracking-consent:v1";
const TRACKING_CONSENT_VERSION_KEY = "istaseva:tracking-consent-version:v1";

/**
 * Which analytics/cookie disclosure the stored choice was made against.
 * MIRROR of the server's ANALYTICS_CONSENT_VERSION in
 * server/src/modules/users/legal-docs-version.ts (and the web copy in
 * src/lib/tracking-consent.ts) — a parity test keeps the three in lockstep.
 * A choice recorded under an older version reads as not-granted, so a bump
 * suppresses tracking until the user re-enables the toggle (mobile has no
 * banner to re-prompt with — Privacy & safety is the recovery path).
 */
export const ANALYTICS_CONSENT_VERSION = "1.0.0";

// Choices stored before versioning shipped have no version key; they were
// made against 1.0.0, so they grandfather to that LITERAL (not "current").
const GRANDFATHERED_VERSION = "1.0.0";

let cachedDeviceId: string | null = null;
let cachedConsent: boolean | null = null;

/**
 * Device-analytics consent (LEG-014, mirror of web src/lib/tracking-consent.ts).
 * OPT-IN: nothing is tracked and no device id is minted until the user
 * enables "Usage analytics" in Privacy & safety. Withdrawing also drops the
 * device id so a later grant starts a fresh identity.
 */
export async function hasAnalyticsConsent(): Promise<boolean> {
  if (cachedConsent !== null) return cachedConsent;
  try {
    const granted = (await AsyncStorage.getItem(TRACKING_CONSENT_KEY)) === "granted";
    const chosenAt =
      (await AsyncStorage.getItem(TRACKING_CONSENT_VERSION_KEY)) ?? GRANDFATHERED_VERSION;
    // Stale disclosure version → treat as withdrawn until re-enabled.
    cachedConsent = granted && chosenAt === ANALYTICS_CONSENT_VERSION;
  } catch {
    cachedConsent = false;
  }
  return cachedConsent;
}

export async function setAnalyticsConsent(granted: boolean): Promise<void> {
  cachedConsent = granted;
  try {
    await AsyncStorage.setItem(TRACKING_CONSENT_KEY, granted ? "granted" : "denied");
    await AsyncStorage.setItem(TRACKING_CONSENT_VERSION_KEY, ANALYTICS_CONSENT_VERSION);
    if (!granted) {
      cachedDeviceId = null;
      await AsyncStorage.removeItem(DEVICE_ID_KEY);
    }
  } catch {
    /* non-fatal — consent stays cached in memory for this session */
  }
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = randomId("d");
      await AsyncStorage.setItem(DEVICE_ID_KEY, id);
    }
    cachedDeviceId = id;
    return id;
  } catch {
    cachedDeviceId = "anonymous-device";
    return cachedDeviceId;
  }
}

// One session id per app-process lifetime.
const sessionId = randomId("s");

// Coarse customer origin (city/state strings, never lat/lng). Set by
// ExploreScreen only after the user grants location AND reverseGeocodeAsync
// resolves — never from a default/fallback position. Mirrors the web
// setAnalyticsOrigin in src/domains/analytics/events.service.ts.
let origin: { city: string; state: string } | null = null;

export function setAnalyticsOrigin(city: string, state: string): void {
  if (!city) return;
  origin = { city: city.slice(0, 80), state: (state || "").slice(0, 80) };
}

export type TrackInput = {
  listingId?: string;
  listingType?: "stay" | "service" | "transport";
  category?: string;
  /** Screen the event fired from, e.g. "thread". */
  source?: string;
  props?: Record<string, unknown>;
};

/**
 * Best-effort POST /api/analytics/events. `event` is a name from the canonical
 * contract (PUX-014) — the typed union catches typos at compile time. The server
 * is authoritative for the per-event version; the client stamps only the
 * taxonomy-wide `contractVersion`. Never throws.
 */
export async function track(event: EventName, input: TrackInput = {}): Promise<void> {
  try {
    // CONSENT GATE (LEG-014): opt-in only — no device id, no event otherwise.
    if (!(await hasAnalyticsConsent())) return;
    const deviceId = await getDeviceId();
    await api.post("/api/analytics/events", {
      events: [
        {
          eventType: event,
          contractVersion: EVENT_CONTRACT_VERSION,
          platform: "mobile",
          // Native installs don't carry a web referrer; full store/deep-link
          // attribution is a separate integration, so tag these as "app".
          channel: "app",
          deviceId,
          sessionId,
          clientTs: new Date().toISOString(),
          language: (i18n.language || "en").slice(0, 16),
          ...(origin ? { originCity: origin.city, originState: origin.state } : {}),
          ...(input.listingId ? { listingId: input.listingId } : {}),
          ...(input.listingType ? { listingType: input.listingType } : {}),
          ...(input.category ? { category: input.category } : {}),
          ...(input.source ? { source: input.source } : {}),
          ...(input.props ? { props: input.props } : {}),
        },
      ],
    });
  } catch {
    // analytics is non-blocking — ignore network/auth failures.
  }
}
