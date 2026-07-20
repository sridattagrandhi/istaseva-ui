// design/api/dash.ts — Phase 4c: host/provider/transport dashboard writes + "my listings".
import { api } from "@/lib/api";
import { Tone } from "../theme";
import { DashListing } from "../screens/dash/dashData";
import { ApiListing, ApiListingMeta } from "./listings";

const TONES: Tone[] = ["saffron", "blue", "aubergine", "coral"];
const toneFor = (id: string) => TONES[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % TONES.length];
const shortLoc = (s?: string) => (s || "").split(",")[0].trim();
const ICON: Record<string, string> = { stay: "bedDouble", service: "sparkle", transport: "car" };

export type MyListing = DashListing & {
  apiId: string;
  listingType: string;
  propertyType: string;
  /** Per-weekday open hours + buffer, surfaced so the transport schedule grid
   *  can render the driver's REAL window instead of a 9-9 placeholder. */
  workingHours?: Record<string, [string, string] | null>;
  bufferMinutes?: number;
  /** Spoken languages from the listing metadata — shown on the dashboard
   *  Profile tab's Business details. May carry cased duplicates. */
  languages?: string[];
};

export function mapDashListing(l: ApiListing): MyListing {
  const t = l.listing_type as string;
  const meta: ApiListingMeta = l.metadata || {};
  // Transport price is mode-dependent: package-only drivers have
  // pricePerHour/Day = 0, so fall back to the cheapest package price (mirrors
  // the web + the Transport card) instead of showing "₹0 / hr".
  const pkgMin = Array.isArray(meta.packageOptions)
    ? meta.packageOptions.reduce((m: number, p) => {
        const v = Number(p?.price) || 0;
        return v > 0 && (m === 0 || v < m) ? v : m;
      }, 0)
    : 0;
  const transportPrice =
    Number(meta.pricePerDay) > 0 ? `₹${Number(meta.pricePerDay)} / day`
    : Number(meta.pricePerHour) > 0 ? `₹${Number(meta.pricePerHour)} / hr`
    : Number(meta.pricePerKm) > 0 ? `₹${Number(meta.pricePerKm)} / km`
    : pkgMin > 0 ? `from ₹${pkgMin}`
    : Number(l.price) > 0 ? `₹${Number(l.price)} / hr`
    : "Ask price";
  // Multi-room stays price per-room, so the listing-level price is 0 — show
  // "from ₹<cheapest room>" using the from_price_paise the /mine query adds.
  const fromPaise = Number(l.from_price_paise) || 0;
  const price =
    t === "stay"
      ? (fromPaise > 0 ? `from ₹${Math.round(fromPaise / 100)} / night` : `₹${Number(l.price_per_night || l.price) || 0} / night`)
    : t === "transport" ? transportPrice
    : `₹${Number(l.price) || 0}`;
  return {
    apiId: l.id, listingType: t,
    propertyType: l.property_type || l.category || "",
    name: l.name || "Untitled",
    location: t === "transport" ? `${l.vehicle_name || (l.category || "").replace("driver-", "")}` : shortLoc(l.location),
    status: l.is_active ? "live" : "paused",
    price,
    metric: l.review_count ? `${l.review_count} review${l.review_count === 1 ? "" : "s"}` : "Newly listed",
    rating: Number(l.avg_rating) || 0,
    icon: ICON[t] || "sparkle",
    tone: toneFor(l.id),
    workingHours: meta.workingHours && typeof meta.workingHours === "object" ? meta.workingHours : {},
    bufferMinutes: Number(meta.bufferMinutes) || 15,
    languages: Array.isArray(meta.languages) ? meta.languages.map(String) : [],
  };
}

export async function fetchMyListings(): Promise<MyListing[]> {
  const res = await api.get("/api/listings/mine");
  const items: ApiListing[] = res.data?.data ?? res.data?.listings ?? (Array.isArray(res.data) ? res.data : []);
  return items.map(mapDashListing);
}

/** Onboarding/edit form state (see ListingOnboarding) — a loose bag of
 *  string-ish fields; only the keys the payload builder reads structurally
 *  are typed, the rest are coerced at the use site. */
export type ListingFormState = Record<string, unknown> & {
  category?: string;
  servicesCatalog?: { id?: string; name?: string; basePrice?: unknown; addOns?: { id?: string; name?: string; price?: unknown }[] }[];
};

/** Maps the onboarding form state (`p`) into the create-listing API body. */
export function buildCreatePayload(entryType: "stay" | "service" | "transport", p: ListingFormState): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    listingType: entryType,
    languages: p.languages || [],
    description: p.description || "",
  };
  const body: Record<string, unknown> = {
    name: p.name,
    description: p.description || "",
    location: p.location || p.visitAddress || "",
    photos: p.photos || [],
  };
  // Forward coords + city/state when the host picked an address (or used GPS).
  // These drive Explore's "Near <city>" discovery — without them a listing is
  // invisible to the geo filter. Guarded on presence so an edit that doesn't
  // re-touch the address never wipes existing values.
  if (p.lat != null && p.lng != null && p.lat !== "" && p.lng !== "") { body.lat = Number(p.lat); body.lng = Number(p.lng); }
  if (p.city && String(p.city).trim()) body.city = String(p.city).trim();
  if (p.state && String(p.state).trim()) body.state = String(p.state).trim();
  if (entryType === "stay") {
    body.category = p.propertyType || "homestay";
    body.property_type = p.propertyType;
    body.price = String(p.price || "");
    body.price_per_night = Number(p.price) || null;
    body.max_guests = Number(p.maxGuests) || null;
    body.bedrooms = Number(p.bedrooms) || null;
    body.bathrooms = Number(p.bathrooms) || null;
    body.amenities = p.amenities || [];
    // Stays are open year-round by default; hosts block specific dates in the
    // Calendar. The backend activation gate requires a non-empty `availability`
    // (mirrors the web, which fills it from working hours) — without this,
    // activation fails with "add: Availability".
    body.availability = (p.availability && String(p.availability).trim()) || "Year-round";
    // Room types are a SEPARATE resource — never sent in the listing body (the
    // repo strips unknown keys). They're persisted via /api/listings/:id/
    // room-types: bulk-created after onboarding, live-CRUD'd in the manager.
    // See api/roomTypes.ts.
    meta.checkInTime = p.checkInTime; meta.checkOutTime = p.checkOutTime;
  } else if (entryType === "service") {
    body.category = (p.category || "service").toLowerCase().replace(/\s+/g, "-");
    body.price = String(p.price || (p.servicesCatalog?.[0]?.basePrice ?? ""));
    Object.assign(meta, {
      pricingUnit: p.pricingUnit, serviceModes: p.serviceModes || [], experience: p.experience, duration: p.duration,
      subcategories: p.subcategories || [], visitAddress: p.visitAddress, meetingDetails: p.meetingDetails,
      // WS6 host consent: publish the visit address to unbooked browsers.
      // Strict === true — absence means private, matching the server scrub.
      showAddressPublicly: p.showAddressPublicly === true,
      serviceRadius: p.serviceRadius, workingHours: p.workingHours, bufferMinutes: p.bufferMinutes,
      servicesCatalog: (p.servicesCatalog || []).map((g) => ({ id: g.id, name: g.name, basePrice: Number(g.basePrice) || 0, addOns: (g.addOns || []).map((a) => ({ ...(a.id ? { id: a.id } : {}), label: a.name, price: Number(a.price) || 0 })) })),
    });
  } else {
    body.category = "driver-" + (String(p.vehicleType || "cab").toLowerCase());
    body.vehicle_name = p.vehicleName || "";
    body.vehicle_year = String(p.vehicleYear || "");
    body.price = String(p.pricePerHour || "");
    // Editor rows keep stops as a comma-separated string; the wire shape is
    // [{place}] with a km range (required by the activation gate). Note:
    // dwellMinutes from AI/web-authored stops don't survive a mobile edit of
    // the stops field — the editor is place-names-only.
    const packageOptions = (Array.isArray(p.packageOptions) ? p.packageOptions : []).map((k, i: number) => {
      const kmMin = Number(k.distanceKmMin) || 0;
      return {
        id: k.id || `pkg-${i + 1}`,
        label: String(k.label || k.title || "").trim(),
        price: Number(k.price) || 0,
        ...(Number(k.hours) > 0 ? { hours: Number(k.hours) } : {}),
        stops: String(k.stops || "").split(/[,·]/).map((s: string) => s.trim()).filter(Boolean).map((place: string) => ({ place })),
        distanceKmMin: kmMin,
        distanceKmMax: Number(k.distanceKmMax) || kmMin,
      };
    });
    // Activation requires metadata.transportMode (scalar primary mode) and a
    // priced transportationTypes[] (or the legacy vehicle_name+transportType
    // pair). Mirror the web: keep transportMode = transportModes[0], pass
    // through a rich agent/web-authored array when present, else synthesize
    // a single catalog entry from the vehicle fields (useConversationEngine
    // does the same on web).
    const transportModes: string[] = Array.isArray(p.transportModes) ? p.transportModes : [];
    const vt = String(p.vehicleType || "cab").toLowerCase();
    const catalogId =
      vt === "cab" ? "sedan_cab" : vt === "auto" ? "auto_rickshaw" : vt === "van" ? "goods_carrier"
        : vt === "tempo" ? "tempo_traveller" : vt === "bike" || vt === "motorcycle" ? "bike_taxi"
          : vt === "scooter" ? "scooter_taxi" : vt === "bus" ? "bus" : vt;
    const transportationTypes = Array.isArray(p.transportationTypes) && p.transportationTypes.length
      ? p.transportationTypes
      : [{
          type: catalogId,
          displayName: vt.charAt(0).toUpperCase() + vt.slice(1),
          details: {
            basePrice: Number(p.pricePerHour) || Number(p.pricePerDay) || packageOptions[0]?.price || 1,
            ...(p.vehicleName ? { vehicleName: p.vehicleName } : {}),
            ...(p.vehicleType ? { vehicleType: p.vehicleType } : {}),
            seatingCapacity: Number(p.seatingCapacity) || 4,
            ...(Number(p.pricePerHour) > 0 ? { perHourPrice: Number(p.pricePerHour) } : {}),
            ...(Number(p.pricePerDay) > 0 ? { perDayPrice: Number(p.pricePerDay) } : {}),
          },
        }];
    Object.assign(meta, {
      vehicleType: p.vehicleType, seatingCapacity: Number(p.seatingCapacity) || 4, experience: p.experience,
      // Vehicle colour + number plate — required identity fields shown to the
      // rider in the booking summary and snapshotted onto the booking.
      vehicleColor: String(p.vehicleColor || "").trim(),
      licensePlate: String(p.licensePlate || "").trim(),
      transportModes, transportMode: transportModes[0] || undefined,
      pricePerHour: Number(p.pricePerHour) || 0, pricePerDay: Number(p.pricePerDay) || 0,
      packageOptions, transportationTypes, serviceRadius: p.serviceRadius, workingHours: p.workingHours,
      bufferMinutes: p.bufferMinutes, flexibleHours: !!p.flexibleHours,
    });
  }
  body.metadata = meta;
  return body;
}

export async function createListing(entryType: "stay" | "service" | "transport", p: ListingFormState) {
  const res = await api.post("/api/listings", buildCreatePayload(entryType, p));
  // `warnings` = warn-only guardrail nudges (e.g. a street address typed into
  // the public description). The listing saved — surface them, don't fail.
  return {
    listing: res.data?.data ?? res.data,
    warnings: Array.isArray(res.data?.warnings) ? (res.data.warnings as string[]) : [],
  };
}

/**
 * Admin assisted-onboarding: create a listing ON a KYC-verified user's account.
 * Same payload as createListing (so the two paths can't drift), plus the
 * target user and room-type bodies (created server-side as the owner, since
 * the /room-types route is ownership-checked). Server enforces the KYC +
 * not-suspended guards and forces the listing inactive (a draft the owner
 * publishes). Rooms use snake_case keys — the shape roomTypesService.create
 * expects.
 */
export async function createListingForUser(
  entryType: "stay" | "service" | "transport",
  p: ListingFormState,
  targetUserId: string,
  rooms: Array<Record<string, unknown>> = [],
) {
  const res = await api.post("/api/admin/listings/for-user", {
    targetUserId,
    listing: buildCreatePayload(entryType, p),
    rooms,
  });
  return res.data?.data ?? res.data;
}

/** Raw backend listing row (incl. metadata + room_types) for the edit form. */
export async function fetchListingRaw(id: string): Promise<ApiListing> {
  const res = await api.get(`/api/listings/${id}`);
  return res.data?.data ?? res.data;
}

/**
 * Inverse of buildCreatePayload: backend listing row → ListingOnboarding form
 * state, so editing pre-populates every field. Without this, a full PATCH from
 * a blank form would wipe the host's data.
 */
export function listingToForm(entryType: "stay" | "service" | "transport", l: ApiListing): Record<string, unknown> {
  const meta: ApiListingMeta = l?.metadata || {};
  const common: Record<string, unknown> = {
    name: l?.name || "",
    location: l?.location || "",
    description: l?.description || meta.description || "",
    photos: Array.isArray(l?.photos) ? l.photos : [],
    languages: Array.isArray(meta.languages) ? meta.languages : [],
    workingHours: meta.workingHours || {},
    // Round-trip location metadata so edits preserve discoverability.
    city: l?.city || "",
    state: l?.state || "",
    lat: l?.lat ?? undefined,
    lng: l?.lng ?? undefined,
  };
  if (entryType === "stay") {
    return {
      ...common,
      propertyType: l?.property_type || l?.category || "homestay",
      availability: l?.availability || "",
      price: String(l?.price_per_night ?? l?.price ?? ""),
      maxGuests: l?.max_guests ? String(l.max_guests) : "",
      bedrooms: l?.bedrooms ? String(l.bedrooms) : "",
      bathrooms: l?.bathrooms ? String(l.bathrooms) : "",
      amenities: Array.isArray(l?.amenities) ? l.amenities : [],
      checkInTime: meta.checkInTime || "",
      checkOutTime: meta.checkOutTime || "",
      rooms: (Array.isArray(l?.room_types) ? l.room_types : []).map((r, i) => ({
        key: r.id || "r" + i,
        name: r.name || "",
        price: String(r.base_price_paise != null ? Math.round(r.base_price_paise / 100) : r.price_per_night || ""),
        maxGuests: String(r.max_guests || 2),
        quantity: String(r.quantity || 1),
        bedrooms: String(r.beds || r.bedrooms || 1),
        bathrooms: String(r.baths || r.bathrooms || 1),
        amenities: Array.isArray(r.amenities) ? r.amenities : [],
        description: r.description || r.room_description || "",
        photos: Array.isArray(r.photos) ? r.photos : [],
      })),
    };
  }
  if (entryType === "service") {
    const cat = (meta.servicesCatalog || []).map((g) => ({
      id: g.id || "g0", name: g.name || "", basePrice: String(g.basePrice ?? ""),
      addOns: (g.addOns || []).map((a) => ({ ...(a.id ? { id: a.id } : {}), name: a.label || a.name || "", price: String(a.price ?? "") })),
    }));
    return {
      ...common,
      category: (l?.category || "").replace(/-/g, " "),
      price: String(l?.price ?? ""),
      pricingUnit: meta.pricingUnit || "",
      serviceModes: Array.isArray(meta.serviceModes) ? meta.serviceModes : [],
      experience: meta.experience || "",
      duration: meta.duration || "",
      subcategories: Array.isArray(meta.subcategories) ? meta.subcategories : [],
      visitAddress: meta.visitAddress || "",
      showAddressPublicly: meta.showAddressPublicly === true,
      meetingDetails: meta.meetingDetails || "",
      // Numeric metadata → string, else RN TextInput renders blank.
      serviceRadius: meta.serviceRadius ? String(meta.serviceRadius) : "",
      bufferMinutes: meta.bufferMinutes ?? 15,
      servicesCatalog: cat.length ? cat : [{ id: "g0", name: "", basePrice: "", addOns: [] }],
    };
  }
  // transport
  return {
    ...common,
    vehicleType: meta.vehicleType || "",
    vehicleName: l?.vehicle_name || "",
    vehicleYear: String(l?.vehicle_year || ""),
    // Vehicle colour + plate so an edit pre-fills them instead of blanking.
    vehicleColor: meta.vehicleColor || "",
    licensePlate: meta.licensePlate || "",
    // RN TextInput won't render a numeric `value` — it silently shows the
    // placeholder instead. Metadata stores these as numbers, so coerce to
    // string here or the edit form looks empty (the day-rate bug).
    seatingCapacity: String(meta.seatingCapacity ?? 4),
    experience: meta.experience || "",
    transportModes: Array.isArray(meta.transportModes) ? meta.transportModes : [],
    pricePerHour: meta.pricePerHour ? String(meta.pricePerHour) : "",
    pricePerDay: meta.pricePerDay ? String(meta.pricePerDay) : "",
    // Wire → editor shape: label/price/km as strings, stops flattened to a
    // comma list of place names (the editor is place-names-only).
    packageOptions: (Array.isArray(meta.packageOptions) ? meta.packageOptions : []).map((k, i) => ({
      id: k.id || `pkg-${i + 1}`,
      label: k.label || k.title || "",
      price: String(k.price ?? ""),
      hours: k.hours != null ? String(k.hours) : "",
      stops: Array.isArray(k.stops)
        ? (k.stops as { place?: string }[]).map((s) => (typeof s === "string" ? s : s?.place || "")).filter(Boolean).join(", ")
        : String(k.stops || ""),
      distanceKmMin: k.distanceKmMin != null ? String(k.distanceKmMin) : "",
      distanceKmMax: k.distanceKmMax != null ? String(k.distanceKmMax) : "",
    })),
    // Pass-through so an edit re-emits the rich agent/web-authored catalog
    // instead of clobbering it with a synthesized single entry.
    transportationTypes: Array.isArray(meta.transportationTypes) ? meta.transportationTypes : [],
    serviceRadius: meta.serviceRadius ? String(meta.serviceRadius) : "",
    bufferMinutes: meta.bufferMinutes ?? 15,
    flexibleHours: !!meta.flexibleHours,
  };
}

/**
 * Full edit: PATCH the complete built payload (form must be pre-populated).
 * The backend REPLACES the metadata column wholesale, so we merge the rebuilt
 * metadata OVER the existing one — otherwise keys the form doesn't round-trip
 * (providerName, generated slots, features…) would be wiped on every edit.
 */
export async function updateListingFull(
  id: string,
  entryType: "stay" | "service" | "transport",
  p: ListingFormState,
  existing?: { metadata?: Record<string, unknown> },
) {
  const body = buildCreatePayload(entryType, p);
  if (existing?.metadata && body.metadata && typeof body.metadata === "object") {
    body.metadata = { ...existing.metadata, ...body.metadata };
  }
  const res = await api.patch(`/api/listings/${id}`, body);
  return res.data?.data ?? res.data;
}

/** Activate / deactivate a listing. Activation runs the server readiness gate. */
export async function setListingActive(id: string, active: boolean) {
  const res = await api.patch(`/api/listings/${id}`, { is_active: active });
  return res.data?.data ?? res.data;
}

// NOTE: no client-side listing delete — removal is admin-only (soft archive
// via /api/admin/listings/:id/archive); owners deactivate instead.

/** Patch editable listing fields (only non-empty keys are sent). */
export async function updateListing(id: string, fields: Record<string, unknown>) {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== "") body[k] = v;
  const res = await api.patch(`/api/listings/${id}`, body);
  return res.data?.data ?? res.data;
}

/* ---------------- availability overrides ---------------- */
// Overrides are scoped by room_type_id: null = listing-wide (whole stay),
// a room id = that room type only. Single-unit stays only ever use null.
export type AvailEntry = { date: string; blocked: boolean; pricePaise: number | null; roomTypeId?: string | null };

export async function fetchAvailability(
  listingId: string,
): Promise<{ date: string; blocked: boolean; price: number | null; roomTypeId: string | null }[]> {
  const res = await api.get(`/api/listings/${listingId}/availability`);
  const items = res.data?.data ?? res.data ?? [];
  return items.map((r: { date?: unknown; blocked?: unknown; price_paise?: unknown; room_type_id?: string | null }) => ({
    date: String(r.date).slice(0, 10),
    blocked: !!r.blocked,
    price: r.price_paise == null ? null : Math.round(Number(r.price_paise) / 100),
    roomTypeId: r.room_type_id ?? null,
  }));
}

/** Dates (YYYY-MM-DD) already taken by confirmed bookings — guests can't pick these.
 *  NOTE: for service listings the backend marks the WHOLE day booked when any
 *  slot is taken, so this must NOT gate the service calendar — use
 *  fetchServiceBookings for per-slot greying instead. Whole-day blocking is only
 *  correct for stays (a booked night blocks the night). */
export async function fetchBookedDates(listingId: string, roomTypeId?: string): Promise<string[]> {
  // For multi-room stays, pass roomTypeId so a date is "booked" only when THAT
  // room type is full — not when any other room type is taken.
  const res = await api.get(`/api/listings/${listingId}/booked-dates`, { params: roomTypeId ? { roomTypeId } : undefined });
  const dates = res.data?.dates ?? res.data?.data?.dates ?? res.data?.data ?? [];
  return (Array.isArray(dates) ? dates : []).map((d) => String(d).slice(0, 10));
}

/** Active per-slot service bookings ({date, start, end}) so the slot picker can
 *  grey only the booked TIME windows on a date — not the whole day. Mirrors the
 *  web (MarketplaceBookingModal builds a bookingsByDate interval map). */
export async function fetchServiceBookings(
  listingId: string,
): Promise<{ date: string; start: string; end: string }[]> {
  const res = await api.get(`/api/listings/${listingId}/service-bookings`);
  const items = res.data?.data ?? (Array.isArray(res.data) ? res.data : []);
  return (Array.isArray(items) ? items : [])
    .map((b) => ({
      date: String(b.scheduledDate ?? b.scheduled_date ?? "").slice(0, 10),
      start: String(b.startTime ?? b.start_time ?? "").slice(0, 5),
      end: String(b.endTime ?? b.end_time ?? "").slice(0, 5),
    }))
    .filter((b: { date: string; start: string }) => b.date && b.start);
}

/** Active per-slot TRANSPORT bookings ({date, start, end}) so hourly mode can
 *  grey only the booked TIME windows on a date — not the whole day. A day or
 *  package booking is stored spanning the driver's whole working window, so its
 *  interval naturally overlaps every hourly slot (blanking the day), while an
 *  hourly booking only covers its own hours. Mirrors fetchServiceBookings and
 *  the web's bookingsByDate interval map. Endpoint: GET
 *  /api/listings/:id/transport-bookings (same row shape as service-bookings). */
export async function fetchTransportBookings(
  listingId: string,
): Promise<{ date: string; start: string; end: string }[]> {
  const res = await api.get(`/api/listings/${listingId}/transport-bookings`);
  const items = res.data?.data ?? (Array.isArray(res.data) ? res.data : []);
  return (Array.isArray(items) ? items : [])
    .map((b) => ({
      date: String(b.scheduledDate ?? b.scheduled_date ?? "").slice(0, 10),
      start: String(b.startTime ?? b.start_time ?? "").slice(0, 5),
      end: String(b.endTime ?? b.end_time ?? "").slice(0, 5),
    }))
    .filter((b: { date: string; start: string }) => b.date && b.start);
}

/** Remaining bookable rooms of a room type across [from, to) — the MIN of
 *  (quantity − booked) over every night in the range. Mirrors the web's
 *  getRoomAvailability; used to cap the booking room-count stepper. */
export async function fetchRoomAvailability(
  listingId: string,
  roomTypeId: string,
  from: string,
  to: string,
): Promise<{ quantity: number; remaining: number }> {
  const res = await api.get(`/api/listings/${listingId}/room-availability`, { params: { roomTypeId, from, to } });
  const d = res.data?.data ?? res.data ?? {};
  return { quantity: Number(d.quantity) || 0, remaining: Math.max(0, Number(d.remaining) || 0) };
}

export async function setAvailability(listingId: string, entries: AvailEntry[]) {
  const body = entries.map((e) => ({ date: e.date, blocked: e.blocked, pricePaise: e.pricePaise, roomTypeId: e.roomTypeId ?? null }));
  const res = await api.put(`/api/listings/${listingId}/availability`, { entries: body });
  return res.data?.data ?? res.data;
}

/* ---------------- earnings (dashboard overview + earnings tab) ---------------- */
export type EarningsPoint = {
  date: string;     // bucket-start ISO day ("2026-07-17")
  label: string;    // axis label ("17 Jul" daily, "Jul 26" monthly)
  earnings: number; // ₹ earned in the bucket
};

export type EarningsData = {
  totalRupees: number;       // completed-booking GROSS earnings over the range, in ₹
  bookings: number;          // completed bookings in the range
  avgRating: number | null;  // average review rating in the range
  /** Platform commission over the range (admin business fee rules,
   *  snapshotted per booking at hold time), in ₹. 0 until rules exist. */
  commissionRupees: number;
  /** Gross − commission: what the partner keeps once payout deduction is live. */
  netRupees: number;
  /** Refunds sent back on kept bookings in the range, in ₹ (statement row). */
  refundsRupees: number;
  /** Discounts the partner funded, already reflected in gross, in ₹. */
  discountsRupees: number;
  series: EarningsPoint[];   // zero-filled dated points (daily ≤ ~4 months, else monthly)
  byListing: { listingId: string; name: string; earnings: number; bookings: number }[]; // per-listing breakdown in range
  allTime: number;           // all-time earnings (respects listing + type filters), in ₹
  from: string | null;       // resolved window start (null = all-time with no earnings yet)
  to: string | null;         // resolved window end
};

export type EarningsParams = {
  range?: string; from?: string; to?: string; listingId?: string;
  /** Scope to one marketplace vertical (stay | service | transport) so a
   *  cab+salon owner's dashboards don't mix each other's money. */
  type?: string;
};

/** Server returns a zero-filled dated series + totals/byListing/allTime. */
export async function fetchEarnings(params: EarningsParams = {}): Promise<EarningsData> {
  const qp: Record<string, string> = {};
  if (params.range) qp.range = params.range;
  if (params.from) qp.from = params.from;
  if (params.to) qp.to = params.to;
  if (params.listingId) qp.listingId = params.listingId;
  if (params.type) qp.type = params.type;
  const res = await api.get("/api/providers/me/earnings", { params: qp });
  const d = res.data?.data ?? res.data ?? {};
  const series: EarningsPoint[] = Array.isArray(d.series)
    ? d.series.map((p: { date?: string; label?: string; earnings?: number }) => ({
        date: String(p.date ?? ""),
        label: String(p.label ?? ""),
        earnings: Math.round(Number(p.earnings) || 0),
      }))
    : [];
  const totals = d.totals || {};
  const gross = Number(totals.earnings) || 0;
  const commission = Number(totals.commission) || 0;
  return {
    totalRupees: gross,
    bookings: Number(totals.bookings) || 0,
    avgRating: totals.avgRating == null ? null : Number(totals.avgRating),
    commissionRupees: commission,
    // Old servers don't send net — derive it so the field is always usable.
    netRupees: Number(totals.net) || gross - commission,
    refundsRupees: Number(totals.refunds) || 0,
    discountsRupees: Number(totals.discounts) || 0,
    series,
    byListing: Array.isArray(d.byListing) ? d.byListing : [],
    allTime: Number(d.allTime) || 0,
    from: typeof d.from === "string" && d.from ? d.from : null,
    to: typeof d.to === "string" && d.to ? d.to : null,
  };
}

/* ---------------- payouts (Earnings tab: status + account) ---------------- */

export type PayoutAccount = {
  id: string;
  method: "bank" | "upi";
  accountHolder: string | null;
  accountNumberMasked: string | null;
  ifsc: string | null;
  upiIdMasked: string | null;
};

export type MyPayouts = {
  pendingPaise: number;
  pendingBookings: number;
  hasAccount: boolean;
  /** History is paginated most-recent-first, 50 per page (1-based). */
  page: number;
  pageSize: number;
  total: number;
  payouts: Array<{
    id: string; amountPaise: number; bookings: number; method: string; note: string | null; status: string; createdAt: string;
    /** Masked destination snapshotted at payout time (absent on older servers/rows). */
    destination?: { method: string | null; accountNumberMasked: string | null; upiIdMasked: string | null } | null;
  }>;
};

export async function fetchPayoutAccount(): Promise<PayoutAccount | null> {
  const res = await api.get("/api/providers/me/payout-account");
  return res.data?.account ?? null;
}

export async function savePayoutAccount(input: {
  method: "bank" | "upi";
  accountHolder?: string;
  accountNumber?: string;
  ifsc?: string;
  upiId?: string;
}): Promise<PayoutAccount | null> {
  const res = await api.put("/api/providers/me/payout-account", input);
  return res.data?.account ?? null;
}

export async function fetchMyPayouts(page = 1): Promise<MyPayouts> {
  // Guard: callers passing this directly as a queryFn would hand us react-
  // query's context object — treat anything non-numeric as page 1.
  const p = typeof page === "number" && Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  const res = await api.get("/api/providers/me/payouts", { params: { page: String(p) } });
  const d = res.data ?? {};
  const payouts = Array.isArray(d.payouts) ? d.payouts : [];
  return {
    pendingPaise: Number(d.pending?.amountPaise) || 0,
    pendingBookings: Number(d.pending?.bookings) || 0,
    hasAccount: !!d.hasAccount,
    page: Number(d.page) || p,
    pageSize: Number(d.pageSize) || 50,
    total: Number(d.total) || payouts.length,
    payouts,
  };
}

/* ---------------- partner insights (Insights tab) ---------------- */
export type InsightsCategory = "stay" | "service" | "transport";
export type InsightsData = {
  from: string;
  to: string;
  series: { day: string; bookings: number; cancelled: number }[];
  statusMix: { status: string; count: number }[];
  cancelReasons: { reason: string; count: number }[];
  paymentFailures: { reason: string; count: number }[];
  repeat: { bookers: number; repeatBookers: number; repeatRate: number | null; medianDaysToSecond: number | null };
  leadTime: { medianDays: number | null; avgDays: number | null };
  searchDemand: { term: string; count: number }[];
  /** 'niche' = terms narrowed to this partner's own listings; 'category' = platform-wide fallback. */
  searchDemandScope?: "niche" | "category";
  /** Searched places (from place-picked searches) within the partner's operating cities/states. */
  searchPlaces?: { regionType: "city" | "state"; region: string; count: number }[];
  funnel: {
    totals: { views: number; cardClicks: number; modalOpens: number; paymentStarts: number; bookings: number };
    byListing: { listingId: string; name: string; views: number; cardClicks: number; modalOpens: number; paymentStarts: number; bookings: number }[];
  };
  /** Equal-length window immediately before [from, to] — deltas + chart overlay. */
  prev?: {
    from: string;
    to: string;
    series: { day: string; bookings: number; cancelled: number }[];
    repeat: { repeatRate: number | null };
    leadTime: { medianDays: number | null };
  };
  /** Kept bookings by scheduled ISO weekday (1=Mon) × start hour (null for stays). */
  heatmap?: { dow: number; hour: number | null; count: number }[];
  stay?: null | {
    rooms: number;
    series: { day: string; roomNights: number; revenuePaise: number }[];
    totals: { roomNights: number; occupancyPct: number | null; adrPaise: number | null };
    prevTotals: { occupancyPct: number | null; adrPaise: number | null };
  };
  transport?: null | {
    pickups: { label: string; count: number }[];
    modes: { mode: string; count: number }[];
  };
};

/** Partner-scoped analytics for the dashboard Insights tab (server-authoritative scoping). */
export async function fetchInsights(category: InsightsCategory, days: number): Promise<InsightsData> {
  const res = await api.get("/api/providers/me/insights", { params: { category, days: String(days) } });
  return (res.data?.data ?? res.data) as InsightsData;
}

/* ---------------- coupons ---------------- */
import { DashCoupon } from "../screens/dash/dashData";

/** Raw coupon row — the list endpoint's camelCase DTO or a legacy snake_case
 *  row; hot fields typed, the rest coerced at the use site. */
type ApiCouponRow = { code: string; category?: string; [key: string]: unknown };

export function mapCoupon(c: ApiCouponRow): DashCoupon {
  const dtype = c.discount_type || c.discountType;
  const dval = Number(c.discount_value ?? c.discountValue) || 0;
  const used = Number(c.used_count ?? c.usedCount ?? c.usesCount ?? c.times_used ?? 0);
  // The list endpoint returns a camelCase DTO (`isActive`); older/raw rows use
  // snake_case (`is_active`). Read both, else `active` reads undefined and the
  // toggle is stuck ON (it never reflects a paused coupon).
  const isActive = (c.is_active ?? c.isActive) !== false;
  const appliesLabel: Record<string, string> = { stay: "All your stays", service: "All your services", transport: "All your rides" };
  // Total discount handed out across redemptions (paise) — list endpoint only.
  const redeemedPaise = Number(c.redeemedPaise ?? c.redeemed_paise ?? 0);
  return {
    id: c.id ? String(c.id) : undefined,
    active: isActive,
    code: c.code,
    off: dtype === "percent" ? `${dval}% off` : `₹${dval} off`,
    desc: (c.category && appliesLabel[c.category]) || "All bookings",
    used: `${used} used` + (redeemedPaise > 0 ? ` · ₹${Math.round(redeemedPaise / 100).toLocaleString("en-IN")} given` : ""),
    status: isActive ? "active" : "expired",
  };
}

/** Pause / resume a coupon (host can toggle at any time). */
export async function setCouponActive(id: string, isActive: boolean) {
  const res = await api.patch(`/api/coupons/${id}`, { isActive });
  return res.data?.data ?? res.data;
}

/** Permanently remove a coupon. */
export async function deleteCoupon(id: string) {
  const res = await api.delete(`/api/coupons/${id}`);
  return res.data?.data ?? res.data;
}

export async function fetchCoupons(): Promise<DashCoupon[]> {
  const res = await api.get("/api/coupons");
  const items = res.data?.data ?? res.data?.coupons ?? (Array.isArray(res.data) ? res.data : []);
  return items.map(mapCoupon);
}

export async function createCoupon(raw: {
  code: string;
  discountType: "percent" | "fixed";
  discountValue: number;
  /** Listing-category scope — stamped from the dashboard the coupon is created
   *  in (stays → stay, services → service, transport → transport). */
  category?: "stay" | "service" | "transport";
  /** Scope to ONE listing (the host picked a specific stay/service/vehicle in
   *  "Applies to"). Omitted = all listings in the category. */
  listingId?: string | null;
  maxUses?: number | null;
  /** ISO-8601 datetime; the backend schema requires a full datetime string. */
  validUntil?: string | null;
}) {
  const body: Record<string, unknown> = {
    code: raw.code,
    discountType: raw.discountType,
    discountValue: raw.discountValue,
  };
  if (raw.category) body.category = raw.category;
  if (raw.listingId) body.listingId = raw.listingId;
  if (raw.maxUses != null) body.maxUses = raw.maxUses;
  if (raw.validUntil) body.validUntil = raw.validUntil;
  const res = await api.post("/api/coupons", body);
  return res.data?.data ?? res.data;
}
