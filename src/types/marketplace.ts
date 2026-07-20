// Frontend-only marketplace contract. Keeps the redesign decoupled from the
// backend's evolving listing shapes (services + transport are still WIP).
// Real adapters in src/lib/marketplace-adapters.ts can later map server rows
// onto these types one-to-one.

import type { LucideIcon } from "lucide-react";

export type ServiceMode = "at-home" | "visit-provider" | "online";
export type TransportMode = "point" | "hourly" | "day" | "package";
export type MarketplaceKind = "stay" | "service" | "transport";

export interface MarketplaceRoomType {
  id: string;
  name: string;
  description?: string;
  /** Per-night price (in rupees). */
  price: number;
  sleeps: number;
  bedrooms: number;
  bathrooms: number;
  /** Per-room amenities. Independent from `MarketplaceStay.amenities` —
   *  the consumer filter unions the two so a chip query matches if ANY
   *  room (or the listing fallback) advertises the amenity. Empty when
   *  the host hasn't authored room-specific amenities. */
  amenities?: string[];
  /** Optional images so the modal can swap art per room type later. */
  image?: string;
  /** How many physical rooms of this type the host has. Drives the
   *  "How many rooms?" stepper in the booking modal — a sathram with
   *  5 Non-AC rooms caps the stepper at 5. Defaults to 1 when the
   *  backend row predates the quantity column. */
  quantity?: number;
}

export interface MarketplaceStay {
  /** Numeric for legacy mock rows; backend listings are UUID strings. */
  id: string | number;
  title: string;
  type: string;
  owner: string;
  location: string;
  district: string;
  /** Listing city (backend `listings.city`) — analytics destCity dimension. */
  city?: string;
  /** Starting price — listing-level "from" rate. When roomTypes is present
      the room's own price overrides this in the booking flow. */
  price: number;
  /** Optional pre-discount price for the strike-through "₹X ₹Y · X% off"
      treatment in the booking modal header. */
  originalPrice?: number;
  /** Host-level discount percent (0–90) the backend multiplies into every
      night when computing the authoritative stay subtotal. The booking
      modal forwards this to `computeStayBreakdownPaise` so the preview
      total matches what `subtotalForStayPaise({ hostDiscountPercent })`
      will produce on the server. Mock stays leave it 0; real backend
      listings copy it from `listings.discount_percent`. */
  discountPercent?: number;
  rating: number;
  reviews: number;
  guests: number;
  rooms: number;
  image: string;
  /** Up to ~6 image URLs used for the gallery + booking modal art. The first
      entry should equal `image` for backward-compat. */
  images?: string[];
  tags: string[];
  verified: boolean;
  amenities: string[];
  cancellation: "flexible" | "moderate" | "strict";
  description: string;
  /** Lat/lng power the map markers on /explore. Optional so callers can map
      real-data rows in later without a migration. Pre-booking these are
      APPROXIMATE (~1km) for privacy — see geoExact. */
  lat?: number;
  lng?: number;
  /** False when the backend returned approximate geo (no street address,
      rounded coordinates) because the viewer hasn't booked yet (audit B1).
      The detail page shows an "exact location after booking" note. Absent/
      true for the owner, admins, and confirmed guests. */
  geoExact?: boolean;
  /** When provided, the booking flow shows a "Select a room" picker.
      Hotels/lodges set this; homestays/single-room rentals omit it and the
      booking flow falls back to listing-level price/rooms. */
  roomTypes?: MarketplaceRoomType[];
  /** Host-side metadata so the detail page can show "Hosting since {Month
      Year} · Responds in 1h" without making the modal feel empty. `since`
      is an empty string when there's no real signal — the detail page
      hides the chip rather than inventing a date. */
  hostMeta?: {
    since: string;
    responsiveness?: string;
    languages?: string[];
  };
  /** Number of bedrooms on the listing itself (homestay/private rental).
   *  Independent of `rooms`, which on hotel-style listings reflects the
   *  number of distinct room TYPES, not bedrooms. Undefined when the
   *  backend row doesn't carry the field. */
  bedrooms?: number;
  /** Number of bathrooms on the listing itself. Optional for the same
   *  reason as `bedrooms`. */
  bathrooms?: number;
  /** Provider profile UUID — the backend's `provider_id` foreign key on the
      booking row. The old stay flow (`src/components/BookingModal.tsx`)
      sends both `providerId` and `listingId` to createHold; surfacing this
      lets the redesigned modal match the same payload shape rather than
      relying on the backend to resolve the provider from the listing alone. */
  providerProfileId?: string;
  /** Listing-configured check-in time ("HH:MM"). Old flow falls back to
      `DEFAULT_CHECK_IN_TIME` when missing; the redesign uses the same
      fallback inside the modal. Surfaced here so the modal doesn't hardcode
      14:00 and ignore host-configured times. */
  checkInTime?: string;
  /** Listing-configured check-out time ("HH:MM"). Mirror of `checkInTime`. */
  checkOutTime?: string;
}

export interface MarketplaceService {
  /** Numeric for legacy mocks; backend listings are UUID strings. */
  id: string | number;
  title: string;
  provider: string;
  category: string;
  /** Listing city (backend `listings.city`) — analytics destCity dimension. */
  city?: string;
  /** Pretty label of the listing's PRIMARY category — e.g. "Cleaning",
   *  "Salon", "Math Tutor". Rendered ABOVE the subcategory chips on the
   *  service card and the detail page eyebrow so users see the broad
   *  bucket first ("Salon"), then the specific offerings underneath
   *  ("Beard trim · Haircut · Nails"). Falls back to empty string when
   *  the listing has no resolvable category (rare). */
  mainCategory: string;
  /** Full list of sub-skills the provider offers (e.g. ["Beard trim",
   *  "Haircut", "Nails"]). Drives the filter chips on the marketplace
   *  list page, the tag row on the detail page, and is sent to the AI
   *  rerank step so the model can match "find a beard trim" against this
   *  listing. First entry is mirrored to `category` for back-compat with
   *  callers that only read the single-value field. Always at least
   *  one entry — falls back to the resolved primary `category`. */
  subcategories: string[];
  mode: ServiceMode[];
  location: string;
  price: number;
  duration: string;
  rating: number;
  reviews: number;
  image: string;
  /** Full photo gallery surfaced from the listing's `photos` column.
   *  First entry should equal `image` for legacy callers. Used by
   *  ServiceDetailPage to render a multi-image hero. */
  images?: string[];
  nextSlot: string;
  icon: LucideIcon;
  slots: string[];
  /** Legacy flat add-ons. Populated from `servicesCatalog[0].addOns` as a
   *  back-compat shim so callers that haven't migrated keep working. New
   *  rendering should read `servicesCatalog` and use each group's own
   *  add-ons list — the flat array can't represent multi-base catalogs
   *  (a salon with both Men's and Women's haircut). */
  addOns: Array<{ id: string; label: string; price: number }>;
  /** Canonical service catalog — one entry per bookable service the
   *  provider offers, each with its own base price and optional add-ons.
   *  Drives the detail-page services list and the booking modal's group
   *  selector. Always has ≥1 entry for service listings (the adapter
   *  synthesizes a single group from legacy `price` + flat `addOns` for
   *  listings that predate the catalog). Empty for stays / transport. */
  servicesCatalog: Array<{
    id: string;
    name: string;
    basePrice: number;
    addOns: Array<{ id: string; label: string; price: number }>;
  }>;
  description: string;
  /** Canonical pricing unit ("per_hour" | "per_visit" | "per_session" |
   *  "per_day" | "fixed" | ""). Drives the "/ session" → "/ hour" copy in
   *  the booking summary. Empty falls back to "session". */
  pricingUnit?: string;
  /** Provider's fixed visit address — only meaningful when `mode` includes
   *  "visit-provider". Used by the detail page to render a "Visit at" card.
   *  Empty for unbooked viewers unless the host opted in to a public address
   *  (metadata.showAddressPublicly) — see geoExact. */
  visitAddress?: string;
  /** Free-text online delivery instructions — only meaningful when `mode`
   *  includes "online". Rendered as a "How the session is delivered" card. */
  meetingDetails?: string;
  /** Service radius in km — at-home services use it to show "Travels up to N
   *  km from <area>". Unset when the listing predates the field. */
  serviceRadiusKm?: number;
  /** Optional coordinates so the redesign can sort services by distance
   *  ("Near me"). Backend rows always have these when geocoded; omitted on
   *  legacy listings without lat/lng. */
  lat?: number;
  lng?: number;
  /** False when the server sent privacy-approximated geo for this viewer
   *  (unbooked): coords rounded ~1km and visitAddress withheld. Mirrors the
   *  stay flag. Default true for legacy/mock rows with no flag. */
  geoExact?: boolean;
  /** Provider profile UUID — the backend's `provider_id` foreign key on the
   *  booking row. The service booking flow forwards this to `createHold` so
   *  the backend can skip the listing→provider lookup, matching the stay
   *  flow exactly. */
  providerProfileId?: string;
  /** Provider-verified flag surfaced for the "Verified only" filter. */
  verified?: boolean;
  /** Host-blocked dates (YYYY-MM-DD). The customer booking modal drops
   *  any slot whose underlying date is in this set so blocked days
   *  can't be picked even if the weekly working-hours grid would
   *  otherwise allow them. */
  blockedDates?: string[];
  /** Languages spoken by the provider — drives the "Languages spoken"
   *  filter when present. */
  languages?: string[];
}

export interface MarketplaceTransport {
  /** Numeric for legacy mocks; backend listings are UUID strings. */
  id: string | number;
  driver: string;
  vehicle: string;
  /** Vehicle colour the host entered at onboarding (`metadata.vehicleColor`).
   *  Shown in the booking summary + transport detail so a rider can spot the
   *  car. Empty string on legacy rows that never collected it. */
  color: string;
  /** Vehicle registration / number plate (`metadata.licensePlate`). Same
   *  rider-identification purpose as `color`; empty on legacy rows. */
  plate: string;
  type: string;
  area: string;
  /** Listing city (backend `listings.city`) — analytics destCity dimension. */
  city?: string;
  /** Driver-authored description from the listing's `description` column.
   *  Rendered on the transport detail page in place of the boilerplate
   *  "Terms & notes" block — so customers see the operator's actual copy
   *  instead of canned text that may or may not apply to this listing. */
  description?: string;
  perKm: number;
  hourly: number;
  day: number;
  rating: number;
  trips: number;
  languages: string[];
  packages: string[];
  image: string;
  /** Full photo gallery surfaced from the listing's `photos` column.
   *  First entry should equal `image`. Used by TransportDetailPage. */
  images?: string[];
  capacity: number;
  packageOptions: Array<{
    id: string;
    label: string;
    price: number;
    hours: number;
    description?: string;
    stops?: Array<{ place: string; dwellMinutes?: number }>;
    distanceKmMin?: number;
    distanceKmMax?: number;
    languages?: string[];
    includes?: string[];
  }>;
  /** Operator's primary offering. "point" is gated/beta in the UI but kept
   *  in the type so adapters round-trip cleanly. Unset on very old rows. */
  transportMode?: TransportMode;
  /** Every booking style the driver enabled during onboarding. Populated
   *  on listings created with the multi-select picker; legacy single-mode
   *  rows leave this undefined and the booking modal falls back to
   *  price-presence inference. */
  transportModes?: TransportMode[];
  /** Optional coordinates so the redesign can sort transport by distance. */
  lat?: number;
  lng?: number;
  /** Driver-declared service radius (km from `lat`/`lng`). The booking
   *  modal uses this to reject pickup addresses that fall outside the
   *  driver's actual coverage — otherwise customers could book a Hyderabad
   *  driver from Mumbai and the driver would get an impossible job. */
  serviceRadiusKm?: number;
  /** Provider profile UUID — the backend's `provider_id` foreign key on the
   *  booking row. Forwarded to `createHold` so the backend can skip the
   *  listing→provider lookup, matching the stay / service flows. */
  providerProfileId?: string;
  /** Driver/provider-verified flag surfaced for the "Verified only" filter. */
  verified?: boolean;
  /** Phase 3: multi-type catalog entries surfaced from
   *  `metadata.transportationTypes`. Each entry carries its own pricing /
   *  details. Legacy listings collapse into a one-entry array derived from
   *  `metadata.transportType` for backward compatibility. The booking
   *  modal shows a sub-type picker when length > 1. */
  transportationTypes?: import("@/lib/transport-types").TransportationTypeEntry[];
  /** Per-weekday working-hours tuples ("HH:MM" start/end) the driver set
   *  during onboarding. Drives the day-strip rendered in the booking modal
   *  and the host dashboard schedule view. Empty / null weekdays render
   *  as "Closed". */
  workingHours?: Record<string, [string, string] | null | undefined>;
  /** Driver-chosen buffer (minutes) between back-to-back trips. The day
   *  strip greys out cells within this radius of an existing booking. */
  bufferMinutes?: number;
  /** Informational flag from onboarding (`metadata.flexibleHours`): the
   *  driver is open to arranging times outside `workingHours`. Surfaces a
   *  "Flexible hours" tag on the detail page; it does NOT change the
   *  bookable slots, which still follow `workingHours`. */
  flexibleHours?: boolean;
  /** Per-date blocks the driver flipped on from the dashboard schedule
   *  view ("YYYY-MM-DD"). The customer date picker disables these dates
   *  so they can't be selected at all. Empty/undefined = nothing
   *  blocked. */
  blockedDates?: string[];
}

export interface MarketplacePriceBreakdown {
  base: number;
  baseLabel: string;
  addOns: Array<{ label: string; amount: number }>;
  taxes: number;
  total: number;
}

export interface MarketplaceBookingOption {
  label: string;
  value: string;
}

export interface MarketplaceBookingDraft {
  kind: MarketplaceKind;
  itemId: string | number;
  title: string;
  subtitle: string;
  image: string;
  date?: string;
  slot?: string;
  mode?: ServiceMode | TransportMode;
  options?: MarketplaceBookingOption[];
  guests?: number;
  contactName?: string;
  contactPhone?: string;
  price: MarketplacePriceBreakdown;
}
