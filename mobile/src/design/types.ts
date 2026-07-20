// design/types.ts — shared domain shapes for the design app. These are the
// canonical types backend mappers (api/listings.ts etc.) produce and screens
// consume. No mock CONTENT lives here — only types, empty placeholders used as
// transient loading defaults, and static config (language list).
import { Tone } from "./theme";

export type Review = { name: string; when: string; rating: number; text: string };

export type RoomType = {
  /** Backend room_type_id — scopes availability/booked-dates per room. */
  id?: string;
  name: string;
  sleeps: number;
  beds: number;
  baths: number;
  price: number;
  tone: Tone;
  amenities: string[];
  /** Number of units of this room type (for multi-room stays). */
  quantity?: number;
  /** Uploaded room photos (CDN urls). */
  photoUrls?: string[];
};

export type Stay = {
  id: string;
  title: string;
  type: string;
  listingKind: "whole" | "rooms";
  owner: string;
  geo: { x: number; y: number };
  /** Real coordinates from the backend (when present) for the map. */
  lat?: number;
  lng?: number;
  /** False when the server sent privacy-approximated geo for this viewer
   *  (unbooked): coords rounded ~1km, address/visitAddress withheld. Default
   *  true for legacy/mock rows with no flag. Mirrors web. */
  geoExact?: boolean;
  /** Best-effort city (for the dynamic greeting / search location). */
  city?: string;
  /** "Area, City" when the backend derived a neighbourhood, else just the
   *  city. NOTE: `district` here is the STATE (web's `district` is the city). */
  location: string;
  district: string;
  address: string;
  price: number;
  /** Host-set % off every night (listings.discount_percent). The server
   *  applies this in subtotalForStayPaise, so the Review-screen subtotal
   *  must apply it too or the preview overstates the actual charge. */
  discountPercent?: number;
  rating: number;
  reviews: number;
  photos: number;
  photoUrls?: string[];
  guests: number;
  rooms: number;
  beds: number;
  baths: number;
  tone: Tone;
  hostSince: string;
  checkIn: string;
  checkOut: string;
  languages: string[];
  cancellation: string;
  tags: string[];
  amenities: string[];
  amenityLabels: string[];
  verified: boolean;
  superhost: boolean;
  blurb: string;
  topReviews: Review[];
  roomTypes?: RoomType[];
};

export type Service = {
  id: string;
  title: string;
  provider: string;
  category: string;
  icon: string;
  mode: string[];
  /** Provider's spoken languages (metadata.languages) — used by the
   *  Explore filter sheet. Empty when the listing has none recorded. */
  languages: string[];
  location: string;
  city?: string;
  lat?: number;
  lng?: number;
  /** False when the server sent privacy-approximated geo (unbooked viewer) —
   *  `address`/`visitAddress` then hold the area label, not a street. */
  geoExact?: boolean;
  price: number;
  duration: string;
  rating: number;
  reviews: number;
  nextSlot: string;
  tone: Tone;
  blurb: string;
  subcategory: string;
  verified: boolean;
  photos: number;
  photoUrls?: string[];
  address: string;
  travelKm: number;
  onlineNote?: string;
  /** Structured shop/studio address for visit-provider bookings (falls back
   *  to the listing location when the provider hasn't set one). */
  visitAddress?: string;
  addOns?: { id?: string; name: string; price: number }[];
  /** Service catalog entries (e.g. Men's / Women's / Kid's Haircut), each with
   *  its OWN add-ons — mirrors web's metadata.servicesCatalog. `id` is the
   *  backend catalog-group / add-on id the booking sends so the server prices
   *  the SELECTED variant (resolveServiceCatalogGroup matches by id). */
  variants?: { id: string; name: string; price: number; addOns: { id?: string; name: string; price: number }[] }[];
  slots: string[];
  topReviews?: Review[];
};

export type TransportTour = {
  /** packageOptions[].id — the server prices package bookings by matching
   *  notes.packageId against this. Empty for legacy rows without ids. */
  id: string;
  name: string;
  hours: number;
  km: string;
  price: number;
  places: { name: string; dur: string }[];
  note: string;
};

export type Transport = {
  id: string;
  driver: string;
  vehicle: string;
  /** Vehicle colour + number plate from onboarding (`metadata.vehicleColor` /
   *  `metadata.licensePlate`). Shown in the booking summary so a rider can spot
   *  the car. Optional — legacy / mock rows leave them blank. */
  color?: string;
  plate?: string;
  type: string;
  tone: Tone;
  area: string;
  city?: string;
  lat?: number;
  lng?: number;
  perKm: number;
  hourly: number;
  day: number;
  rating: number;
  trips: number;
  languages: string[];
  seats: number;
  available: string;
  availabilityNote: string;
  tours: TransportTour[];
  /** Booking modes this driver actually offers — subset of package/hourly/day. */
  modes: string[];
  /** Driver opted into flexible timing at onboarding — surfaces a "Flexible
   *  hours" tag on the detail page (riders can message to arrange other times). */
  flexibleHours: boolean;
  /** Per-weekday open hours from listing metadata ({mon: ["09:00","19:00"],
   *  sun: null, …}). Drives date greying: closed days and days too short for
   *  the selected package are unbookable (mirrors the server's hold gate). */
  workingHours: Record<string, [string, string] | null>;
  packages: string[];
  photos: number;
  photoUrls?: string[];
  reviews: number;
  topReviews: Review[];
  blurb: string;
};

export type Booking = {
  id: string;
  kind: "stay" | "transport" | "service";
  title: string;
  sub: string;
  when: string;
  status: "confirmed" | "upcoming" | "completed" | "cancelled";
  price: number;
  tone: Tone;
  icon: string;
  /** Present on real backend bookings — enables leaving a review. */
  listingId?: string;
  providerId?: string;
  /** Host's auth user id — enables "Message host" (chat receiver). */
  providerUserId?: string;
  providerName?: string;
  /** Raw schedule + location for the detail modal. */
  scheduledDate?: string;
  startTime?: string;
  endTime?: string;
  address?: string;
  /** WS6: false = host provided no street-level address (city-only). */
  hasExactAddress?: boolean;
  guestName?: string;
  /** Party size: rooms (stays) + guests/passengers (all types). */
  roomCount?: number;
  guestCount?: number;
  /** Price breakdown in rupees for the in-app invoice. */
  breakdown?: { subtotal: number; fee: number; tax: number; insurance: number; discount: number; total: number };
  /** Transport-only snapshots taken at booking time — the booked vehicle's
   *  model / plate / colour and the driver's phone. Frozen so the booking
   *  detail keeps showing the right car even if the host edits the listing.
   *  Driver NAME reuses `providerName`. Undefined for non-transport. */
  vehicleModel?: string;
  vehiclePlate?: string;
  vehicleColor?: string;
  /** Driver's personal name (host display name) + phone — "who's driving" and
   *  how to reach them, distinct from `providerName` (the business name). */
  driverName?: string;
  driverPhone?: string;
};

export type Message = {
  id: string;
  name: string;
  role: string;
  last: string;
  time: string;
  unread: number;
  tone: Tone;
  icon: string;
};

/* ---------- Empty placeholders ----------
   Structural defaults (all empty/zero — NOT fake content) used as the transient
   fallback while a real listing loads. Detail/booking screens render a loading
   state over these, so they're never shown as if they were a real listing. */
export const BLANK_STAY: Stay = {
  id: "", title: "", type: "", listingKind: "whole", owner: "", geo: { x: 0.5, y: 0.5 },
  location: "", district: "", address: "", price: 0, rating: 0, reviews: 0, photos: 0,
  guests: 0, rooms: 0, beds: 0, baths: 0, tone: "saffron", hostSince: "", checkIn: "", checkOut: "",
  languages: [], cancellation: "", tags: [], amenities: [], amenityLabels: [], verified: false,
  superhost: false, blurb: "", topReviews: [],
};

export const BLANK_SERVICE: Service = {
  id: "", title: "", provider: "", category: "", icon: "sparkle", mode: ["visit-provider"], languages: [],
  location: "", price: 0, duration: "", rating: 0, reviews: 0, nextSlot: "", tone: "saffron",
  blurb: "", subcategory: "", verified: false, photos: 0, address: "", travelKm: 0, slots: [], topReviews: [],
};

export const BLANK_TRANSPORT: Transport = {
  id: "", driver: "", vehicle: "", type: "", tone: "saffron", area: "", perKm: 0, hourly: 0, day: 0,
  rating: 0, trips: 0, languages: [], seats: 0, available: "", availabilityNote: "", tours: [],
  modes: [], flexibleHours: false, workingHours: {}, packages: [], photos: 0, reviews: 0, topReviews: [], blurb: "",
};

/* ---------- Static config (not mock content) ---------- */
export const languages = [
  { code: "te", native: "తెలుగు", en: "Telugu" },
  { code: "en", native: "English", en: "English" },
  { code: "hi", native: "हिन्दी", en: "Hindi" },
  { code: "ta", native: "தமிழ்", en: "Tamil" },
  { code: "kn", native: "ಕನ್ನಡ", en: "Kannada" },
  { code: "ml", native: "മലയാളം", en: "Malayalam" },
  { code: "mr", native: "मराठी", en: "Marathi" },
];
