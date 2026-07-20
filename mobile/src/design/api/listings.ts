// design/api/listings.ts — Phase 4: real listings read path.
// Fetches GET /api/listings + /:id and maps the snake_case API shape into the
// design's Stay / Service / Transport shapes. Public endpoints (no auth needed).
import { api } from "@/lib/api";
import { Stay, Service, Transport } from "../types";
import { Tone } from "../theme";

export type Catalog = { stays: Stay[]; services: Service[]; transport: Transport[] };

const TONES: Tone[] = ["saffron", "blue", "aubergine", "coral"];
const toneFor = (id: string) => TONES[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % TONES.length];
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const shortLoc = (s?: string) => (s || "").split(",")[0].trim();
// "Area, City" when the backend derived a neighbourhood ("Kukatpally,
// Hyderabad"), else just the city — `area` is null whenever the host stated
// only a city, which is the common case. Deduped because a village geocodes to
// the same name for both ("Tirumala, Tirumala"). Mirrors the server's
// publicLocationLabel and web's placeParts; the card appends the state.
const areaCityLabel = (area?: string, city?: string): string => {
  // shortLoc each part so a null area reproduces the previous
  // `shortLoc(l.city || l.location)` behaviour byte-for-byte.
  const parts = [area, city].map((p) => shortLoc(p)).filter(Boolean);
  return parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i).join(", ");
};
// Best-effort city for the greeting/search-location. Prefers the explicit city
// column; else parses the address (Indian addresses end "…, City, State Pincode"
// — the city is the segment before the state/pincode tail).
function cityFrom(l: ApiListing): string {
  if (l.city && String(l.city).trim()) return String(l.city).trim();
  const parts = String(l.location || l.address || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const beforeLast = parts[parts.length - 2].replace(/\s*\d{5,6}\s*$/, "").trim();
    return beforeLast || parts[parts.length - 1];
  }
  return l.state ? String(l.state).trim() : "";
}
const httpPhotos = (arr: unknown): string[] => (Array.isArray(arr) ? arr.filter((u) => typeof u === "string" && /^https?:/.test(u)) : []);

const SERVICE_ICON: Record<string, string> = {
  salon: "scissors", barber: "scissors", "makeup-artist": "scissors", "salon-at-home": "scissors",
  "massage-spa": "flower", wellness: "flower", yoga: "flower",
  tutor: "grad", "music-teacher": "music", photographer: "camera", videographer: "camera",
  cleaning: "sparkle", plumber: "sparkle", electrician: "sparkle", cook: "utensils",
};
const serviceIcon = (cat?: string) => SERVICE_ICON[cat || ""] || "sparkle";

// Duration parsing mirrors the web's _durationToMinutes: a BARE number is HOURS.
function durationToMin(s?: string): number {
  if (!s || !String(s).trim()) return 60;
  const v = String(s).toLowerCase().trim();
  if (v.includes("half day")) return 240;
  if (v.includes("full day")) return 480;
  const h = v.match(/(\d+(?:\.\d+)?)\s*(?:hr|hrs|hour|hours|h\b)/);
  const m = v.match(/(\d+)\s*(?:min|mins|minute|minutes|m\b)/);
  let total = 0;
  if (h) total += Math.round(parseFloat(h[1]) * 60);
  if (m) total += parseInt(m[1], 10);
  if (!total) { const j = v.match(/^(\d+(?:\.\d+)?)/); if (j) total = Math.round(parseFloat(j[1]) * 60); }
  return total > 0 ? total : 60;
}
function fmtDuration(min: number): string {
  if (min % 60 === 0) return `${min / 60} hr`;
  if (min > 60) return `${(min / 60).toFixed(1)} hr`;
  return `${min} min`;
}
const fmtTime = (mins: number) => { const h = Math.floor(mins / 60), m = mins % 60, ap = h >= 12 ? "PM" : "AM", h12 = ((h + 11) % 12) + 1; return m === 0 ? `${h12}:00 ${ap}` : `${h12}:${String(m).padStart(2, "0")} ${ap}`; };
// Bookable TIME-of-day slots generated from working hours + duration (+ buffer),
// deduped across open days. Empty when no hours are set.
function genTimeSlots(wh: ApiListingMeta["workingHours"], durMin: number, bufMin: number): string[] {
  const set = new Set<number>();
  for (const day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
    const w = wh?.[day];
    if (!Array.isArray(w)) continue;
    const sm = /^(\d{1,2}):(\d{2})/.exec(w[0] || ""); const em = /^(\d{1,2}):(\d{2})/.exec(w[1] || "");
    if (!sm || !em) continue;
    const s = +sm[1] * 60 + +sm[2], e = +em[1] * 60 + +em[2], step = durMin + Math.max(0, bufMin);
    for (let t = s; t + durMin <= e; t += step) set.add(t);
  }
  return [...set].sort((a, b) => a - b).map(fmtTime);
}
const TRANSPORT_LABEL: Record<string, string> = { "driver-cab": "Cab", "driver-auto": "Auto", "driver-van": "Van", "driver-bus": "Bus" };

/** A metadata.servicesCatalog add-on row (`label` from web onboarding, `name` legacy). */
export type ApiAddOnRow = { id?: string; label?: string; name?: string; price?: unknown };
/** A metadata.servicesCatalog group (service variant) row. */
export type ApiCatalogGroup = { id?: string; name?: string; basePrice?: unknown; addOns?: ApiAddOnRow[] };
/** Raw room_types row — base_price_paise is canonical; legacy price keys read via the index. */
export type ApiRoomRow = { id?: string; name?: string; base_price_paise?: number | null; [key: string]: unknown };

/** listings.metadata JSON. Hot keys are typed; everything else stays `unknown`
 *  and is coerced at the use site (num()/String()/Array.isArray guards). */
export interface ApiListingMeta {
  providerName?: string;
  hostName?: string;
  checkInTime?: string;
  checkOutTime?: string;
  duration?: string;
  subcategory?: string;
  subcategories?: string[];
  serviceModes?: string[];
  visitAddress?: string;
  meetingDetails?: string;
  workingHours?: Record<string, [string, string] | null>;
  servicesCatalog?: ApiCatalogGroup[];
  [key: string]: unknown;
}

/** Raw backend listing row (snake_case JSON). Hot fields are typed; everything
 *  else stays `unknown` and is coerced at the use site. */
export interface ApiListing {
  id: string;
  category: string;
  name?: string;
  description?: string;
  property_type?: string;
  location?: string;
  address?: string;
  /** Derived neighbourhood ("Kukatpally"). Null/absent whenever the host
   *  stated only a city — the common case. */
  area?: string;
  city?: string;
  state?: string;
  /** False when the server privacy-approximated this row for the viewer
   *  (unbooked): coords rounded, address nulled, visitAddress withheld. */
  geo_exact?: boolean;
  availability?: string;
  service_area?: string;
  vehicle_name?: string;
  cancellation_policy?: string;
  metadata?: ApiListingMeta;
  room_types?: ApiRoomRow[];
  [key: string]: unknown;
}

export function isApiId(id?: string) {
  return !!id && id.length >= 20 && id.includes("-");
}

// Case-insensitive dedupe + Title Case for language lists. Older listings
// stored BOTH casings ("english" from the agent + "English" from the manual
// form chips), which rendered every language twice on detail pages. New
// extractions are canonicalized server-side; this cleans up existing rows.
function canonLangs(v: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of Array.isArray(v) ? v : []) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const k = raw.trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k.charAt(0).toUpperCase() + k.slice(1));
  }
  return out;
}

// A room type's nightly price in ₹ from the backend row. Rooms store
// base_price_paise (₹×100) — the legacy price_per_night/price keys are
// fallbacks for older rows. NEVER read price_per_night first; it's absent on
// real rooms, which silently yields ₹0.
const roomPrice = (r: ApiRoomRow): number =>
  num(r.base_price_paise != null ? Number(r.base_price_paise) / 100 : (r.price_per_night ?? r.price));

export function mapStay(l: ApiListing): Stay {
  const meta: ApiListingMeta = l.metadata || {};
  const rooms = Array.isArray(l.room_types) ? l.room_types : [];
  const photoUrls = httpPhotos(l.photos);
  // Multi-room stays price per-room (listing-level price is 0) — surface the
  // cheapest room as the "from" price so cards/detail don't show ₹0.
  const roomFrom = rooms.length ? Math.min(...rooms.map(roomPrice)) : 0;
  return {
    id: l.id, title: l.name || "Untitled stay", type: l.property_type || l.category || "Homestay",
    listingKind: rooms.length ? "rooms" : "whole", owner: meta.providerName || meta.hostName || "Host",
    geo: { x: 0.5, y: 0.5 },
    lat: Number.isFinite(Number(l.lat)) ? Number(l.lat) : undefined,
    lng: Number.isFinite(Number(l.lng)) ? Number(l.lng) : undefined,
    city: cityFrom(l),
    location: areaCityLabel(l.area, l.city) || shortLoc(l.location), district: l.state || shortLoc(l.location),
    geoExact: l.geo_exact !== false,
    address: l.address || l.location || "", price: rooms.length ? roomFrom : num(l.price_per_night || l.price), rating: num(l.avg_rating),
    discountPercent: Math.max(0, Math.min(90, num(l.discount_percent))),
    reviews: num(l.review_count), photos: photoUrls.length || 5, photoUrls,
    guests: num(l.max_guests) || 2, rooms: num(l.bedrooms) || 1, beds: num(l.bedrooms) || 1, baths: num(l.bathrooms) || 1,
    tone: toneFor(l.id), hostSince: "", checkIn: meta.checkInTime || "After 1:00 PM", checkOut: meta.checkOutTime || "Before 11:00 AM",
    languages: canonLangs(meta.languages), cancellation: l.cancellation_policy || "Free cancellation up to 24 hours before check-in.",
    tags: meta.subcategories || [], amenities: [], amenityLabels: Array.isArray(l.amenities) ? l.amenities : [],
    verified: true, superhost: false, blurb: (l.description || "").trim(), topReviews: [],
    roomTypes: rooms.length ? rooms.map((r) => ({
      id: r.id,
      name: r.name || "Room", sleeps: num(r.max_guests ?? r.sleeps) || 2, beds: num(r.bedrooms ?? r.beds) || 1, baths: num(r.bathrooms ?? r.baths) || 1,
      price: roomPrice(r), tone: toneFor(r.id || r.name || l.id), amenities: Array.isArray(r.amenities) ? r.amenities : [],
      quantity: num(r.quantity) || 1, photoUrls: httpPhotos(r.photos),
    })) : undefined,
  };
}

export function mapService(l: ApiListing): Service {
  const meta: ApiListingMeta = l.metadata || {};
  const photoUrls = httpPhotos(l.photos);

  // Canonical service catalog → variants, each with its OWN add-ons. Prefer
  // metadata.servicesCatalog; fall back to a single synthetic group from the
  // listing price + flat metadata.addOns (legacy listings). Mirrors the web.
  const mapAddOns = (arr: unknown): { id?: string; name: string; price: number }[] =>
    Array.isArray(arr) ? arr.filter((a) => a && (a.label || a.name)).map((a) => ({ id: a.id ? String(a.id) : undefined, name: a.label || a.name, price: num(a.price) })) : [];
  const catalog = Array.isArray(meta.servicesCatalog)
    ? meta.servicesCatalog.filter((g) => g && typeof g === "object" && String(g.name || "").trim() && num(g.basePrice) > 0)
    : [];
  const variants = catalog.length
    ? catalog.map((g) => ({ id: String(g.id || ""), name: String(g.name), price: num(g.basePrice), addOns: mapAddOns(g.addOns) }))
    : undefined;
  const flatAddOns = mapAddOns(meta.addOns);
  const price = variants ? variants[0].price : num(l.price || l.price_per_night);
  const addOns = variants ? variants[0].addOns : flatAddOns;

  // Real bookable times: curated serviceTimeSlots/slots if set, else generated
  // from working hours + duration, else a sensible default.
  const durMin = durationToMin(meta.duration);
  const curated = (Array.isArray(meta.serviceTimeSlots) && meta.serviceTimeSlots.length ? meta.serviceTimeSlots
    : Array.isArray(meta.slots) && meta.slots.length ? meta.slots : []) as string[];
  const generated = genTimeSlots(meta.workingHours, durMin, num(meta.bufferMinutes));
  // The hardcoded fallback is for MOCK rows only — real listings without
  // parseable working hours must show "no slots" rather than offer times
  // the provider never agreed to (the server would accept the booking).
  const slots = curated.length ? curated : generated.length ? generated : isApiId(String(l.id)) ? [] : ["10:00 AM", "12:00 PM", "4:00 PM"];

  return {
    id: l.id, title: l.name || "Service", provider: meta.providerName || l.name || "Provider", category: (l.category || "Service").replace(/-/g, " "),
    icon: serviceIcon(l.category), mode: meta.serviceModes && meta.serviceModes.length ? meta.serviceModes : ["visit-provider"],
    languages: canonLangs(meta.languages),
    location: shortLoc(l.location), city: cityFrom(l), lat: num(l.lat) || undefined, lng: num(l.lng) || undefined, price, duration: meta.duration ? fmtDuration(durMin) : "60 min",
    rating: num(l.avg_rating), reviews: num(l.review_count), nextSlot: slots[0], tone: toneFor(l.id),
    blurb: (l.description || "").trim(),
    subcategory: (Array.isArray(meta.subcategories) && meta.subcategories.length ? meta.subcategories.join(" · ") : meta.subcategory) || "",
    verified: true, photos: photoUrls.length || 5,
    photoUrls, address: l.location || meta.visitAddress || "", travelKm: num(meta.serviceRadius), onlineNote: meta.meetingDetails || "",
    geoExact: l.geo_exact !== false,
    // Prefer the structured shop/studio address over the coarse listing
    // location — this is what the visit-provider maps link opens.
    visitAddress: meta.visitAddress || l.location || "",
    addOns, variants, slots, topReviews: [],
  };
}

export function mapTransport(l: ApiListing): Transport {
  const meta: ApiListingMeta = l.metadata || {};
  const photoUrls = httpPhotos(l.photos);
  // Package option field names follow the web/onboarding shape: `label`, `stops[].place`,
  // `stops[].dwellMinutes`, `description`, `distanceKm{Min,Max}`. (Older loose shapes —
  // title/name/note/km/dur — are still tolerated as fallbacks.)
  const tours = Array.isArray(meta.packageOptions) ? meta.packageOptions.map((p, i) => ({
    // Server prices package bookings by matching notes.packageId against
    // metadata.packageOptions[].id — carry it through or the booking can't
    // be priced. Id-less rows (AI onboarding saves packages without ids) get
    // the canonical positional id "pkg-<index>" that the server's package
    // matcher resolves; an empty id used to make these rows unbookable.
    id: typeof p.id === "string" ? p.id : `pkg-${i}`,
    name: p.label || p.title || p.name || "Tour",
    hours: num(p.hours) || 4,
    km: p.distanceKmMin && p.distanceKmMax ? `${p.distanceKmMin}–${p.distanceKmMax} km` : (p.km || p.distance || "—"),
    price: num(p.price),
    places: Array.isArray(p.stops) ? (p.stops as { place?: string; name?: string; dwellMinutes?: unknown; dur?: string }[]).map((s) => ({
      name: typeof s === "string" ? s : (s.place || s.name || ""),
      dur: typeof s === "object" && s && s.dwellMinutes ? `${s.dwellMinutes} min` : ((s && s.dur) || ""),
    })) : [],
    note: p.description || p.note || "",
  })) : [];
  // Available booking modes — mirrors the web's availableTransportModes: a mode is
  // offered only when its rate/packages exist (strict meta checks, no price fallback),
  // else fall back to the declared primary mode (transportModes[0] / transportMode), then "day".
  const modes: string[] = [];
  if (tours.length > 0) modes.push("package");
  if (num(meta.pricePerHour) > 0) modes.push("hourly");
  if (num(meta.pricePerDay) > 0) modes.push("day");
  if (modes.length === 0) {
    const declared = (Array.isArray(meta.transportModes) && meta.transportModes[0]) || meta.transportMode;
    modes.push(declared === "hourly" || declared === "day" || declared === "package" ? declared : "day");
  }
  return {
    id: l.id, driver: l.name || "Driver", vehicle: l.vehicle_name || "Vehicle", type: TRANSPORT_LABEL[l.category] || "Cab",
    color: String(meta.vehicleColor || "").trim(), plate: String(meta.licensePlate || "").trim(),
    tone: toneFor(l.id), area: l.service_area || shortLoc(l.location), city: cityFrom(l), lat: num(l.lat) || undefined, lng: num(l.lng) || undefined, perKm: num(meta.pricePerKm), hourly: num(meta.pricePerHour || l.price),
    day: num(meta.pricePerDay), rating: num(l.avg_rating), trips: num(l.review_count), languages: canonLangs(meta.languages),
    seats: num(meta.seatingCapacity) || 4, available: l.availability || "", availabilityNote: "", tours, modes, flexibleHours: !!meta.flexibleHours,
    workingHours: meta.workingHours && typeof meta.workingHours === "object" ? meta.workingHours : {},
    packages: tours.map((t) => t.name), photos: photoUrls.length || 5, photoUrls, reviews: num(l.review_count),
    topReviews: [], blurb: (l.description || "").trim(),
  };
}

/** Services/transport availability window (inclusive calendar days; `end`
 *  null = single day). Serialized as the server's `[from, to)` params. */
export type CatalogDateRange = { start: string | null; end: string | null };

export async function fetchCatalog(opts?: { serviceRange?: CatalogDateRange | null; transportRange?: CatalogDateRange | null }): Promise<Catalog> {
  // A picked window becomes `from`/`to` (to exclusive — inclusive end + 1) so
  // the server applies its ANY-day slot-level availability filter for
  // services/transport (listings with no free slot on any day drop out).
  // Stays never carry a date here.
  const dayRange = (r?: CatalogDateRange | null): Record<string, string> => {
    if (!r?.start) return {};
    const endIncl = r.end ?? r.start;
    const d = new Date(`${endIncl}T00:00:00`);
    d.setDate(d.getDate() + 1);
    const to = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { from: r.start, to };
  };
  // Three per-type fetches (parity with web's per-vertical queries). The old
  // single mixed ?limit=60 pool was 60 rows across ALL verticals ordered by
  // updated_at, so one busy vertical could starve the others down to a
  // handful of rows. Now each vertical gets its own 60-row budget. Still a
  // one-shot fetch — deliberately no pagination on mobile.
  const [staysRes, servicesRes, transportRes] = await Promise.all([
    api.get("/api/listings", { params: { type: "stay", limit: 60 } }),
    api.get("/api/listings", { params: { type: "service", limit: 60, ...dayRange(opts?.serviceRange) } }),
    api.get("/api/listings", { params: { type: "transport", limit: 60, ...dayRange(opts?.transportRange) } }),
  ]);
  const rows = (res: { data?: { data?: ApiListing[]; listings?: ApiListing[] } | ApiListing[] }): ApiListing[] => {
    const d = res.data;
    if (Array.isArray(d)) return d;
    return d?.data ?? d?.listings ?? [];
  };
  const cat: Catalog = { stays: [], services: [], transport: [] };
  for (const l of rows(staysRes)) {
    if (l.is_active === false) continue; // the public list endpoint already scopes visibility
    if (l.listing_type === "stay") cat.stays.push(mapStay(l));
  }
  for (const l of rows(servicesRes)) {
    if (l.is_active === false) continue;
    if (l.listing_type === "service") cat.services.push(mapService(l));
  }
  for (const l of rows(transportRes)) {
    if (l.is_active === false) continue;
    if (l.listing_type === "transport") cat.transport.push(mapTransport(l));
  }
  return cat;
}

/**
 * Server-resolved platform-fee spec for a listing (admin fee-rules panel).
 * The subtotal param is irrelevant for the SPEC (it's subtotal-independent);
 * callers apply it locally via computePlatformFeePaise in ../pricing.
 */
export async function fetchFeeSpec(id: string): Promise<import("../pricing").PlatformFeeSpec | null> {
  const res = await api.get(`/api/listings/${id}/fee-quote?subtotalPaise=0`);
  const spec = res.data?.spec;
  if (!spec || typeof spec.fixedPaise !== "number") return null;
  return spec;
}

export async function fetchListing(id: string, kind: "stay" | "service" | "transport") {
  const res = await api.get(`/api/listings/${id}`);
  const l: ApiListing = res.data?.data ?? res.data;
  if (!l) return null;
  if (kind === "stay") return mapStay(l);
  if (kind === "service") return mapService(l);
  return mapTransport(l);
}
