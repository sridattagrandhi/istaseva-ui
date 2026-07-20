import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { hasTrackingConsent } from "@/lib/tracking-consent";
import { EVENT_CONTRACT_VERSION, type EventName } from "@/lib/analytics-events-contract";
import i18n from "@/i18n";

/**
 * First-party behavioural-event client. Fires the canonical event envelope to
 * `POST /api/analytics/events`, which appends to the `analytics_events`
 * DynamoDB table. Fire-and-forget from the caller's perspective — failures are
 * swallowed so analytics never disrupts the UI.
 *
 * PRIVACY (DPDP): never put PII (names, emails, phone numbers) in `props`.
 *
 * NOTE: this is the Phase-0/1 pipe. Full funnel instrumentation (listing
 * views, clicks, search, booking funnel) lands in the Phase-2 web pass; for now
 * it carries the in-chat `provider_call_clicked` event.
 */
const DEVICE_ID_KEY = "istaseva:analytics:device-id:v1";

function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `d_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return "anonymous-device";
  }
}

// One session id per page-load lifetime.
const sessionId =
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;

const CHANNEL_KEY = "istaseva:acq-channel:v1";

// First-touch acquisition channel for this browser session: utm_source if
// present, else the referring host, else "direct". Persisted so it's stable
// across in-session reloads. Not PII — just where the visit came from.
function computeChannel(): string {
  try {
    const utm = new URLSearchParams(window.location.search).get("utm_source");
    if (utm) return utm.toLowerCase().slice(0, 40);
    const ref = document.referrer;
    if (ref) {
      const host = new URL(ref).hostname.replace(/^www\./, "");
      if (host && host !== window.location.hostname) return host.toLowerCase().slice(0, 40);
    }
    return "direct";
  } catch {
    return "direct";
  }
}
function getChannel(): string {
  try {
    const stored = sessionStorage.getItem(CHANNEL_KEY);
    if (stored) return stored;
    const ch = computeChannel();
    sessionStorage.setItem(CHANNEL_KEY, ch);
    return ch;
  } catch {
    return computeChannel();
  }
}

// Coarse customer origin (city/state strings, never lat/lng), set by
// LocationContext only when the user grants geolocation AND the reverse
// geocode succeeds — the Hampi DEFAULT_LOCATION must never land here (its
// error fallbacks carry isDefault:false, so callers gate on the geocode
// result, not the flag).
let origin: { city: string; state: string } | null = null;

export function setAnalyticsOrigin(city: string, state: string): void {
  if (!city) return;
  origin = { city: city.slice(0, 80), state: (state || "").slice(0, 80) };
}

export interface TrackInput {
  listingId?: string;
  listingType?: "stay" | "service" | "transport";
  category?: string;
  /** Screen/route the event fired from, e.g. "messages_thread". */
  source?: string;
  props?: Record<string, unknown>;
}

export class AnalyticsEventsService {
  /**
   * `event` is a name from the canonical contract (PUX-014) — the typed union
   * catches typos at compile time. The server is authoritative for the per-event
   * version; the client stamps only the taxonomy-wide `contractVersion`.
   */
  track(event: EventName, input: TrackInput = {}): void {
    // CONSENT GATE (LEG-014): no device id is minted and no event leaves the
    // browser until the user allows analytics in the cookie banner.
    if (!hasTrackingConsent()) return;
    const payload = {
      eventType: event,
      contractVersion: EVENT_CONTRACT_VERSION,
      platform: "web",
      channel: getChannel(),
      deviceId: getDeviceId(),
      sessionId,
      clientTs: new Date().toISOString(),
      language: (i18n.language || "en").slice(0, 16),
      ...(origin ? { originCity: origin.city, originState: origin.state } : {}),
      ...(input.listingId ? { listingId: input.listingId } : {}),
      ...(input.listingType ? { listingType: input.listingType } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.props ? { props: input.props } : {}),
    };
    void apiRequest("/api/analytics/events", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({ events: [payload] }),
    }).catch(() => {
      /* analytics is best-effort */
    });
  }
}

let _instance: AnalyticsEventsService | null = null;

export function getAnalyticsEventsService() {
  if (!_instance) _instance = new AnalyticsEventsService();
  return _instance;
}
