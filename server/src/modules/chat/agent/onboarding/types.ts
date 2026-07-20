/**
 * Onboarding-agent specific extensions to AgentTurnContext.
 *
 * Onboarding tools mutate a shared "profile under construction" state
 * across the loop — extract_fields keeps patching it, submit_listing
 * reads it. The base `AgentTurnContext` is intentionally tool-neutral,
 * so we layer on a typed slot here instead of stuffing fields into
 * `toolResultCache`.
 */
import type { AgentTurnContext } from '../types.js';

/** Mirror of the client OnboardingProfile interface. Loose typing because
 *  the client schema has fields the server never inspects (photos, etc.)
 *  — we just patch + pass back. */
export interface OnboardingProfileState {
  category?: string;
  name?: string;
  location?: string;
  lat?: number;
  lng?: number;
  serviceArea?: string;
  price?: string;
  availability?: string;
  description?: string;
  vehicleName?: string;
  vehicleYear?: string;
  /** Free-text vehicle type collected by manual onboarding ("Sedan"/"SUV"/"Tempo"). */
  vehicleType?: string;
  /** Transport-only: vehicle colour ("White", "Silver"). Required on submit —
   *  surfaced in the booking summary so a rider can spot their car. */
  vehicleColor?: string;
  /** Transport-only: registration / number plate ("KA 01 AB 1234"). Required
   *  on submit; snapshotted onto the booking row at hold time. */
  licensePlate?: string;
  /** Top-level passenger capacity (also lives inside transportationTypes.details). */
  seatingCapacity?: number;
  pricePerKm?: string;
  acceptsQuotes?: boolean;
  duration?: string;
  languages?: string[];
  experience?: string;
  subcategory?: string;
  /** Multi-value sub-skills. Mirrors subcategory[0] when present. Canonical
   *  store for the chip UI / filter aggregator. */
  subcategories?: string[];
  /** Service-only: catalog of bookable services, each with own basePrice
   *  + own optional add-ons. The canonical pricing shape (CLAUDE.md). */
  servicesCatalog?: Array<{
    id?: string;
    name: string;
    basePrice: number;
    addOns: Array<{ id?: string; label: string; price: number }>;
  }>;
  /** Service-only: multi-select delivery modes. */
  serviceModes?: Array<'at-home' | 'visit-provider' | 'online'>;
  /** Service-only: canonical pricing unit so cards can render "₹500/visit"
   *  vs "₹500/hour" cleanly. */
  pricingUnit?: 'per_hour' | 'per_visit' | 'per_session' | 'per_day' | 'fixed';
  /** Service-only: shop/studio/clinic address customers visit. Required
   *  when serviceModes includes "visit-provider". */
  visitAddress?: string;
  /** Service-only, WS6 host consent: true ONLY when the host confirmed the
   *  visit address is walk-in business premises they want on the PUBLIC
   *  listing. Absent/false = shared only after a confirmed booking. */
  showAddressPublicly?: boolean;
  /** Service-only: how customers reach the provider for an online session.
   *  Required when serviceModes includes "online". */
  meetingDetails?: string;
  /** Transport-only: primary booking mode. "point" is beta and intentionally
   *  not selectable. */
  transportMode?: 'hourly' | 'day' | 'package';
  /** Transport-only: hourly rate as a numeric string. Required when
   *  transportMode is "hourly". */
  pricePerHour?: string;
  /** Transport-only: full-day rate as a numeric string. Required when
   *  transportMode is "day". */
  pricePerDay?: string;
  /** Transport-only: predefined tour packages. Required when transportMode
   *  is "package". */
  packageOptions?: Array<{
    id?: string;
    label: string;
    price: number;
    hours?: number;
    description?: string;
    /** Ordered itinerary — at least one named stop required on submit. */
    stops?: Array<{ place: string; dwellMinutes?: number }>;
    /** Distance range in km. Min required on submit; max defaults to min
     *  when the driver gives a single number. */
    distanceKmMin?: number;
    distanceKmMax?: number;
    /** Per-package language overrides; falls back to listing langs. */
    languages?: string[];
  }>;
  serviceRadius?: number;
  /** Single-unit stays: property amenities. Multi-room stays (hotel/lodge/
   *  heritage/sathram): property-WIDE facilities (pool, gym, restaurant,
   *  parking) — in-room amenities live per-room inside roomTypes. */
  amenities?: string[];
  bedrooms?: number;
  bathrooms?: number;
  maxGuests?: number;
  /** Multi-room stays (hotel/lodge/heritage/sathram) only: the room
   *  catalog the host describes in chat. Each entry is one bookable room
   *  CLASS (not one physical room) with its own per-night price and
   *  amenities — the parallel to `servicesCatalog` (services) and
   *  `transportationTypes` (transport). Price is in RUPEES/night; the
   *  client converts to paise and bulk-creates listing_room_types rows on
   *  submit. Photos / unit numbers (101, 8a) stay form-only — the agent
   *  can't capture them. Single-unit stays use property-level
   *  bedrooms/maxGuests/price/amenities instead and leave this empty. */
  roomTypes?: Array<{
    id?: string;
    name: string;
    pricePerNight: number;
    maxGuests?: number;
    /** How many physical rooms of this class the host has. Defaults to 1. */
    quantity?: number;
    /** Bedrooms / bathrooms inside ONE room of this class. */
    bedrooms?: number;
    bathrooms?: number;
    /** Per-room amenities ("AC", "Balcony", ...). The form requires >=3
     *  per room before publish; the agent captures what the host says and
     *  leaves the form as the hard gate. */
    amenities?: string[];
  }>;
  /** Service-only: optional sub-services the customer can add to the base
   *  booking (e.g. {label:"Beard trim", price:100}). Stack additively onto
   *  the base price — the booking modal renders these as checkboxes and
   *  the server re-validates each id at order time. Empty / omitted for
   *  stays and transport. */
  addOns?: Array<{ id?: string; label: string; price: number }>;
  propertyType?: string;
  /** Stay-only daily check-in/check-out times, "HH:MM" 24h. Persisted in
   *  listings.metadata. Distinct from `availability` (which for stays
   *  captures year-round / seasonal openness, not daily arrival times). */
  checkInTime?: string;
  checkOutTime?: string;
  vehicleClass?: 'walk' | 'scooter' | 'car' | 'van';
  maxJobsPerDay?: number;
  workingHours?: Record<string, [string, string] | null>;
  /** Transport-only: informational flag — the driver is open to arranging
   *  trips outside workingHours by talking to the customer. Does not relax
   *  the schedule; surfaces a "Flexible hours" tag on the listing. */
  flexibleHours?: boolean;
  /** Service/transport buffer between back-to-back bookings (minutes). */
  bufferMinutes?: number;
  /** Transport multi-select array of every booking mode enabled. "point"
   *  is intentionally excluded — it's still beta and never selectable
   *  by the agent. */
  transportModes?: Array<'hourly' | 'day' | 'package'>;
  photos?: string[];
  /**
   * Phase 3: catalog-driven transportation types the operator offers,
   * each with its own structured details. The agent emits this directly
   * when the user describes their fleet; the client's
   * useConversationEngine still synthesizes a single-entry fallback from
   * the legacy single-field shape for backward compatibility with old
   * conversations that only set `vehicleName` + a `driver-*` category.
   */
  transportationTypes?: Array<{
    type: string;
    displayName?: string;
    details?: {
      vehicleName?: string;
      seatingCapacity?: number;
      acAvailable?: boolean;
      luggageCapacity?: string;
      goodsCapacityKg?: number;
      pricingUnit?: 'per_km' | 'per_hour' | 'per_day' | 'per_trip' | 'per_package' | 'fixed';
      basePrice?: number;
      perKmPrice?: number;
      perHourPrice?: number;
      perDayPrice?: number;
      operatingAreas?: string;
      routesOrAirports?: string;
      minHours?: number;
      maxHours?: number;
      packageNotes?: string;
      notes?: string;
    };
  }>;
}

/** Picker actions the agent can request the UI to surface this turn.
 *  Same enum as ConversationEngine's ActionType, kept in sync by hand. */
export type OnboardingPickerAction =
  | 'category_select'
  | 'location_picker'
  | 'photo_upload'
  | 'price_input'
  | 'availability_select'
  | 'none';

export interface OnboardingAgentContext extends AgentTurnContext {
  /** Mutable across the loop — extract_fields patches this; submit_listing
   *  reads it; the final reply ships it back to the client to merge. */
  profile: OnboardingProfileState;
  /** Last picker action requested by set_picker_action — surfaced to the
   *  UI on the final reply so it knows what overlay to render. */
  pickerAction: OnboardingPickerAction;
  /** Set by submit_listing on success. The final reply uses presence of
   *  this field as the "done" marker. */
  createdListingId?: string;
}
