import type { OnboardingProfile } from "@/hooks/useConversationEngine";
import {
  getRegistryMissingFields,
  inferListingType,
  isMultiRoomStay,
  parseDurationHours as parseDurationHoursShared,
} from "@/lib/onboarding/field-registry.shared";

/**
 * FE submit-readiness check for the manual onboarding form.
 *
 * ── ARCHITECTURE ─────────────────────────────────────────────────────────
 * Phase 2: the shared, registry-driven rules live in
 *   `src/lib/onboarding/field-registry.shared.ts`
 * which mirrors the server registry one-for-one. This file is now a thin
 * wrapper: union the registry's missing-fields set with the FE-only
 * extras below.
 *
 * What's FE-only (intentional product divergence — kept here, NOT in the
 * shared registry):
 *   - `description` length / non-empty bar beyond registry minimum
 *     (registry also requires non-empty; FE has no extra length rule,
 *     so nothing to add here — listed for completeness).
 *   - Single-unit stays require `amenities.length >= 5` (search-filter
 *     quality bar, not an invariant).
 *   - Stays require `checkInTime` + `checkOutTime` (booking-email
 *     cosmetic; activation gate doesn't enforce).
 *   - Multi-room stays require `pendingRooms` populated and each room
 *     has `amenities.length >= 3` (multi-room room-types editor state
 *     that doesn't exist on the server).
 *
 * Everything else (category, name, location, description, servicesCatalog,
 * serviceModes-driven visitAddress/meetingDetails, transportMode-driven
 * pricePerHour/Day/packageOptions, workingHours-open-day, etc.) is
 * driven by the shared registry.
 */

// Property types that publish a per-room-type listing rather than a single
// nightly price. Sathrams behave like small lodges — different cells /
// dormitories at different price tiers — so they belong here too.
const MULTI_ROOM_PROPERTY_TYPES = new Set(["hotel", "lodge", "heritage", "sathram"]);
const STAY_CATEGORIES = new Set(["hotel", "homestay", "lodge", "village-stay", "farm-stay", "heritage", "sathram"]);
const isHostCat = (cat: string) => STAY_CATEGORIES.has(cat);

export const ONBOARDING_MISSING_LABELS: Record<string, string> = {
  category: "Category",
  name: "Listing name",
  location: "Address",
  description: "Description",
  price: "Price",
  bedrooms: "Bedrooms",
  maxGuests: "Max guests",
  roomTypes: "Room types",
  transportationTypes: "Transportation types",
  vehicleType: "Vehicle type",
  vehicleName: "Vehicle model",
  seatingCapacity: "Seating capacity",
  experience: "Years of experience",
  languages: "Languages",
  serviceRadius: "Service radius",
  transportMode: "Booking mode",
  pricePerHour: "Hourly rate",
  pricePerDay: "Day rate",
  packageOptions: "Tour packages",
  duration: "Typical job duration",
  pricingUnit: "Pricing unit",
  serviceModes: "Service delivery mode",
  visitAddress: "Visit address",
  meetingDetails: "Online delivery details",
  workingHours: "Weekly working hours",
  amenities: "Amenities",
  roomAmenities: "Amenities (at least 3 per room)",
  roomGuests: "Max guests (per room)",
  roomQuantity: "Number of rooms (per type)",
  roomPhotos: "At least one photo per room",
  checkInTime: "Check-in time",
  checkOutTime: "Check-out time",
  servicesCatalog: "Services catalog",
};

export const missingOnboardingLabel = (key: string) => ONBOARDING_MISSING_LABELS[key] ?? key;

export interface PendingOnboardingRoom {
  name: string;
  pricePerNight: string;
  /** Per-room amenities authored in the room editor. Required for multi-
   *  room stays — the consumer-side stay filter unions them across rooms. */
  amenities?: string[];
  /** Guests one room of this type sleeps. Required (>=1) for multi-room. */
  maxGuests?: number;
  /** How many physical rooms of this type. Required (>=1) for multi-room. */
  quantity?: number;
  /** Per-room photos. At least one is required before publish — matches
   *  the edit-mode RoomTypesManager gate. */
  photos?: string[];
}

export interface OnboardingValidationOptions {
  pendingRooms?: PendingOnboardingRoom[];
  allowedGroups?: Array<"stay" | "transport" | "service">;
}

/** Re-export so callers that imported from here continue to work. */
export const parseDurationHours = parseDurationHoursShared;

export function getOnboardingMissingFields(
  profile: OnboardingProfile,
  options: OnboardingValidationOptions = {},
): Set<string> {
  // 1. Start with the shared registry's missing-field set. Covers every
  //    rule that matches between the server submit_listing tool, the
  //    server activation gate, and what the form needs to enforce
  //    before publish.
  const m = getRegistryMissingFields(profile);

  // 2. Layer on the FE-only extras. These don't exist on the server
  //    because they're UX / search-quality bars, not invariants.
  const portalHost = options.allowedGroups?.length === 1 && options.allowedGroups[0] === "stay";
  const host = isHostCat(profile.category) || portalHost;
  const propertyType = profile.propertyType || profile.category;
  const multiRoom = host && MULTI_ROOM_PROPERTY_TYPES.has(propertyType);

  // Stays: check-in / check-out (booking-email cosmetic — not enforced
  // by listing-readiness, but required by the form).
  if (host) {
    if (!profile.checkInTime) m.add("checkInTime");
    if (!profile.checkOutTime) m.add("checkOutTime");
  }

  // Single-unit stays: amenities >= 5 quality bar.
  if (host && !multiRoom) {
    if ((profile.amenities?.length || 0) < 5) m.add("amenities");
  }

  // Multi-room stays: roomTypes editor state. Every room must clear the
  // same bar as the edit-mode RoomTypesManager — name + price, max guests,
  // room count, >=1 photo, and >=3 amenities — so AI/onboarding-created
  // rooms hold to the same standard as edited ones.
  if (multiRoom) {
    const rooms = options.pendingRooms ?? [];
    const valid = rooms.filter((r) => r.name.trim() && Number(r.pricePerNight) > 0);
    if (rooms.length === 0 || valid.length !== rooms.length) m.add("roomTypes");
    const ROOM_AMENITY_MIN = 3;
    const has = (fn: (r: PendingOnboardingRoom) => boolean) => rooms.length > 0 && rooms.every(fn);
    if (!has((r) => Array.isArray(r.amenities) && r.amenities.length >= ROOM_AMENITY_MIN)) m.add("roomAmenities");
    if (!has((r) => Number(r.maxGuests) >= 1)) m.add("roomGuests");
    if (!has((r) => Number(r.quantity) >= 1)) m.add("roomQuantity");
    if (!has((r) => Array.isArray(r.photos) && r.photos.length >= 1)) m.add("roomPhotos");
  }

  // 3. Multi-room exemptions: registry counts `price`/`bedrooms`/
  //    `maxGuests` as missing for stays, but multi-room stays defer
  //    these to the room-types editor. Strip them out post-hoc — the
  //    registry's `requiredWhen` already skips them for multi-room, so
  //    this is a no-op in practice but documented as a safety net.
  if (host && multiRoom) {
    m.delete("price");
    m.delete("bedrooms");
    m.delete("maxGuests");
  }

  // 4. Transport exemption: the manual form has NO catalog picker — it
  //    collects the vehicle through the legacy `vehicleType` /
  //    `vehicleName` / `seatingCapacity` fields, and the submit path
  //    (useConversationEngine.confirmAndSubmit) synthesizes a single
  //    `transportationTypes[]` entry from those + the driver- category.
  //    So `profile.transportationTypes` is empty until submit, which made
  //    the registry flag "Transportation types" as missing forever — a
  //    phantom requirement with no field to fill. Those three legacy
  //    fields ARE the actionable gate (they stay in the missing set when
  //    blank), so drop the unfillable array key whenever it's empty.
  if (inferListingType(profile) === "transport" && (profile.transportationTypes?.length ?? 0) === 0) {
    m.delete("transportationTypes");
  }

  return m;
}

export function isOnboardingComplete(
  profile: OnboardingProfile,
  options: OnboardingValidationOptions = {},
): boolean {
  return getOnboardingMissingFields(profile, options).size === 0;
}

// Re-exports so existing callers don't have to change import paths.
export { inferListingType, isMultiRoomStay };
