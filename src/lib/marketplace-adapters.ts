import type { Booking } from "@/types/domain";
import type {
  Service,
  ServiceMode,
  Stay,
  TransportMode,
  TransportPackageOption,
  TransportProvider,
} from "@/types/listings";
import type {
  MarketplaceRoomType,
  MarketplaceService,
  MarketplaceStay,
  MarketplaceTransport,
} from "@/types/marketplace";
import { serviceCategories } from "@/data/listing-taxonomy";
import { normalizeTransportationTypes, getTransportTypeLabel } from "./transport-types";
import {
  Sparkles,
  Zap,
  Wrench,
  Hammer,
  Fan,
  Home as HomeIcon,
  Building,
  Bath,
  Siren,
  type LucideIcon,
} from "lucide-react";

/** Map the string icon name persisted in `metadata.icon` / taxonomy to a
 *  concrete LucideIcon component. Falls back to `Sparkles` so the detail
 *  page never renders a broken icon. */
const ICON_REGISTRY: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  zap: Zap,
  wrench: Wrench,
  hammer: Hammer,
  fan: Fan,
  home: HomeIcon,
  building: Building,
  bath: Bath,
  siren: Siren,
};

function resolveIcon(name: unknown): LucideIcon {
  if (typeof name !== "string") return Sparkles;
  return ICON_REGISTRY[name.toLowerCase()] ?? Sparkles;
}

const SERVICE_MODE_VALUES: ServiceMode[] = ["at-home", "visit-provider", "online"];
const TRANSPORT_MODE_VALUES: TransportMode[] = ["point", "hourly", "day", "package"];

/** Coerce arbitrary metadata into a clean `ServiceMode[]`. Accepts arrays,
 *  comma-separated strings ("at-home, online"), or single strings. Unknown
 *  values are dropped. Returns [] when nothing recognisable is present so
 *  callers can apply their own fallback. */
function parseServiceModes(value: unknown): ServiceMode[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const out: ServiceMode[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const normalized = item.trim().toLowerCase().replace(/_/g, "-");
    if ((SERVICE_MODE_VALUES as string[]).includes(normalized)) {
      const mode = normalized as ServiceMode;
      if (!out.includes(mode)) out.push(mode);
    }
  }
  return out;
}

function parseTransportMode(value: unknown): TransportMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (TRANSPORT_MODE_VALUES as string[]).includes(normalized)
    ? (normalized as TransportMode)
    : undefined;
}

/** Parse a metadata `packageOptions` array. Tolerates loose shapes (string
 *  prices like "₹3500", missing ids) so listings authored by the chat agent
 *  or a partial form still render. Drops anything without at least a label. */
function parsePackageOptions(value: unknown): TransportPackageOption[] {
  if (!Array.isArray(value)) return [];
  const out: TransportPackageOption[] = [];
  for (const [rawIdx, item] of value.entries()) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const label = typeof obj.label === "string"
      ? obj.label
      : typeof obj.name === "string"
        ? obj.name
        : "";
    if (!label.trim()) continue;
    // Id-less rows (AI onboarding saves packages without ids) get the
    // canonical positional id "pkg-<raw index>" — the SAME id the server's
    // subtotalForTransportPackagePaise / matchPackageId resolve, so bookings
    // of these rows actually price. Must be 0-based on the RAW array index.
    const id = typeof obj.id === "string" && obj.id.trim() ? obj.id : `pkg-${rawIdx}`;
    // Stops: tolerate both legacy `string[]` and the current
    // `{ place, dwellMinutes? }[]` shape so older listings keep rendering.
    let stops: TransportPackageOption["stops"];
    if (Array.isArray(obj.stops)) {
      stops = obj.stops
        .map((raw): { place: string; dwellMinutes?: number } | null => {
          if (typeof raw === "string") {
            const place = raw.trim();
            return place ? { place } : null;
          }
          if (raw && typeof raw === "object") {
            const r = raw as Record<string, unknown>;
            const place = typeof r.place === "string" ? r.place.trim() : "";
            if (!place) return null;
            const dwell = Number(r.dwellMinutes);
            return Number.isFinite(dwell) && dwell > 0
              ? { place, dwellMinutes: Math.round(dwell) }
              : { place };
          }
          return null;
        })
        .filter((s): s is { place: string; dwellMinutes?: number } => !!s);
      if (stops.length === 0) stops = undefined;
    }
    const distanceKmMin = toNumber(obj.distanceKmMin, 0);
    const distanceKmMax = toNumber(obj.distanceKmMax, 0);
    const languages = Array.isArray(obj.languages)
      ? toArray(obj.languages).filter((s) => s.trim().length > 0)
      : undefined;
    out.push({
      id,
      label: label.trim(),
      price: extractPrice(obj.price, 0),
      hours: toNumber(obj.hours, 0),
      description: typeof obj.description === "string" ? obj.description : undefined,
      stops,
      ...(distanceKmMin > 0 ? { distanceKmMin } : {}),
      ...(distanceKmMax > 0 ? { distanceKmMax } : {}),
      ...(languages && languages.length > 0 ? { languages } : {}),
      includes: Array.isArray(obj.includes) ? toArray(obj.includes) : undefined,
    });
  }
  return out;
}

// Local placeholder used ONLY when a backend listing has no image at all.
// We deliberately avoid Unsplash fallbacks so real (unphotographed) listings
// can't masquerade as polished demo content — an obvious placeholder
// nudges hosts to upload photos. Lives in /public so the bundle stays lean.
const FALLBACK_STAY_IMAGE = "/placeholder.svg";

type ListingRow = Record<string, any>;

const stayTypes = new Set(["hotel", "homestay", "lodge", "village-stay", "farm-stay", "heritage", "sathram", "stay"]);
const transportTypes = new Set(["auto", "cab", "van", "bike", "tempo", "driver-auto", "driver-cab"]);

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Parse lat/lng — returns undefined for null/missing/0/invalid so markers with bad coords can be filtered out */
function toCoord(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed === 0) return undefined;
  return parsed;
}

/** Extract numeric price from values like "200", "200 rupees per hour", "₹500/visit" */
function extractPrice(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return fallback;
  const match = value.replace(/[₹,]/g, "").match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : fallback;
}

/** Extract pricing unit from values like "200 rupees per hour", "500/visit" */
function extractPricingUnit(price: unknown, metadata: Record<string, any>): string {
  if (metadata.pricingUnit) return metadata.pricingUnit;
  if (typeof price !== "string") return "";
  const lower = price.toLowerCase();
  if (lower.includes("per hour") || lower.includes("/hour") || lower.includes("/hr")) return "per_hour";
  if (lower.includes("per visit") || lower.includes("/visit")) return "per_visit";
  if (lower.includes("per day") || lower.includes("/day")) return "per_day";
  if (lower.includes("per night") || lower.includes("/night")) return "per_night";
  if (lower.includes("per session") || lower.includes("/session")) return "per_session";
  if (lower.includes("fixed") || lower.includes("flat")) return "fixed";
  return "";
}

/** Parse duration text like "1-2 hours", "30 mins", "2 hours" to min/max minutes */
function parseDurationMinutes(duration: string): { min: number; max: number } {
  if (!duration) return { min: 60, max: 60 };
  const lower = duration.toLowerCase().trim();
  // "1-2 hours"
  const rangeHours = lower.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/);
  if (rangeHours) return { min: Math.round(parseFloat(rangeHours[1]) * 60), max: Math.round(parseFloat(rangeHours[2]) * 60) };
  // "30-60 mins"
  const rangeMins = lower.match(/(\d+)\s*-\s*(\d+)\s*(?:mins?|minutes?)/);
  if (rangeMins) return { min: parseInt(rangeMins[1]), max: parseInt(rangeMins[2]) };
  // "2 hours"
  const singleHours = lower.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/);
  if (singleHours) return { min: Math.round(parseFloat(singleHours[1]) * 60), max: Math.round(parseFloat(singleHours[1]) * 60) };
  // "30 mins"
  const singleMins = lower.match(/(\d+)\s*(?:mins?|minutes?)/);
  if (singleMins) return { min: parseInt(singleMins[1]), max: parseInt(singleMins[1]) };
  // "half day"
  if (lower.includes("half day")) return { min: 240, max: 240 };
  // "full day"
  if (lower.includes("full day")) return { min: 480, max: 480 };
  return { min: 60, max: 60 };
}

function toArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toObject<T extends Record<string, any>>(value: unknown, fallback: T): T {
  return value && typeof value === "object" ? { ...fallback, ...(value as T) } : fallback;
}

/** "Hosting since" label derived from real data only — never invents a year.
 *  Resolution order: (1) onboarding-captured value if it looks like a real
 *  date or "Month Year", (2) the user's join date passed through from the
 *  backend if it joins users, (3) the listing's `created_at`. Returns "" when
 *  nothing usable exists so the UI hides the chip. */
function formatHostSince(metaSince: unknown, userCreatedAt: unknown, listingCreatedAt: unknown): string {
  const pretty = (d: Date) =>
    d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  if (typeof metaSince === "string" && metaSince.trim()) {
    const trimmed = metaSince.trim();
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return pretty(parsed);
    // Already formatted like "April 2024" — keep as-is rather than
    // reformatting and risking a parse mismatch.
    return trimmed;
  }
  for (const candidate of [userCreatedAt, listingCreatedAt]) {
    if (!candidate) continue;
    const d = new Date(candidate as any);
    if (!Number.isNaN(d.getTime())) return pretty(d);
  }
  return "";
}

// Parse a free-text duration ("1 hour", "30 min") to minutes. Mirrors
// OnboardingForm's durationToMinutes — kept local so adapters don't depend on
// the form module.
function durationStrToMinutes(value: string | undefined): number {
  if (!value) return 60;
  const v = value.toLowerCase().trim();
  if (v.includes("half day")) return 240;
  if (v.includes("full day")) return 480;
  const hours = v.match(/(\d+(?:\.\d+)?)\s*(?:hr|hour|h\b)/);
  const mins = v.match(/(\d+)\s*(?:min|m\b)/);
  let total = 0;
  if (hours) total += Math.round(Number(hours[1]) * 60);
  if (mins) total += Number(mins[1]);
  if (!total) {
    const just = v.match(/^(\d+(?:\.\d+)?)/);
    if (just) total = Math.round(Number(just[1]) * 60);
  }
  return total > 0 ? total : 60;
}

const DAY_LABEL_FULL_ADAPTER: Record<string, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};

function fmtTime12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

/**
 * Derive bookable slot labels from a workingHours JSON ({ mon: [start,end] | null, ... }),
 * a duration string, and an optional buffer in minutes. Mirrors the onboarding
 * form's slot generator so the customer booking view stays consistent with
 * what the provider configures. Next-slot stride = duration + max(0, buffer);
 * a slot still emits as long as start+duration fits the day window.
 */
export function deriveSlotsFromWorkingHours(
  workingHours: any,
  duration: string | undefined,
  bufferMin: number = 15,
): string[] {
  if (!workingHours || typeof workingHours !== "object") return [];
  const durationMin = durationStrToMinutes(duration);
  const stride = durationMin + Math.max(0, bufferMin);
  const slots: string[] = [];
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  for (const day of days) {
    const window = workingHours[day];
    if (!Array.isArray(window) || window.length !== 2) continue;
    const [start, end] = window;
    if (typeof start !== "string" || typeof end !== "string") continue;
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    if (Number.isNaN(sh) || Number.isNaN(eh)) continue;
    let cur = sh * 60 + (sm || 0);
    const stop = eh * 60 + (em || 0);
    while (cur + durationMin <= stop) {
      const h = Math.floor(cur / 60);
      const m = cur % 60;
      slots.push(`${DAY_LABEL_FULL_ADAPTER[day]} ${fmtTime12(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`)}`);
      cur += stride;
    }
  }
  return slots;
}

function getServiceCategoryMeta(category: string) {
  return serviceCategories.find((item) => item.name === category);
}

/**
 * Deduped place label parts. The server's public `location` is built from
 * area/city/state ("Kukatpally, Hyderabad, Telangana" — WS6 geo privacy),
 * while `district` defaults to the city — so the long-standing
 * "{{location}}, {{district}}" compositions rendered a trailing duplicate
 * ("City, State, City").
 *
 * Dedup is by comma SEGMENT, not by prefix: the label carries two parts or
 * three depending on whether the host's stated location was precise enough to
 * derive an area, and a prefix check ("does location start with district?")
 * only ever worked for the two-part case — it silently fails the moment an
 * area is prepended, putting the duplicate city back.
 */
export function placeParts(location?: string | null, district?: string | null): { location: string; district: string } {
  const segments = [...String(location ?? "").split(","), ...String(district ?? "").split(",")]
    .map((segment) => segment.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const unique = segments.filter((segment) => {
    const key = segment.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // First segment fills the {{location}} slot, everything else the {{district}}
  // slot, so the existing two-slot templates compose the full label.
  return { location: unique[0] ?? "", district: unique.slice(1).join(", ") };
}

/** One-line place label: the deduped parts joined, skipping empties. */
export function placeLine(location?: string | null, district?: string | null): string {
  const p = placeParts(location, district);
  return [p.location, p.district].filter(Boolean).join(", ");
}

export function inferListingType(row: ListingRow): "stay" | "service" | "transport" {
  // listing_type column is the authoritative source — backed by a CHECK
  // constraint on the DB. Fall through only when it's missing (older rows
  // pre-backfill, or call sites that didn't select the column).
  const typed = row.listing_type;
  if (typed === "stay" || typed === "service" || typed === "transport") return typed;
  const metadataType = row.metadata?.listingType || row.metadata?.type;
  if (metadataType === "stay" || metadataType === "service" || metadataType === "transport") return metadataType;
  const cat = String(row.category || "");
  if (row.vehicle_name || transportTypes.has(cat)) return "transport";
  if (row.property_type || row.price_per_night || stayTypes.has(cat) || cat.startsWith("stay:")) return "stay";
  return "service";
}

export function mapListingToStay(row: ListingRow): Stay {
  const metadata = toObject(row.metadata, {});
  const title = row.title || row.name || "Untitled stay";
  const city = row.city || metadata.city || "India";
  const state = row.state || metadata.state || "India";
  const images = toArray(row.images).length > 0 ? toArray(row.images) : toArray(row.photos);

  return {
    id: row.id,
    userId: row.user_id,
    providerProfileId: row.provider_profile_id,
    title,
    location: row.location || `${city}, ${state}`,
    state,
    district: metadata.district || city,
    price: extractPrice(row.price_per_night ?? row.price),
    discountPercent: toNumber(row.discount_percent, 0),
    rating: toNumber(row.avg_rating, 0),
    reviews: toNumber(row.review_count, 0),
    image: row.image_url || images[0] || "",
    photos: images,
    type: (row.property_type || String(row.category || "hotel").replace(/^stay:/, "")) as Stay["type"],
    tags: toArray(metadata.tags),
    amenities: toArray(row.amenities),
    host: toObject(metadata.host, {
      id: row.user_id,
      name: metadata.providerName || metadata.hostName || "Host",
      image: "",
      since: metadata.hostSince || "2024",
      responseRate: metadata.responseRate || "",
    }),
    description: row.description || "",
    rooms: toNumber(row.bedrooms, 1),
    guests: toNumber(row.max_guests, 2),
    languages: toArray(metadata.languages).length > 0 ? toArray(metadata.languages) : ["English", "Hindi"],
    verified: Boolean(metadata.verified ?? false),
    houseRules: toArray(metadata.houseRules),
    lat: toCoord(row.lat),
    lng: toCoord(row.lng),
    locality: metadata.locality || city,
    nearbyTags: toArray(metadata.nearbyTags),
    metadata,
    roomTypes: Array.isArray((row as any).room_types)
      ? (row as any).room_types.map((r: any) => ({
          id: String(r.id),
          listingId: String(r.listing_id),
          name: String(r.name),
          description: r.description ?? null,
          basePricePaise: Number(r.base_price_paise) || 0,
          maxGuests: Number(r.max_guests) || 1,
          quantity: Number(r.quantity) || 1,
          bedrooms: Number.isFinite(Number(r.bedrooms)) ? Number(r.bedrooms) : undefined,
          bathrooms: Number.isFinite(Number(r.bathrooms)) ? Number(r.bathrooms) : undefined,
          unitIdentifiers: Array.isArray(r.unit_identifiers) ? r.unit_identifiers.map(String) : undefined,
          photos: Array.isArray(r.photos) ? r.photos : [],
          sortOrder: Number(r.sort_order) || 0,
        }))
      : undefined,
  };
}

/**
 * Map a raw backend listing row to the redesigned-marketplace `MarketplaceStay`
 * contract. Distinct from `mapListingToStay` (legacy `Stay` shape) so the
 * redesign UI stays decoupled from the backend's row shape.
 *
 * Currency rules:
 *  - Backend `price_per_night` is stored as rupees (integer).
 *  - Backend room_types[].base_price_paise is stored as paise — divide by 100
 *    to surface a rupees-per-night `price` to the UI.
 */
export function mapListingRowToMarketplaceStay(row: ListingRow): MarketplaceStay {
  const metadata = toObject(row.metadata, {});
  const title = row.title || row.name || "Untitled stay";
  const city = row.city || metadata.city || "India";
  const state = row.state || metadata.state || "";
  const images = toArray(row.images).length > 0 ? toArray(row.images) : toArray(row.photos);
  const heroImage = row.image_url || images[0] || FALLBACK_STAY_IMAGE;

  const rawRoomTypes = Array.isArray((row as any).room_types) ? (row as any).room_types : [];
  const roomTypes: MarketplaceRoomType[] | undefined = rawRoomTypes.length
    ? rawRoomTypes
        .map((r: any) => {
          const pricePaise = Number(r.base_price_paise) || 0;
          const photos = Array.isArray(r.photos) ? r.photos.filter((x: any) => typeof x === "string") : [];
          return {
            id: String(r.id),
            name: String(r.name || "Room"),
            description: r.description ?? undefined,
            price: Math.round(pricePaise / 100),
            sleeps: Number(r.max_guests) || 1,
            bedrooms: Number(r.bedrooms) || 1,
            bathrooms: Number(r.bathrooms) || 1,
            amenities: Array.isArray(r.amenities)
              ? r.amenities.filter((x: any) => typeof x === "string")
              : undefined,
            image: photos[0] || undefined,
            quantity: Number.isFinite(Number(r.quantity)) && Number(r.quantity) > 0
              ? Math.round(Number(r.quantity))
              : 1,
          } satisfies MarketplaceRoomType;
        })
        .sort((a: MarketplaceRoomType, b: MarketplaceRoomType) => a.price - b.price)
    : undefined;

  // "From" price — cheapest room beats listing-level price (matches map markers).
  const listingLevelPrice = extractPrice(row.price_per_night ?? row.price);
  const fromPrice = roomTypes && roomTypes.length > 0
    ? roomTypes[0].price
    : listingLevelPrice;

  const discountPercent = toNumber(row.discount_percent, 0);
  const originalPrice = discountPercent > 0 && fromPrice > 0
    ? Math.round(fromPrice / (1 - discountPercent / 100))
    : undefined;

  const cancellation: MarketplaceStay["cancellation"] =
    metadata.cancellation === "moderate" || metadata.cancellation === "strict"
      ? metadata.cancellation
      : "flexible";

  return {
    id: String(row.id),
    title,
    type: String(row.property_type || metadata.propertyType || "Stay"),
    owner: String(metadata.providerName || metadata.hostName || row.provider_name || "Host"),
    location: row.location || (state ? `${city}, ${state}` : city),
    district: String(metadata.district || row.city || city),
    city: row.city ? String(row.city) : undefined,
    price: fromPrice,
    originalPrice,
    // Forward the host-level discount to the booking modal. The backend's
    // `subtotalForStayPaise` will multiply each night by (1 - pct/100) when
    // computing the authoritative subtotal, so the modal's preview must do
    // the same to avoid `agreedPrice` drift > ₹2.
    discountPercent: discountPercent > 0 ? discountPercent : undefined,
    rating: toNumber(row.avg_rating, 0),
    reviews: toNumber(row.review_count, 0),
    guests: toNumber(row.max_guests, 2),
    rooms: roomTypes ? roomTypes.length : toNumber(row.bedrooms, 1),
    image: heroImage,
    images: images.length > 0 ? images : [heroImage],
    tags: toArray(metadata.tags),
    verified: Boolean(metadata.verified ?? false),
    amenities: toArray(row.amenities),
    cancellation,
    description: row.description || "",
    lat: toCoord(row.lat),
    lng: toCoord(row.lng),
    // Server sends geo_exact:false with approximate coords when the viewer
    // hasn't booked (B1). Default true for legacy/mock rows with no flag.
    geoExact: row.geo_exact !== false,
    bedrooms: Number.isFinite(Number(row.bedrooms)) ? Number(row.bedrooms) : undefined,
    bathrooms: Number.isFinite(Number(row.bathrooms)) ? Number(row.bathrooms) : undefined,
    roomTypes,
    hostMeta: {
      // "Hosting since" uses, in priority order, the host's onboarding-
      // captured month (metadata.hostSince), the user's join date (when the
      // backend surfaces it), or the listing's first-publish date. We do
      // NOT default to a hard-coded year — that just lies to guests. An
      // empty string here causes the UI to hide the chip.
      since: formatHostSince(metadata.hostSince, (row as any).user_created_at, row.created_at),
      responsiveness: metadata.responseTime || metadata.responsiveness || undefined,
      languages: toArray(metadata.languages),
    },
    // Forward backend foreign-key + listing-configured times so the redesign
    // can match the old stay BookingModal payload shape exactly (which sends
    // providerId + listingId, plus metadata.checkInTime / .checkOutTime
    // fallbacks).
    //
    // IMPORTANT: only surface `provider_profile_id`. Do NOT fall back to
    // `user_id` — those are two different tables. The `bookings.provider_id`
    // column FKs to `provider_profiles.id`, so passing a `users.id` here
    // raises an FK violation inside the createHold transaction (which then
    // surfaces as the Postgres "current transaction is aborted" cascade).
    // The old `mapListingToStay` (`Stay` shape) sets the same field with
    // no fallback — match that exactly. When this is undefined the backend
    // resolves the provider from `listingId` on its own.
    providerProfileId: row.provider_profile_id ? String(row.provider_profile_id) : undefined,
    checkInTime: typeof metadata.checkInTime === "string" ? metadata.checkInTime : undefined,
    checkOutTime: typeof metadata.checkOutTime === "string" ? metadata.checkOutTime : undefined,
  };
}

export function mapListingToService(row: ListingRow): Service {
  const metadata = toObject(row.metadata, {});
  const category = row.category || metadata.category || "General Helper";
  const categoryMeta = getServiceCategoryMeta(category);
  const durationText = metadata.duration || "";
  const durationParsed = parseDurationMinutes(durationText);
  const pricingUnit = extractPricingUnit(row.price, metadata);
  // Prefer the structured `metadata.serviceModes` array written by the
  // mode-aware onboarding flow. Old listings predate it and fall back to
  // "at-home" — historically every service was treated as provider-travels-
  // to-customer, so that's the safest default for unmigrated rows.
  const serviceModes = (() => {
    const parsed = parseServiceModes(metadata.serviceModes ?? metadata.serviceMode);
    return parsed.length > 0 ? parsed : (["at-home"] as ServiceMode[]);
  })();

  return {
    id: row.id,
    userId: row.user_id,
    providerProfileId: row.provider_profile_id,
    title: row.title || row.name || category,
    category,
    // Custom services (category not in the preset list) keep their own slug
    // as the displayed subcategory so cards and filter chips read the same.
    // Without this, anything custom collapsed to "Freelancers" and the
    // filter never matched its own chip.
    subcategory: metadata.subcategory
      || categoryMeta?.subcategory
      || (category && !categoryMeta ? category : "Freelancers"),
    icon: metadata.icon || categoryMeta?.icon || "sparkles",
    serviceModes,
    price: extractPrice(row.price),
    rating: toNumber(row.avg_rating, 0),
    reviews: toNumber(row.review_count, 0),
    provider: toObject(metadata.provider, {
      id: row.provider_profile_id || row.user_id,
      name: metadata.providerName || row.name || "Provider",
      image: "",
      experience: metadata.experience || "",
      jobs: toNumber(metadata.jobs, 0),
      languages: toArray(metadata.languages).length > 0 ? toArray(metadata.languages) : ["English", "Hindi"],
      verified: Boolean(metadata.verified ?? false),
      responseTime: metadata.responseTime || "",
    }),
    description: row.description || "",
    availability: row.availability || metadata.availability || "",
    area: row.location || row.service_area || metadata.area || "Local area",
    duration: durationText,
    lat: toCoord(row.lat),
    lng: toCoord(row.lng),
    locality: metadata.locality || row.city || "Local area",
    serviceRadius: toNumber(metadata.serviceRadius, 10),
    metadata: {
      ...metadata,
      pricingUnit,
      durationMinutes: durationParsed,
    },
  };
}

export function mapListingToTransport(row: ListingRow): TransportProvider {
  const metadata = toObject(row.metadata, {});

  // Pricing on transport listings can arrive in a few shapes depending on
  // how the driver was onboarded — `metadata.pricePerKm` is preferred, with
  // legacy free-text `price` ("₹5/km" or a bare number) as a fallback.
  // Defaults to ₹10/km when nothing parseable is present.
  const priceText = String(row.price ?? "").trim();
  const priceNumber = (() => {
    const m = priceText.match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
  })();
  const isPerKmString = /\/\s*km|per\s*km/i.test(priceText);
  const isPerHourString = /\/\s*h(?:r|our)?\b|per\s*h(?:r|our)?/i.test(priceText);

  const pricePerKmFromMeta = toNumber(metadata.pricePerKm, NaN);
  const pricePerHourFromMeta = toNumber(metadata.pricePerHour, NaN);
  const pricePerKm = Number.isFinite(pricePerKmFromMeta) && pricePerKmFromMeta > 0
    ? pricePerKmFromMeta
    : isPerKmString && priceNumber != null ? priceNumber : 0;
  const pricePerHour = Number.isFinite(pricePerHourFromMeta) && pricePerHourFromMeta > 0
    ? pricePerHourFromMeta
    : isPerHourString && priceNumber != null ? priceNumber : 0;

  const pricePerDayFromMeta = toNumber(metadata.pricePerDay, NaN);
  const pricePerDay = Number.isFinite(pricePerDayFromMeta) && pricePerDayFromMeta > 0
    ? pricePerDayFromMeta
    : 0;

  const packageOptions = parsePackageOptions(metadata.packageOptions);

  // Resolve the listing's offering mode. Prefer the structured field; otherwise
  // infer from which pricing/packages are populated. Listings authored before
  // mode-aware onboarding default to "point" — the legacy per-km prebook flow
  // they already used.
  const transportMode: TransportMode = parseTransportMode(metadata.transportMode)
    ?? (packageOptions.length > 0
        ? "package"
        : pricePerDay > 0
          ? "day"
          : pricePerHour > 0
            ? "hourly"
            : "point");

  return {
    id: row.id,
    userId: row.user_id,
    providerProfileId: row.provider_profile_id,
    name: row.name || row.title || "Local Driver",
    type: (metadata.transportType || row.category || "cab") as TransportProvider["type"],
    vehicleName: row.vehicle_name || "Vehicle",
    photo: row.image_url || "",
    rating: toNumber(row.avg_rating, 0),
    reviews: toNumber(row.review_count, 0),
    trips: toNumber(metadata.trips, 0),
    pricePerKm,
    pricePerHour,
    pricePerDay,
    transportMode,
    packageOptions,
    languages: toArray(metadata.languages).length > 0 ? toArray(metadata.languages) : ["English", "Hindi"],
    verified: Boolean(metadata.verified ?? false),
    available: Boolean(metadata.available ?? true),
    responseTime: metadata.responseTime || "",
    serviceArea: row.service_area || row.location || "Local area",
    specialties: toArray(metadata.specialties),
    lat: toCoord(row.lat),
    lng: toCoord(row.lng),
    locality: metadata.locality || row.city || "Local area",
    district: metadata.district || row.city || "Local district",
    state: row.state || metadata.state || "India",
    metadata,
  };
}

export function mapBookingToGuestStayBooking(booking: Booking) {
  // scheduledDate may arrive as "2026-04-17" or as an ISO string "2026-04-17T00:00:00.000Z"
  const dateOnly = typeof booking.scheduledDate === "string" && booking.scheduledDate.includes("T")
    ? booking.scheduledDate.split("T")[0]
    : booking.scheduledDate;
  const checkOutDate = new Date(`${dateOnly}T00:00:00`);
  checkOutDate.setDate(checkOutDate.getDate() + 1);

  return {
    stayId: booking.providerId,
    checkIn: dateOnly,
    checkOut: checkOutDate.toISOString().slice(0, 10),
    status: booking.status,
    guests: Number(/"guests":(\d+)/.exec(booking.notes || "")?.[1] || 1),
    total: 0,
  };
}

export function mapBookingToGuestServiceBooking(booking: Booking) {
  return {
    serviceId: booking.providerId,
    date: booking.scheduledDate,
    time: booking.startTime,
    status: booking.status,
    total: 0,
  };
}

// See note on FALLBACK_STAY_IMAGE — we use a local placeholder rather than
// stock photos so backend listings without images render an obvious gap.
const FALLBACK_SERVICE_IMAGE = "/placeholder.svg";
const FALLBACK_TRANSPORT_IMAGE = "/placeholder.svg";

/**
 * Map a backend listing row to the redesigned-marketplace `MarketplaceService`
 * contract. Reads structured `metadata.serviceModes` / `metadata.subcategory` /
 * `metadata.pricingUnit` written by the mode-aware onboarding flow and falls
 * back to inference for legacy rows. Currency rules: backend `price` is stored
 * as rupees (free-text accepted, parsed via `extractPrice`).
 */
export function mapListingRowToMarketplaceService(row: ListingRow): MarketplaceService {
  const metadata = toObject(row.metadata, {} as Record<string, any>);
  const category = String(row.category || metadata.category || "Service");
  const categoryMeta = getServiceCategoryMeta(category);
  const images = toArray(row.images).length > 0 ? toArray(row.images) : toArray(row.photos);
  const heroImage = row.image_url || images[0] || FALLBACK_SERVICE_IMAGE;

  // Mode-aware fallback: missing/empty metadata → ["at-home"] (the historical
  // default; legacy services were always provider-travels-to-customer).
  const serviceModes = (() => {
    const parsed = parseServiceModes(metadata.serviceModes ?? metadata.serviceMode);
    return parsed.length > 0 ? parsed : (["at-home"] as ServiceMode[]);
  })();

  const provider = String(
    metadata.providerName ||
    metadata.hostName ||
    row.provider_name ||
    row.name ||
    "Provider"
  );

  const duration = typeof metadata.duration === "string" && metadata.duration
    ? metadata.duration
    : typeof row.availability === "string" && row.availability
      ? row.availability
      : "Flexible";

  // The displayed `category` chip on a service card maps from this string.
  // Source priority:
  //   1. metadata.subcategory   — host-authored fine-grained label
  //   2. categoryMeta.subcategory — preset's default subcategory
  //   3. the raw `category` itself when it's not one of the preset slugs
  //      (custom services like "math-tutor" should show under their own
  //      label, not get bucketed under "Freelancers" — which also breaks
  //      the consumer-side filter chip match)
  //   4. "Freelancers" as a last resort (covers preset categories whose
  //      subcategory map is empty and rows with truly nothing set)
  // Subcategory display priority:
  //   1. metadata.subcategories[] (new multi-value source) — first entry
  //      drives the card chip; the full array surfaces in detail-page tags
  //      and customer filters via subcategoriesAll below.
  //   2. metadata.subcategory (legacy single value) — kept for back-compat
  //      with listings created before the chip-input rolled out.
  //   3. categoryMeta.subcategory preset default.
  //   4. raw category string (custom services like "math-tutor" show under
  //      their own label rather than getting bucketed under "Freelancers").
  //   5. "Freelancers" last-resort.
  const metaSubsArray = Array.isArray(metadata.subcategories)
    ? (metadata.subcategories as unknown[]).filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  const subcategory = metaSubsArray[0]
    ?? (typeof metadata.subcategory === "string" && metadata.subcategory
        ? metadata.subcategory
        : (categoryMeta?.subcategory
            || (category && !categoryMeta ? category : "Freelancers")));
  // Full subcategory list surfaced for filters + AI agent + detail-page
  // tags. Falls back to a single-element array of the resolved primary
  // when the listing only has the legacy scalar.
  const subcategoriesAll: string[] = metaSubsArray.length > 0
    ? metaSubsArray
    : (subcategory ? [subcategory] : []);

  // `nextSlot` and `slots` are NOT modelled on the backend yet — they belong
  // to the unbuilt service-booking flow. Surface placeholders so the card and
  // detail page render without crashing; real slots will come from the
  // smart-schedule module when the booking path is wired in a later phase.
  // Pretty label for the listing's PRIMARY category — drives the new
  // "MAIN CATEGORY" badge that renders ABOVE the subcategory chip on
  // service cards + the detail-page eyebrow. Source priority:
  //   1. categoryMeta.name (when the raw slug exactly matches a preset)
  //   2. Title-cased version of the raw slug (handles real-world data
  //      like "cleaning" → "Cleaning", "mens-haircut" → "Mens Haircut",
  //      "math-tutor" → "Math Tutor"). Slugs are usually lowercase or
  //      kebab — split on non-alpha boundaries and uppercase each word.
  //   3. Empty string — caller can hide the badge when there's no
  //      meaningful primary to show (rare; legacy rows with null
  //      category fall here).
  const mainCategory = categoryMeta?.name
    || (category
        ? category
            .split(/[-_\s]+/)
            .filter(Boolean)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(" ")
        : "");

  return {
    id: String(row.id),
    title: String(row.title || row.name || category),
    provider,
    category: subcategory,
    mainCategory,
    subcategories: subcategoriesAll,
    mode: serviceModes,
    location: String(row.location || row.city || metadata.area || "Local area"),
    city: row.city ? String(row.city) : undefined,
    price: extractPrice(row.price),
    duration,
    rating: toNumber(row.avg_rating, 0),
    reviews: toNumber(row.review_count, 0),
    image: heroImage,
    // Whole gallery for the detail-page hero. First entry mirrors `image`
    // for legacy callers; falls back to a single-entry array when the
    // listing only has one photo.
    images: images.length > 0 ? images : [heroImage],
    nextSlot: typeof metadata.nextSlot === "string" ? metadata.nextSlot : "On request",
    icon: resolveIcon(metadata.icon || categoryMeta?.icon),
    // Slot source priority:
    //   1. metadata.serviceTimeSlots / metadata.slots (provider-curated strings)
    //   2. derive from metadata.workingHours + duration (canonical scheduling source)
    //   3. parse free-text availability via working hours fallback (legacy)
    // This ensures listings created before slot-timing support still surface
    // bookable times once a provider sets working hours.
    slots: (() => {
      const explicit = Array.isArray(metadata.serviceTimeSlots) && metadata.serviceTimeSlots.length > 0
        ? toArray(metadata.serviceTimeSlots)
        : Array.isArray(metadata.slots) && metadata.slots.length > 0
          ? toArray(metadata.slots)
          : null;
      if (explicit) return explicit;
      const wh = metadata.workingHours;
      if (wh && typeof wh === "object") {
        const buf = typeof metadata.bufferMinutes === "number" ? metadata.bufferMinutes : 15;
        return deriveSlotsFromWorkingHours(
          wh,
          typeof metadata.duration === "string" ? metadata.duration : duration,
          buf,
        );
      }
      return [];
    })(),
    addOns: Array.isArray(metadata.addOns)
      ? metadata.addOns
          .filter((a: any) => a && typeof a === "object" && a.label)
          .map((a: any, idx: number) => ({
            id: String(a.id ?? `addon-${idx + 1}`),
            label: String(a.label),
            price: extractPrice(a.price, 0),
          }))
      : [],
    // Canonical service catalog. Prefer the explicit `metadata.servicesCatalog`
    // written by the new onboarding/edit flows; for legacy listings (created
    // before the catalog landed) synthesize a single group from the top-level
    // `price` + flat `metadata.addOns` so the detail page can render the same
    // structure for every service regardless of when it was created.
    servicesCatalog: (() => {
      const raw = Array.isArray(metadata.servicesCatalog) ? metadata.servicesCatalog : [];
      if (raw.length > 0) {
        return raw
          .filter((g: any) => g && typeof g === "object")
          .map((g: any, i: number) => ({
            id: String(g.id ?? `svc-${i + 1}`),
            name: typeof g.name === "string" ? g.name : "",
            basePrice: extractPrice(g.basePrice, 0),
            addOns: Array.isArray(g.addOns)
              ? g.addOns
                  .filter((a: any) => a && typeof a === "object" && a.label)
                  .map((a: any, j: number) => ({
                    id: String(a.id ?? `addon-${i + 1}-${j + 1}`),
                    label: String(a.label),
                    price: extractPrice(a.price, 0),
                  }))
              : [],
          }))
          .filter((g: { name: string; basePrice: number }) => g.name.trim().length > 0 && g.basePrice > 0);
      }
      // Legacy synthesis: one group from price + flat addOns. Name falls
      // back to the listing's primary subcategory, then a generic
      // placeholder — never empty, so the detail-page selector always has
      // a label to show.
      const priceNum = extractPrice(row.price, 0);
      const flatAddOns = Array.isArray(metadata.addOns)
        ? metadata.addOns
            .filter((a: any) => a && typeof a === "object" && a.label)
            .map((a: any, idx: number) => ({
              id: String(a.id ?? `addon-1-${idx + 1}`),
              label: String(a.label),
              price: extractPrice(a.price, 0),
            }))
        : [];
      if (priceNum <= 0 && flatAddOns.length === 0) return [];
      const subcatArr = Array.isArray(metadata.subcategories) ? metadata.subcategories : [];
      const subcatFromArr = subcatArr.find((s: unknown): s is string => typeof s === "string" && s.trim().length > 0);
      const fallbackName = subcatFromArr
        || (typeof metadata.subcategory === "string" && metadata.subcategory)
        || "Service";
      return [{
        id: "svc-1",
        name: fallbackName,
        basePrice: priceNum,
        addOns: flatAddOns,
      }];
    })(),
    description: String(row.description || ""),
    // New mode-aware fields. Surface them directly so detail pages and
    // dashboard summaries can render structured cards without re-parsing
    // metadata. Empty string is preserved rather than coerced to undefined
    // so the UI can distinguish "host left it blank" from "host hasn't
    // upgraded their listing yet."
    pricingUnit: typeof metadata.pricingUnit === "string" ? metadata.pricingUnit : "",
    visitAddress: typeof metadata.visitAddress === "string" ? metadata.visitAddress : "",
    meetingDetails: typeof metadata.meetingDetails === "string" ? metadata.meetingDetails : "",
    serviceRadiusKm: toNumber(metadata.serviceRadius, 0) || undefined,
    lat: toCoord(row.lat),
    lng: toCoord(row.lng),
    // Mirror the stay adapter (B1/WS6): geo_exact:false = approximate coords
    // + visitAddress scrubbed for this viewer. Default true for legacy rows.
    geoExact: row.geo_exact !== false,
    // Mirror the stay adapter: only surface `provider_profile_id` (NOT a
    // fallback to user_id, which would FK-violate against bookings.provider_id
    // and abort the createHold transaction).
    providerProfileId: row.provider_profile_id ? String(row.provider_profile_id) : undefined,
    verified: Boolean(metadata.verified ?? false),
    languages: toArray(metadata.languages),
    // Host-set day blocks (ISO YYYY-MM-DD). Matches the shape used by the
    // transport adapter so the booking modal can apply the same date gate
    // to either kind of listing.
    blockedDates: Array.isArray(metadata.blockedDates)
      ? metadata.blockedDates.filter((d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
      : [],
  };
}

/**
 * Map a backend listing row to the redesigned-marketplace `MarketplaceTransport`
 * contract. Reads `metadata.transportMode` / `pricePerHour` / `pricePerDay` /
 * `packageOptions` written by the mode-aware onboarding flow and
 * falls back to inference + free-text parsing for legacy rows.
 *
 * Fields the backend doesn't yet model (`capacity`, `trips`) default to safe
 * placeholders so cards render. The browse/detail UI treats them as cosmetic
 * until those columns exist.
 */
export function mapListingRowToMarketplaceTransport(row: ListingRow): MarketplaceTransport {
  const metadata = toObject(row.metadata, {} as Record<string, any>);
  const images = toArray(row.images).length > 0 ? toArray(row.images) : toArray(row.photos);
  const heroImage = row.image_url || images[0] || FALLBACK_TRANSPORT_IMAGE;

  // Reuse the same parsing rules as `mapListingToTransport` so the two shapes
  // can't disagree on which mode a listing belongs to.
  const priceText = String(row.price ?? "").trim();
  const priceNumber = (() => {
    const m = priceText.match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
  })();
  const isPerKmString = /\/\s*km|per\s*km/i.test(priceText);
  const isPerHourString = /\/\s*h(?:r|our)?\b|per\s*h(?:r|our)?/i.test(priceText);
  const isPerDayString = /\/\s*d(?:ay)?\b|per\s*d(?:ay)?\b/i.test(priceText);

  const pricePerKmFromMeta = toNumber(metadata.pricePerKm, NaN);
  const pricePerHourFromMeta = toNumber(metadata.pricePerHour, NaN);
  const pricePerDayFromMeta = toNumber(metadata.pricePerDay, NaN);

  const pricePerKm = Number.isFinite(pricePerKmFromMeta) && pricePerKmFromMeta > 0
    ? pricePerKmFromMeta
    : isPerKmString && priceNumber != null ? priceNumber : 0;
  const pricePerHour = Number.isFinite(pricePerHourFromMeta) && pricePerHourFromMeta > 0
    ? pricePerHourFromMeta
    : isPerHourString && priceNumber != null ? priceNumber : 0;
  // Mirror the hourly fallback so a day-rate stored only in the free-text
  // `price` ("₹10/day") still surfaces as item.day. Without this, the
  // booking-type picker hides "Day rental" on AI-onboarded listings that
  // wrote the rate as text without persisting `metadata.pricePerDay`.
  const pricePerDay = Number.isFinite(pricePerDayFromMeta) && pricePerDayFromMeta > 0
    ? pricePerDayFromMeta
    : isPerDayString && priceNumber != null ? priceNumber : 0;

  const packageOptionsRaw = parsePackageOptions(metadata.packageOptions);
  // MarketplaceTransport.packageOptions is the same shape; reuse directly.
  const packageOptions = packageOptionsRaw;

  // Resolve transport mode the same way as `mapListingToTransport` so the two
  // shapes can't disagree on which mode a listing belongs to. Prefer the
  // structured `metadata.transportMode`; otherwise infer from which price
  // field / package set is populated. Legacy rows default to "point" — the
  // per-km prebook flow they always exposed.
  const transportMode: TransportMode = parseTransportMode(metadata.transportMode)
    ?? (packageOptions.length > 0
        ? "package"
        : pricePerDay > 0
          ? "day"
          : pricePerHour > 0
            ? "hourly"
            : "point");

  // Driver/provider display name. Falls back through host metadata, then the
  // listing's own name/title so a legacy row that has neither still renders.
  const driver = String(
    metadata.providerName ||
    metadata.hostName ||
    row.name ||
    row.title ||
    "Local Driver"
  );

  // Phase 3: read the multi-type catalog entries. Falls back to building a
  // one-entry array from the legacy `metadata.transportType` string for
  // older listings.
  const transportationTypes = normalizeTransportationTypes(
    metadata.transportationTypes,
    metadata.transportType || row.category,
  );

  // Pretty-print the vehicle category for the badge. Prefers the first
  // entry from transportationTypes[]; falls back to the legacy lookup for
  // rows with neither field set. Backend `category` is a lowercase enum
  // slug ("driver-cab", "cab", "auto"); strip the "driver-" prefix and
  // Title-Case so legacy rows still read "Cab" / "Auto" / "Van" / "Bike".
  const vehicleType = (() => {
    if (transportationTypes.length > 0) {
      const first = transportationTypes[0];
      return first.displayName || getTransportTypeLabel(first.type, first.type);
    }
    const raw = String(metadata.transportType || row.category || "cab")
      .replace(/^driver-/i, "");
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  })();

  return {
    id: String(row.id),
    driver,
    vehicle: String(row.vehicle_name || metadata.vehicleName || "Vehicle"),
    // Vehicle colour + plate the host onboarded. Empty string (not a
    // placeholder) on legacy rows so the UI can hide the row when absent.
    color: String(metadata.vehicleColor || "").trim(),
    plate: String(metadata.licensePlate || "").trim(),
    type: vehicleType,
    area: String(row.service_area || row.location || metadata.area || "Local area"),
    city: row.city ? String(row.city) : undefined,
    description: typeof row.description === "string" ? row.description : undefined,
    perKm: pricePerKm,
    hourly: pricePerHour,
    day: pricePerDay,
    rating: toNumber(row.avg_rating, 0),
    trips: toNumber(metadata.trips, 0),
    languages: toArray(metadata.languages).length > 0 ? toArray(metadata.languages) : ["English", "Hindi"],
    // `packages` is the short-string chip array on the discovery tile; derive
    // labels from the structured packageOptions so the two stay in sync. Falls
    // back to any free-text metadata.packages array on legacy rows.
    packages: packageOptions.length > 0
      ? packageOptions.map((p) => p.label)
      : toArray(metadata.packages),
    image: heroImage,
    // Surface the full gallery for the detail-page hero. Falls back to
    // a single-entry array of the hero when the listing only has one
    // photo, so the detail page can branch on `images.length > 1`.
    images: images.length > 0 ? images : [heroImage],
    // Seating capacity: the host's onboarded number is the source of truth.
    // Read in priority order:
    //   1. metadata.seatingCapacity — top-level value set during onboarding
    //      (manual form + AI agent both write this; we also write it from
    //      submit so legacy listings get backfilled on next edit).
    //   2. transportationTypes[0].details.seatingCapacity — the multi-vehicle
    //      catalog's first entry (preferred when the host runs more than one
    //      vehicle; the booking modal switches per sub-type).
    //   3. metadata.capacity — pre-Phase-3 legacy key.
    //   4. row.seating_capacity — DB column fallback for very old rows.
    //   5. 4 — last-resort default (typical sedan) so the card isn't blank.
    capacity: (() => {
      const top = toNumber(metadata.seatingCapacity, NaN);
      if (Number.isFinite(top) && top > 0) return top;
      const ttypes = Array.isArray(metadata.transportationTypes) ? metadata.transportationTypes : [];
      for (const t of ttypes) {
        const seats = toNumber((t as { details?: { seatingCapacity?: unknown } })?.details?.seatingCapacity, NaN);
        if (Number.isFinite(seats) && seats > 0) return seats;
      }
      const legacy = toNumber(metadata.capacity, NaN);
      if (Number.isFinite(legacy) && legacy > 0) return legacy;
      const col = toNumber(row.seating_capacity, NaN);
      if (Number.isFinite(col) && col > 0) return col;
      return 4;
    })(),
    packageOptions,
    transportMode,
    transportModes: (() => {
      const raw = metadata.transportModes;
      if (!Array.isArray(raw)) return undefined;
      const allowed: TransportMode[] = ["hourly", "day", "package", "point"];
      const out = raw.filter((m): m is TransportMode => allowed.includes(m as TransportMode));
      return out.length > 0 ? out : undefined;
    })(),
    lat: toCoord(row.lat),
    lng: toCoord(row.lng),
    // Service radius the driver declared at onboarding. Drives the booking
    // modal's pickup-address gate — pickups outside this distance from the
    // driver's base get rejected before createHold. Falls through to
    // undefined for legacy rows that never set it; the gate then falls back
    // to a city/area substring check against `area`.
    serviceRadiusKm: (() => {
      const n = Number(metadata.serviceRadius ?? metadata.serviceRadiusKm);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    })(),
    // Same contract as the service adapter: surface `provider_profile_id`
    // only (NEVER fall back to user_id — `bookings.provider_id` FKs against
    // `provider_profiles.id`, so a user_id would FK-violate and abort the
    // createHold transaction).
    providerProfileId: row.provider_profile_id ? String(row.provider_profile_id) : undefined,
    verified: Boolean(metadata.verified ?? false),
    transportationTypes,
    // Surface the driver's weekly window + buffer so the booking modal's
    // day-strip can render the right bounds and grey out cells inside the
    // back-to-back buffer radius. Both are optional on legacy rows.
    workingHours: (metadata.workingHours && typeof metadata.workingHours === "object")
      ? metadata.workingHours as Record<string, [string, string] | null>
      : undefined,
    bufferMinutes: Number.isFinite(toNumber(metadata.bufferMinutes, NaN))
      ? toNumber(metadata.bufferMinutes, 15)
      : undefined,
    // Informational tag — driver signalled they'll arrange times outside
    // their weekly hours. Does not affect slot availability. Guard against
    // the AI JSON path stringifying the flag: Boolean("false") is true, so
    // accept only a real true / "true".
    flexibleHours: metadata.flexibleHours === true || metadata.flexibleHours === "true",
    // Driver-blocked dates from the dashboard schedule view. The customer
    // date picker disables anything in this set so we can't accept a
    // booking on a day the driver took off.
    blockedDates: Array.isArray(metadata.blockedDates)
      ? metadata.blockedDates.filter((d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
      : undefined,
  };
}
