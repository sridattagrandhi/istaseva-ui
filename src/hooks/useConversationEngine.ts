import { useState, useCallback, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Language } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { getOnboardingAssistantService } from "@/domains/chat/onboarding-assistant.service";
import { getListingService } from "@/domains";
import { toast } from "sonner";

export type ActionType = "category_select" | "location_picker" | "photo_upload" | "price_input" | "availability_select" | "none";

export interface ConversationMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  timestamp: Date;
  action?: ActionType;
  options?: { label: string; value: string }[];
}

export type VehicleClass = "walk" | "scooter" | "car" | "van";
/** Per-day window or null for weekly off. Tuple is [start, end] in 24h "HH:MM". */
export type DayWindow = [string, string] | null;
export interface WorkingHours {
  sun: DayWindow; mon: DayWindow; tue: DayWindow; wed: DayWindow;
  thu: DayWindow; fri: DayWindow; sat: DayWindow;
}

/**
 * Parse a free-text availability blurb like "9am to 8pm" / "9:30 - 19:00"
 * into a single [start, end] 24h window. Returns null when no clear range
 * can be read — caller falls back to the existing workingHours.
 *
 * Why this exists: the AI onboarding chat asks "when are you available?"
 * and stores the answer as free text on `availability`. The dashboard's
 * per-day schedule editor reads from a separate `workingHours` JSON which
 * was defaulting to 9-19. Users (rightly) expected the spoken hours to
 * stick, so we extract them at submit time and overwrite the default.
 */
export function parseTimeRange(text: string): [string, string] | null {
  if (!text) return null;
  const re = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|-|–|—|until|till|through)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
  const m = text.match(re);
  if (!m) return null;

  const [, h1, mm1, mer1, h2, mm2, mer2] = m;
  const startH = parseInt(h1, 10);
  const endH = parseInt(h2, 10);
  const startM = mm1 ? parseInt(mm1, 10) : 0;
  const endM = mm2 ? parseInt(mm2, 10) : 0;
  if (Number.isNaN(startH) || Number.isNaN(endH)) return null;
  if (startH > 23 || endH > 23 || startM > 59 || endM > 59) return null;

  // Infer am/pm when missing: if only the end has a meridiem, mirror it.
  // If both are missing and one of the values is plausibly evening (>= 13
  // already in 24h form, e.g. "9 to 17"), keep as 24h. Otherwise assume
  // the second hour is PM when it's <= the first (e.g. "9 to 6").
  const applyMer = (h: number, mer?: string): number | null => {
    if (!mer) return h;
    const lower = mer.toLowerCase();
    if (h < 1 || h > 12) return null;
    if (lower === "am") return h === 12 ? 0 : h;
    return h === 12 ? 12 : h + 12;
  };

  const start = applyMer(startH, mer1);
  let end = applyMer(endH, mer2);
  if (start === null || end === null) return null;

  // No meridiem AND end <= start AND values look 12h-ish → assume end is PM.
  if (!mer1 && !mer2 && end <= start && endH >= 1 && endH <= 11) {
    end = endH + 12;
  }
  // Final sanity: end strictly after start.
  if (end <= start) return null;

  const hh = (n: number) => String(n).padStart(2, "0");
  const mmm = (n: number) => String(n).padStart(2, "0");
  return [`${hh(start)}:${mmm(startM)}`, `${hh(end)}:${mmm(endM)}`];
}

const DAY_KEYS: Array<keyof WorkingHours> = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const EMPTY_WORKING_HOURS: WorkingHours = {
  sun: null, mon: null, tue: null, wed: null, thu: null, fri: null, sat: null,
};

function parseAvailabilityWindow(raw: string): [string, string] | null {
  const range = parseTimeRange(raw);
  if (range) return range;
  const loose = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  return loose ? parseTimeRange(`${loose[1]}${loose[2] ? `:${loose[2]}` : ""}${loose[3] || ""} to ${loose[4]}${loose[5] ? `:${loose[5]}` : ""}${loose[6] || ""}`) : null;
}

function daysForAvailabilityLabel(label: string): Array<keyof WorkingHours> | null {
  const normalized = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (/week\s*days?|monday\s*(?:to|-|–|—)\s*friday|mon\s*(?:to|-|–|—)\s*fri/.test(normalized)) {
    return ["mon", "tue", "wed", "thu", "fri"];
  }
  if (/week\s*ends?|saturday\s*(?:to|-|–|—)\s*sunday|sat\s*(?:to|-|–|—)\s*sun/.test(normalized)) {
    return ["sat", "sun"];
  }
  if (/every\s*day|daily|all\s+days|mon\s*(?:to|-|–|—)\s*sun|monday\s*(?:to|-|–|—)\s*sunday/.test(normalized)) {
    return DAY_KEYS;
  }
  return null;
}

/**
 * Parse day-specific free text into structured hours. Handles phrases like
 * "weekdays 9 am to 5 pm and weekends 12 pm to 8 pm" without flattening the
 * weekend range into the weekday range.
 */
export function parseWorkingHoursFromAvailability(text: string | undefined): WorkingHours | null {
  if (!text) return null;
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (/\b24\s*\/\s*7|24x7|anytime|all\s+week\b/.test(normalized)) {
    return {
      sun: ["00:00", "23:59"], mon: ["00:00", "23:59"], tue: ["00:00", "23:59"],
      wed: ["00:00", "23:59"], thu: ["00:00", "23:59"], fri: ["00:00", "23:59"], sat: ["00:00", "23:59"],
    };
  }

  const out: WorkingHours = { ...EMPTY_WORKING_HOURS };
  let matched = false;
  const clauseRe = /(week\s*days?|week\s*ends?|monday\s*(?:to|-|–|—)\s*friday|mon\s*(?:to|-|–|—)\s*fri|saturday\s*(?:to|-|–|—)\s*sunday|sat\s*(?:to|-|–|—)\s*sun|every\s*day|daily|all\s+days|mon\s*(?:to|-|–|—)\s*sun|monday\s*(?:to|-|–|—)\s*sunday)\s*(?:from|between|:|,)?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:to|-|–|—|until|till|through)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi;
  for (const match of normalized.matchAll(clauseRe)) {
    const days = daysForAvailabilityLabel(match[1]);
    const range = parseAvailabilityWindow(`${match[2]} to ${match[3]}`);
    if (!days || !range) continue;
    matched = true;
    for (const day of days) out[day] = range;
  }
  if (matched) return out;

  const singleRange = parseAvailabilityWindow(normalized);
  if (singleRange) {
    const days =
      /weekends?\s+only|week\s*ends?/.test(normalized) ? ["sat", "sun"] :
      /weekdays?\s+only|week\s*days?|mon\s*(?:to|-|–|—)\s*fri|monday\s*(?:to|-|–|—)\s*friday/.test(normalized) ? ["mon", "tue", "wed", "thu", "fri"] :
      DAY_KEYS;
    const next: WorkingHours = { ...EMPTY_WORKING_HOURS };
    for (const day of days as Array<keyof WorkingHours>) next[day] = singleRange;
    return next;
  }

  if (/weekends?\s+only|week\s*ends?/.test(normalized)) {
    return { ...EMPTY_WORKING_HOURS, sat: ["09:00", "18:00"], sun: ["09:00", "18:00"] };
  }
  if (/weekdays?\s+only|week\s*days?|mon\s*(?:to|-|–|—)\s*fri|monday\s*(?:to|-|–|—)\s*friday/.test(normalized)) {
    return { ...EMPTY_WORKING_HOURS, mon: ["09:00", "18:00"], tue: ["09:00", "18:00"], wed: ["09:00", "18:00"], thu: ["09:00", "18:00"], fri: ["09:00", "18:00"] };
  }
  return null;
}

/**
 * Apply a [start, end] window to every day in `base` that already has hours
 * set (preserves "Sun off" etc.). When no day has hours, applies to all.
 */
export function applyRangeToWorkingHours(base: WorkingHours, range: [string, string]): WorkingHours {
  const hasAny = (Object.values(base) as DayWindow[]).some((v) => v != null);
  const days: (keyof WorkingHours)[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const out: WorkingHours = { ...base };
  for (const d of days) {
    if (hasAny && base[d] == null) continue;
    out[d] = [range[0], range[1]];
  }
  return out;
}

/** Service delivery modes for the mode-aware onboarding flow. Mirrors the
 *  same type exported from `@/types/listings` — kept local here so this
 *  hook stays standalone. */
export type ServiceMode = "at-home" | "visit-provider" | "online";
export type TransportMode = "point" | "hourly" | "day" | "package";

/** One transport package row collected during onboarding. Persisted as
 *  `listings.metadata.packageOptions[]`. All numeric fields stay as strings
 *  here so the inputs don't fight the user mid-typing — they're parsed when
 *  written to metadata. */
/** One stop on a tour package, as edited by the host. `place` is required
 *  on save; `dwellMinutes` (the approx time spent at the stop) is optional
 *  and kept as a string while the user types — parsed to a number at submit. */
export interface OnboardingPackageStop {
  place: string;
  dwellMinutes: string;
}

export interface OnboardingPackageOption {
  id: string;
  label: string;
  price: string;
  hours: string;
  description: string;
  /** Ordered itinerary; min 1 entry required on submit. */
  stops: OnboardingPackageStop[];
  /** Approximate distance range covered over the full tour, in km. Required
   *  on submit; collected as strings to keep the inputs friendly while
   *  typing. */
  distanceKmMin: string;
  distanceKmMax: string;
  /** Per-package language overrides. Optional — when empty the listing-level
   *  languages are used at display time. */
  languages: string[];
}

export interface OnboardingServiceAddOn { id: string; label: string; price: number }
export interface OnboardingServiceGroup {
  id: string;
  name: string;
  basePrice: number;
  addOns: OnboardingServiceAddOn[];
}

export interface OnboardingProfile {
  category: string;
  name: string;
  location: string;
  lat: number;
  lng: number;
  serviceArea: string;
  price: string;
  availability: string;
  description: string;
  photos: string[];
  vehicleName: string;
  vehicleYear: string;
  /** Free-text vehicle type (e.g. "Sedan", "SUV", "Tempo"). Manual
   *  transport onboarding collects this instead of the catalog picker. */
  vehicleType: string;
  /** Free-text seating capacity ("4", "12+1"). String so the input
   *  doesn't fight the user while typing. */
  seatingCapacity: string;
  /** Transport: vehicle colour ("White"). Required — shown to riders in the
   *  booking summary. Persisted to `listings.metadata.vehicleColor`. */
  vehicleColor: string;
  /** Transport: registration / number plate ("KA 01 AB 1234"). Required;
   *  persisted to `listings.metadata.licensePlate` and snapshotted onto the
   *  booking at hold time. */
  licensePlate: string;
  /** Transport: flat per-km rate in rupees as a free-text string ("12/km"). */
  pricePerKm: string;
  /** Transport: whether the driver accepts custom-trip quote requests. */
  acceptsQuotes: boolean;
  duration: string;
  languages: string[];
  experience: string;
  /** Legacy single-value subcategory. New flows write `subcategories` (array)
   *  instead, but we keep this string for back-compat: existing listings have
   *  it, the AI onboarder may still set it, and consumers fall back to it
   *  when the array is empty. Always read both. */
  subcategory: string;
  /** Provider can offer many sub-skills under one listing (a salon does
   *  hair, beard, nails; a tutor teaches math + physics; a driver does
   *  airport + intercity). Stored as an array so the customer filter chips,
   *  AI search rerank, and detail-page tags can show each one independently
   *  instead of jamming them into one comma-separated string. */
  subcategories: string[];
  serviceRadius: number;
  amenities: string[];
  bedrooms: number;
  bathrooms: number;
  maxGuests: number;
  propertyType: string;
  // Stay-only check-in/check-out times. Separate from `availability` (which
  // for stays means year-round / seasonal). "HH:MM" 24-hour strings; empty
  // = unset. Persisted in listings.metadata for now (no schema column).
  checkInTime: string;
  checkOutTime: string;
  // P3 scheduling fields. Service & transport providers only — stays ignore them.
  vehicleClass: VehicleClass;
  maxJobsPerDay: number;
  workingHours: WorkingHours;
  /** Transport only — informational flag the driver sets when they're open
   *  to working outside the weekly hours above by arrangement. Does NOT
   *  relax `workingHours` (slots/conflict checks still honor the schedule);
   *  it surfaces a "Flexible hours" tag on the listing so customers know
   *  they can message the driver to discuss timing after booking. */
  flexibleHours: boolean;
  /** Buffer between back-to-back service bookings, in minutes. Optional —
   *  defaults to 15 server-side when unset. */
  bufferMinutes: number;
  // ---- Service mode-aware onboarding (Phase 1) ----
  /** Which delivery modes the service supports. Multi-select. */
  serviceModes: ServiceMode[];
  /** Provider's fixed address shown to customers when the service is
   *  visit-provider. Optional even when the mode is enabled — providers can
   *  later edit it from the dashboard. */
  visitAddress: string;
  /** WS6 host consent: show the visit address on the PUBLIC listing (walk-in
   *  shop/salon/clinic). Off (default) = shared only after a confirmed
   *  booking, matching the server-side scrub. */
  showAddressPublicly: boolean;
  /** Free-text contact/delivery instructions for online services — meeting
   *  link template, "I will WhatsApp the Zoom link 30m before", etc. */
  meetingDetails: string;
  /** Canonical pricing unit ("per_hour" | "per_visit" | "per_session" |
   *  "per_day" | "fixed" | ""). Empty falls back to the adapter's text
   *  parsing of the `price` field. */
  pricingUnit: string;
  // ---- Transport mode-aware onboarding (Phase 1) ----
  /** Primary transport offering — derived from transportModes[0] when a
   *  driver picks multiple. Kept as a single field for adapter/agent
   *  round-trip compatibility. "point" is gated/beta in the UI. */
  transportMode: TransportMode;
  /** Booking styles the driver supports. Multi-select; populated by the
   *  onboarding form. Adapters that only understand a single mode read
   *  the legacy `transportMode` (= transportModes[0]). */
  transportModes: TransportMode[];
  /** Hourly rate in rupees as free text. */
  pricePerHour: string;
  /** Day rate in rupees as free text. */
  pricePerDay: string;
  /** Predefined tour packages — only used when transportMode === "package". */
  packageOptions: OnboardingPackageOption[];
  /** Phase 3: provider can offer multiple transport types (auto, sedan,
   *  tempo, airport transfer, etc.) per listing. Each entry carries its own
   *  details object (seats, AC, pricing, routes…). The legacy single
   *  `transportType` slug is derived from `transportationTypes[0].type` at
   *  payload-build time for backward compatibility with old readers. */
  transportationTypes: import("@/lib/transport-types").TransportationTypeEntry[];
  /** Service time slots — bookable start times shown on the service detail
   *  page. Auto-generated from working hours + duration when empty, but the
   *  provider can edit / add / remove individual slots. Strings of the form
   *  "Mon 9:00 AM", "Tue 10:30 AM", etc. */
  serviceTimeSlots: string[];
  /** Service only — optional add-ons / sub-services that stack ADDITIVELY
   *  onto the base price at booking (e.g. "Beard trim ₹100" on a haircut).
   *  Empty / omitted for stays + transport. */
  addOns: Array<{ id: string; label: string; price: number }>;
  /** Service only — multi-base services catalog. Each entry is a bookable
   *  service ("Men's haircut") with its own base price and optional add-ons
   *  stacked under it. Replaces the flat top-level `price` + `addOns` for
   *  service listings going forward; stays and transport ignore this. */
  servicesCatalog: OnboardingServiceGroup[];
  /** Multi-room stays only — room catalog the AI agent extracts from chat
   *  so the room-types editor opens PRE-FILLED. The form hydrates its
   *  `pendingRooms` from this on mount (price is ₹/night here; the form
   *  converts to paise on submit). Photos / unit numbers are NOT carried
   *  by the agent — the host adds those in the form. Optional because only
   *  the agent path sets it; the manual form leaves it undefined. */
  roomTypes?: Array<{
    id?: string;
    name: string;
    pricePerNight: number;
    maxGuests?: number;
    quantity?: number;
    bedrooms?: number;
    bathrooms?: number;
    amenities?: string[];
  }>;
}

/** Sensible default — Mon-Sat 09:00-19:00, Sunday off. Mirrors the DB default
 *  so the algorithm behaves identically whether onboarding wrote it or not. */
export const DEFAULT_WORKING_HOURS: WorkingHours = {
  sun: null,
  mon: ["09:00", "19:00"],
  tue: ["09:00", "19:00"],
  wed: ["09:00", "19:00"],
  thu: ["09:00", "19:00"],
  fri: ["09:00", "19:00"],
  sat: ["09:00", "19:00"],
};

export const EMPTY_PROFILE: OnboardingProfile = {
  category: "", name: "", location: "", lat: 0, lng: 0,
  serviceArea: "", price: "", availability: "", description: "",
  photos: [], vehicleName: "", vehicleYear: "", vehicleType: "", vehicleColor: "", licensePlate: "", seatingCapacity: "", pricePerKm: "", acceptsQuotes: true,
  duration: "", languages: [], experience: "", subcategory: "", subcategories: [], serviceRadius: 10,
  amenities: [], bedrooms: 1, bathrooms: 1, maxGuests: 2, propertyType: "",
  checkInTime: "", checkOutTime: "",
  vehicleClass: "scooter", maxJobsPerDay: 6, workingHours: DEFAULT_WORKING_HOURS, flexibleHours: false, bufferMinutes: 15,
  serviceModes: [], visitAddress: "", showAddressPublicly: false, meetingDetails: "", pricingUnit: "",
  transportMode: "hourly", transportModes: [], pricePerHour: "", pricePerDay: "",
  packageOptions: [], serviceTimeSlots: [],
  transportationTypes: [], addOns: [], servicesCatalog: [],
};

const hostCategories = ["hotel", "homestay"];
const transportCategories = [
  "driver-auto", "driver-cab", "driver-bus", "driver-tempo",
  "driver-scooter", "driver-motorcycle",
];

export type OnboardingEntryType = "host" | "service" | "transport" | "any";

/** Coerce a profile patch coming back from the AI agent so it lines up
 *  with the in-form types. The agent's tool schema models
 *  `packageOptions[].price` and `.hours` as numbers (to keep the model
 *  honest about pricing), but the manual editor stores them as strings
 *  while the user is typing — mixing the two would either crash
 *  PackageOptionsEditor or stamp NaN into metadata at submit time.
 *  Pass-through everything else; this is a narrow, surgical fixup. */
export function normalizeAgentPatch(patch: Record<string, unknown>): Record<string, unknown> {
  if (!patch || typeof patch !== "object") return patch;
  const next: Record<string, unknown> = { ...patch };
  if (Array.isArray(patch.packageOptions)) {
    next.packageOptions = patch.packageOptions
      .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
      .map((row, idx): OnboardingPackageOption => {
        // Accept either the new `{ place, dwellMinutes? }[]` shape or the
        // older `string[]` shape the agent might still emit on legacy chats.
        const rawStops: unknown = (row as Record<string, unknown>).stops;
        const stops: OnboardingPackageStop[] = Array.isArray(rawStops)
          ? rawStops
              .map((s): OnboardingPackageStop | null => {
                if (typeof s === "string") {
                  const place = s.trim();
                  return place ? { place, dwellMinutes: "" } : null;
                }
                if (s && typeof s === "object") {
                  const o = s as Record<string, unknown>;
                  const place = typeof o.place === "string" ? o.place.trim() : "";
                  if (!place) return null;
                  const dwell = o.dwellMinutes == null ? "" : String(o.dwellMinutes);
                  return { place, dwellMinutes: dwell };
                }
                return null;
              })
              .filter((s): s is OnboardingPackageStop => !!s)
          : [];
        const rawLangs: unknown = (row as Record<string, unknown>).languages;
        const languages: string[] = Array.isArray(rawLangs)
          ? rawLangs.map((l) => (typeof l === "string" ? l.trim() : "")).filter((s) => s.length > 0)
          : [];
        return {
          id: typeof row.id === "string" && row.id ? row.id : `pkg-${Date.now()}-${idx}`,
          label: typeof row.label === "string" ? row.label : "",
          price: row.price == null ? "" : String(row.price),
          hours: row.hours == null ? "" : String(row.hours),
          description: typeof row.description === "string" ? row.description : "",
          stops,
          distanceKmMin: (row as Record<string, unknown>).distanceKmMin == null
            ? "" : String((row as Record<string, unknown>).distanceKmMin),
          distanceKmMax: (row as Record<string, unknown>).distanceKmMax == null
            ? "" : String((row as Record<string, unknown>).distanceKmMax),
          languages,
        };
      });
  }
  if (Array.isArray(patch.addOns)) {
    next.addOns = patch.addOns
      .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
      .map((row, idx) => {
        const label = typeof row.label === "string" ? row.label.trim() : "";
        const priceNum = Number(row.price);
        return {
          id: typeof row.id === "string" && row.id ? row.id : `addon-${Date.now()}-${idx}`,
          label,
          price: Number.isFinite(priceNum) && priceNum >= 0 ? Math.round(priceNum) : 0,
        };
      })
      .filter((r) => r.label.length > 0);
  }
  if (Array.isArray(patch.servicesCatalog)) {
    const slug = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "svc";
    next.servicesCatalog = patch.servicesCatalog
      .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
      .map((row, idx): OnboardingServiceGroup => {
        const name = typeof row.name === "string" ? row.name.trim() : "";
        const basePrice = Number(row.basePrice);
        const rawAddOns = Array.isArray(row.addOns) ? row.addOns : [];
        const addOns: OnboardingServiceAddOn[] = rawAddOns
          .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
          .map((a, j) => {
            const label = typeof a.label === "string" ? a.label.trim() : "";
            const priceNum = Number(a.price);
            return {
              id: typeof a.id === "string" && a.id ? a.id : `addon-${j + 1}-${slug(label)}`,
              label,
              price: Number.isFinite(priceNum) && priceNum >= 0 ? Math.round(priceNum) : 0,
            };
          })
          .filter((a) => a.label.length > 0);
        return {
          id: typeof row.id === "string" && row.id ? row.id : `svc-${Date.now()}-${idx}`,
          name,
          basePrice: Number.isFinite(basePrice) && basePrice > 0 ? basePrice : 0,
          addOns,
        };
      })
      .filter((g) => g.name.length > 0 && g.basePrice > 0);
  }
  return next;
}

/**
 * Reverse-direction helper: given a structured WorkingHours map, produce
 * a human-readable string ("Mon-Sat, 9 AM - 7 PM"). Used at submit time
 * to back-fill `profile.availability` when the host left the free-text
 * field empty but the per-day grid has data — the pre-filled default in
 * the form (Mon-Sat 9-19) should ship as their availability unless they
 * typed something else.
 *
 * Output strings mirror serializeAvailability in EditListingModal so the
 * dashboard and onboarding agree on phrasing.
 */
function summarizeWorkingHours(wh: WorkingHours | undefined): string {
  if (!wh || typeof wh !== "object") return "";
  const dayOrder: Array<keyof WorkingHours> = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const dayLabels: Record<keyof WorkingHours, string> = {
    mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
  };
  const fmt = (hhmm: string): string => {
    const [h, m] = hhmm.split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
    const period = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return m === 0 ? `${h12} ${period}` : `${h12}:${String(m).padStart(2, "0")} ${period}`;
  };
  const openDays = dayOrder.filter((d) => {
    const v = wh[d];
    return Array.isArray(v) && v.length === 2 && v[0] && v[1];
  });
  if (openDays.length === 0) return "";
  const firstWindow = wh[openDays[0]] as [string, string];
  const allSame = openDays.every((d) => {
    const v = wh[d] as [string, string];
    return v[0] === firstWindow[0] && v[1] === firstWindow[1];
  });
  if (!allSame) return "Flexible hours";
  const [start, end] = firstWindow;
  const window = `${fmt(start)} - ${fmt(end)}`;
  if (openDays.length === 7) return `Daily, ${window}`;
  const weekdays = ["mon", "tue", "wed", "thu", "fri"] as Array<keyof WorkingHours>;
  const weekends = ["sat", "sun"] as Array<keyof WorkingHours>;
  if (weekdays.every((d) => openDays.includes(d)) && openDays.length === 5) {
    return `Mon-Fri, ${window}`;
  }
  if (weekends.every((d) => openDays.includes(d)) && openDays.length === 2) {
    return `Sat-Sun, ${window}`;
  }
  return `${dayLabels[openDays[0]]}-${dayLabels[openDays[openDays.length - 1]]}, ${window}`;
}

/**
 * Last-resort fallback for service listings: if the agent extracted
 * free-text `availability` but never emitted structured `workingHours`,
 * derive a sensible weekly schedule from the text so the booking flow
 * can still surface bookable slots. The agent prompt requires both
 * fields together, but production traces show the model occasionally
 * drops `workingHours` (especially on short answers like "weekdays").
 * Without this fallback, the listing publishes with empty slots and
 * customers can't book.
 */
function deriveWorkingHoursFromAvailability(
  availability: string | undefined,
  existing: WorkingHours | undefined,
): WorkingHours | undefined {
  if (!availability) return existing;
  const parsed = parseWorkingHoursFromAvailability(availability);
  if (parsed) return parsed;
  if (existing && Object.keys(existing).length > 0) return existing;
  const text = availability.toLowerCase();
  const open: [string, string] = ["09:00", "18:00"];
  const closed = null;
  const all: WorkingHours = {
    mon: open, tue: open, wed: open, thu: open, fri: open, sat: open, sun: open,
  };
  if (/\b24\s*\/\s*7|24x7|anytime|all\s+week|every\s*day|whole\s+week\b/.test(text)) return all;
  if (/weekends?\s+only/.test(text)) return { ...all, mon: closed, tue: closed, wed: closed, thu: closed, fri: closed };
  if (/weekdays?\s+only|mon[- ]?fri|monday\s*[-–]\s*friday/.test(text)) return { ...all, sat: closed, sun: closed };
  // Default sensible week: open everyday 09:00–18:00. Better to ship a
  // safe default than ship an empty schedule that breaks bookings.
  return all;
}

/**
 * Pure profile → create-listing payload builder, shared by BOTH creation
 * paths: the self-serve onboarding (confirmAndSubmit below adds the authed
 * userId) and the admin ops console's assisted onboarding (which posts the
 * same payload to /api/admin/listings/for-user for a target host). Keeping
 * this in one place is what stops the two paths from drifting — every field
 * mapping change lands in both automatically.
 */
export function buildListingCreatePayload(
  profile: OnboardingProfile,
  opts: { providerName: string },
) {
  // Phase 3: a non-empty `transportationTypes` array is also a transport
  // signal — covers AI conversations that wrote the new shape without a
  // canonical driver-* category, plus future expansion (driver-transport,
  // catalog ids used directly, etc.). Stays still gate strictly on the
  // legacy host categories.
  const listingType = hostCategories.includes(profile.category)
    ? "stay"
    : transportCategories.includes(profile.category)
      ? "transport"
      : (profile.transportationTypes && profile.transportationTypes.length > 0)
        ? "transport"
        : "service";

  // Phase 3: build the transportationTypes array up-front so the payload
  // object literal below stays flat. Synthesizes a single-entry array
  // from the legacy single-field shape when the manual form's array is
  // empty (AI-onboarding path still uses the old shape).
  const synthesizedTransportationTypes = (() => {
    if (listingType !== "transport") return [] as typeof profile.transportationTypes;
    if (profile.transportationTypes.length > 0) return profile.transportationTypes;
    const rawCategory = profile.category.startsWith("driver-")
      ? profile.category.replace(/^driver-/, "")
      : (profile.category || "");
    if (!rawCategory) return [];
    const mapToCatalogId = (c: string): string => {
      if (c === "cab") return "sedan_cab";
      if (c === "auto") return "auto_rickshaw";
      if (c === "van") return "goods_carrier";
      if (c === "tempo") return "tempo_traveller";
      if (c === "bike") return "bike_taxi";
      return c;
    };
    const fallbackDetails: Record<string, unknown> = {
      basePrice: Number(profile.pricePerHour) || Number(profile.pricePerDay) || Number(profile.pricePerKm) || 1,
    };
    if (profile.vehicleName) fallbackDetails.vehicleName = profile.vehicleName;
    if (profile.vehicleType) fallbackDetails.vehicleType = profile.vehicleType;
    if (profile.seatingCapacity) {
      const seats = Number(profile.seatingCapacity);
      fallbackDetails.seatingCapacity = Number.isFinite(seats) && seats > 0 ? seats : profile.seatingCapacity;
    }
    if (profile.pricePerHour) fallbackDetails.perHourPrice = Number(profile.pricePerHour) || undefined;
    if (profile.pricePerDay) fallbackDetails.perDayPrice = Number(profile.pricePerDay) || undefined;
    if (profile.pricePerKm) fallbackDetails.perKmPrice = Number(profile.pricePerKm) || undefined;
    return [{
      type: mapToCatalogId(rawCategory),
      displayName: rawCategory.charAt(0).toUpperCase() + rawCategory.slice(1),
      details: fallbackDetails as any,
    }];
  })();

  // For service listings, the displayed top-level price is the minimum
  // basePrice across the catalog ("starting from ₹700"). Fall back to the
  // legacy free-text `price` for in-flight drafts where the catalog never
  // got populated and the legacy fee field still carries the answer.
  const derivedServicePrice = (() => {
    if (listingType !== "service") return profile.price;
    const prices = (profile.servicesCatalog || [])
      .map((g) => Number(g.basePrice))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (prices.length === 0) return profile.price;
    return String(Math.min(...prices));
  })();

  return {
    category: profile.category,
    name: profile.name,
    description: profile.description,
    location: profile.location,
    lat: profile.lat,
    lng: profile.lng,
    serviceArea: profile.serviceArea,
    price: derivedServicePrice,
    // If the host never typed an availability string but the structured
    // workingHours grid has data (the form pre-fills DEFAULT_WORKING_HOURS
    // on first render, so this is the common case for hosts who don't
    // edit the schedule), back-fill the free-text field from the grid.
    // What the host saw on screen is what ships.
    availability: profile.availability && profile.availability.trim()
      ? profile.availability
      : summarizeWorkingHours(profile.workingHours),
    photos: profile.photos,
    amenities: profile.amenities,
    // Phase 3 transport: vehicle name moved into per-type details cards.
    // Surface the first non-empty entry's vehicleName as the top-level
    // `listings.vehicle_name` column so old dashboards / search indexes
    // still read a sensible label. Form path keeps `profile.vehicleName`
    // empty by default; AI agent path may still set it directly.
    vehicleName: profile.vehicleName
      || (listingType === "transport"
            ? profile.transportationTypes.find((t) => t.details?.vehicleName?.trim())?.details.vehicleName?.trim() || ""
            : ""),
    vehicleYear: profile.vehicleYear,
    propertyType: listingType === "stay" ? (profile.propertyType || profile.category) : undefined,
    bedrooms: listingType === "stay" ? profile.bedrooms : undefined,
    bathrooms: listingType === "stay" ? profile.bathrooms : undefined,
    maxGuests: listingType === "stay" ? profile.maxGuests : undefined,
    isActive: false, // Starts inactive — goes public after KYC verification
    metadata: {
      listingType,
      providerName: opts.providerName,
      duration: profile.duration,
      languages: profile.languages,
      experience: profile.experience,
      // Write BOTH for back-compat:
      //   - `subcategory` (legacy scalar): first array entry so old readers
      //     (search providers, marketplace adapter fallbacks) still see a
      //     value. Falls back to the free-text field when array is empty.
      //   - `subcategories` (array): the new multi-value source of truth.
      // Empty array writes [] so the filter aggregator can distinguish
      // "host hasn't set any" from "host explicitly cleared them".
      subcategory: (profile.subcategories[0] || profile.subcategory || ""),
      subcategories: profile.subcategories.length > 0
        ? profile.subcategories
        : (profile.subcategory ? [profile.subcategory] : []),
      serviceRadius: profile.serviceRadius,
      // Stay-only check-in / check-out times. Empty strings get dropped
      // server-side; we send them as-is so the dashboard preserves the
      // distinction between "host left it blank" and "host typed it".
      ...(listingType === "stay"
        ? {
            checkInTime: profile.checkInTime,
            checkOutTime: profile.checkOutTime,
          }
        : {}),
      // Service mode-aware fields (Phase 1). Only stamped on service
      // listings; adapters fall back to "at-home" when serviceModes is
      // empty so unmigrated rows still render.
      ...(listingType === "service"
        ? {
            serviceModes: profile.serviceModes,
            pricingUnit: profile.pricingUnit,
            // Scheduling source-of-truth on the listing metadata, so the
            // booking modal can render bookable slots without an extra
            // round-trip to provider_profiles. workingHours + duration are
            // canonical; serviceTimeSlots overrides (when provider adds
            // custom slot strings).
            // Derive a safe weekly schedule from the free-text availability
            // if the agent forgot to emit structured workingHours — otherwise
            // the listing would publish with no bookable slots.
            workingHours: deriveWorkingHoursFromAvailability(profile.availability, profile.workingHours),
            bufferMinutes: profile.bufferMinutes,
            ...(profile.serviceTimeSlots.length > 0
              ? { slots: profile.serviceTimeSlots, serviceTimeSlots: profile.serviceTimeSlots }
              : {}),
            ...(profile.serviceModes.includes("visit-provider") && profile.visitAddress
              ? { visitAddress: profile.visitAddress, showAddressPublicly: profile.showAddressPublicly === true }
              : {}),
            ...(profile.serviceModes.includes("online") && profile.meetingDetails
              ? { meetingDetails: profile.meetingDetails }
              : {}),
            // Services catalog (multi-base). Each group has its own
            // basePrice and stack of optional add-ons. Filter invalid rows
            // and stamp stable ids so the booking modal + backend can match
            // selections by id later. The legacy `addOns` field is mirrored
            // from the first group so downstream surfaces that haven't
            // migrated yet keep rendering something coherent.
            ...(() => {
              const slug = (s: string) =>
                s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "svc";
              const normalizeAddOns = (rows: Array<{ id?: string; label: string; price: number }>): Array<{ id: string; label: string; price: number }> =>
                rows
                  .filter((a) => a && typeof a.label === "string" && a.label.trim() && Number.isFinite(Number(a.price)) && Number(a.price) >= 0)
                  .map((a, i) => ({
                    id: a.id && a.id.trim() ? a.id : `addon-${i + 1}-${slug(a.label)}`,
                    label: a.label.trim(),
                    price: Math.max(0, Math.round(Number(a.price) || 0)),
                  }));
              let groups = (profile.servicesCatalog || [])
                .filter((g) => g && typeof g.name === "string" && g.name.trim() && Number(g.basePrice) > 0)
                .map((g, i) => ({
                  id: g.id && g.id.trim() ? g.id : `svc-${i + 1}-${slug(g.name)}`,
                  name: g.name.trim(),
                  basePrice: Math.round(Number(g.basePrice) || 0),
                  addOns: normalizeAddOns(g.addOns || []),
                }));
              if (groups.length === 0) {
                const legacyAddOns = Array.isArray(profile.addOns) ? profile.addOns : [];
                const legacyPrice = Number(profile.price) || 0;
                if (legacyAddOns.length > 0 || legacyPrice > 0) {
                  const fallbackName = profile.subcategories[0] || profile.name || "Service";
                  groups = [{
                    id: `svc-1-${slug(fallbackName)}`,
                    name: fallbackName,
                    basePrice: legacyPrice > 0 ? Math.round(legacyPrice) : 0,
                    addOns: normalizeAddOns(legacyAddOns),
                  }];
                }
              }
              if (groups.length === 0) return {};
              return {
                servicesCatalog: groups,
                addOns: groups[0]?.addOns ?? [],
              };
            })(),
          }
        : {}),
      ...(listingType === "transport"
        ? {
            workingHours: deriveWorkingHoursFromAvailability(profile.availability, profile.workingHours),
            vehicleClass: profile.vehicleClass,
            // Same buffer concept as services — used by the booking
            // modal's day strip to grey out cells around existing trips.
            bufferMinutes: profile.bufferMinutes,
            pricePerKm: profile.pricePerKm,
            acceptsQuotes: profile.acceptsQuotes,
            // Informational only — drives the "Flexible hours" tag on the
            // listing; does not loosen the workingHours-based slot gate.
            flexibleHours: profile.flexibleHours,
            // Top-level seating capacity from onboarding. The catalog
            // (transportationTypes[].details.seatingCapacity) is the rich
            // per-vehicle source, but we also stamp the host-entered value
            // here so list/card adapters can read seats without parsing
            // the catalog. Falls back to the first catalog entry when the
            // form-level field was left blank (AI-driven flows).
            ...((() => {
              const fromTop = Number(profile.seatingCapacity);
              if (Number.isFinite(fromTop) && fromTop > 0) {
                return { seatingCapacity: fromTop };
              }
              const catalogSeats = profile.transportationTypes
                .map((t) => Number(t.details?.seatingCapacity))
                .find((n) => Number.isFinite(n) && n > 0);
              return catalogSeats != null ? { seatingCapacity: catalogSeats } : {};
            })()),
            // Stamp the host-entered vehicle type at top-level metadata (in
            // addition to transportationTypes[].details.vehicleType) so the
            // edit-listing modal and card adapters can read it directly
            // without parsing the catalog.
            ...(profile.vehicleType && profile.vehicleType.trim()
              ? { vehicleType: profile.vehicleType.trim() }
              : {}),
            // Vehicle colour + number plate — required at onboarding,
            // surfaced in the rider's booking summary and snapshotted onto
            // the booking at hold time. Stored top-level in metadata.
            ...(profile.vehicleColor && profile.vehicleColor.trim()
              ? { vehicleColor: profile.vehicleColor.trim() }
              : {}),
            ...(profile.licensePlate && profile.licensePlate.trim()
              ? { licensePlate: profile.licensePlate.trim() }
              : {}),
            // Phase 3: transportationTypes is synthesized above so the
            // shape is identical regardless of whether the form filled
            // it or we derived it from the legacy single-field shape.
            ...(synthesizedTransportationTypes.length > 0
              ? {
                  transportationTypes: synthesizedTransportationTypes.map((t) => ({
                    type: t.type,
                    displayName: t.displayName,
                    details: t.details,
                  })),
                  transportType: synthesizedTransportationTypes[0].type,
                }
              : {}),
            // Transport mode-aware fields (Phase 1). Stored even when the
            // mode-specific price field is empty so the adapter's "infer
            // mode from populated price" fallback agrees with what the
            // provider actually picked.
            transportMode: profile.transportMode,
            ...((profile.transportModes && profile.transportModes.length > 0)
              ? { transportModes: profile.transportModes }
              : {}),
            ...(profile.pricePerHour ? { pricePerHour: Number(profile.pricePerHour) || 0 } : {}),
            ...(profile.pricePerDay ? { pricePerDay: Number(profile.pricePerDay) || 0 } : {}),
            ...(((profile.transportModes?.includes("package")) || profile.transportMode === "package") && profile.packageOptions.length > 0
              ? {
                  packageOptions: profile.packageOptions
                    .filter((p) => p.label.trim() && Number(p.price) > 0)
                    .map((p) => {
                      const stops = (p.stops ?? [])
                        .map((s) => ({
                          place: (s.place || "").trim(),
                          dwellMinutes: Number(s.dwellMinutes),
                        }))
                        .filter((s) => s.place.length > 0)
                        .map((s) => Number.isFinite(s.dwellMinutes) && s.dwellMinutes > 0
                          ? { place: s.place, dwellMinutes: Math.round(s.dwellMinutes) }
                          : { place: s.place });
                      const minKm = Number(p.distanceKmMin);
                      const maxKm = Number(p.distanceKmMax);
                      const langs = (p.languages ?? [])
                        .map((l) => l.trim())
                        .filter((l) => l.length > 0);
                      return {
                        id: p.id,
                        label: p.label.trim(),
                        price: Number(p.price) || 0,
                        hours: Number(p.hours) || 0,
                        ...(p.description ? { description: p.description } : {}),
                        ...(stops.length > 0 ? { stops } : {}),
                        ...(Number.isFinite(minKm) && minKm > 0 ? { distanceKmMin: minKm } : {}),
                        ...(Number.isFinite(maxKm) && maxKm > 0 ? { distanceKmMax: maxKm } : {}),
                        ...(langs.length > 0 ? { languages: langs } : {}),
                      };
                    }),
                }
              : {}),
          }
        : {}),
    },
  };
}

export function useConversationEngine(
  displayLang: string = "en",
  /** Which portal the user came in through. Forwarded to the agent so it
   *  can frame its first turn around stay vs service vs transport, and
   *  redirect cleanly when the user describes something out of scope. */
  entryType: OnboardingEntryType = "any",
) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  // Mirror messages in a ref so handleInput can build history from the
  // CURRENT list, not whatever closure captured at render time. Without
  // this, fast typing (two sends before a re-render) silently drops the
  // first message from the second turn's history — and the agent loses
  // context across turns. Sync the ref BEFORE render commits (useMemo)
  // rather than after (useEffect) — a second handleInput firing within
  // the same tick would otherwise read a stale ref.
  const messagesRef = useRef<ConversationMessage[]>([]);
  messagesRef.current = messages;

  const [profile, setProfile] = useState<OnboardingProfile>({ ...EMPTY_PROFILE });
  // Same trick for profile — multi-turn context preservation depends on
  // the agent seeing the latest known fields, not a stale closure.
  const profileRef = useRef<OnboardingProfile>({ ...EMPTY_PROFILE });
  profileRef.current = profile;

  // Seed the listing name from the signed-in account once auth resolves, if
  // it's still empty. The name field stays in the profile (customers see it,
  // and a host can rename to a property/business name), but it's pre-filled
  // from the account so the AI never asks for it and the manual form shows
  // it. Functional update reads the latest state, so a resumed draft's name
  // (or a name the user just typed) is never clobbered.
  const seededNameRef = useRef(false);
  useEffect(() => {
    const accountName = user?.name;
    if (seededNameRef.current || !accountName) return;
    seededNameRef.current = true;
    setProfile((p) => (p.name && p.name.trim() ? p : { ...p, name: accountName }));
  }, [user?.name]);

  // Synchronous lock for double-fire prevention. setIsProcessing(true) is
  // queued by React and doesn't take effect until the next commit, so two
  // fast Enter-presses can both pass the `isProcessing` guard before
  // either update lands — agent ends up invoked twice for one message.
  // A ref written synchronously closes that window.
  const isProcessingRef = useRef(false);
  const [currentAction, setCurrentAction] = useState<ActionType>("none");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  // Captured from the create-listing API response so the post-onboarding
  // success screen's "Dashboard" button can deep-link to THIS listing
  // (?listing=<id>) instead of dumping the user on the dashboard root
  // with the first listing in their account preselected.
  const [createdListingId, setCreatedListingId] = useState<string | null>(null);
  // Per-conversation id — minted ONCE when the hook mounts, then
  // shipped with every /api/onboarding-chat request. The backend uses
  // it to thread observability events (audit_events table) across
  // turns of the same conversation. Falling back to a per-request
  // requestId on the server side groups one turn but loses cross-turn
  // linkage. Stored in a ref (not state) so it doesn't trigger renders
  // and stays stable for the hook's lifetime.
  const sessionIdRef = useRef<string>(
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );
  const abortRef = useRef<AbortController | null>(null);

  const isHost = hostCategories.includes(profile.category);
  const isTransport = transportCategories.includes(profile.category);

  const addMessage = useCallback((role: "assistant" | "user", content: string, action?: ActionType, options?: ConversationMessage["options"]) => {
    const msg: ConversationMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role, content, timestamp: new Date(), action, options,
    };
    setMessages(prev => {
      // Drop consecutive duplicate assistant turns — Gemini Live occasionally
      // re-fires a turn_complete after a brief pause and we end up appending
      // the same bubble twice. Compare against the most recent same-role
      // message and skip when the trimmed content matches exactly.
      const last = prev[prev.length - 1];
      const trimmed = content.trim();
      if (last && last.role === role && last.content.trim() === trimmed && trimmed.length > 0) {
        return prev;
      }
      return [...prev, msg];
    });
    return msg;
  }, []);

  const getProgress = useCallback(() => {
    const coreFields = ["category", "name", "location", "serviceArea", "price", "availability", "description"];
    const extraFields: string[] = [];
    if (isTransport) {
      extraFields.push("vehicleName", "vehicleYear", "pricePerKm");
    } else if (isHost) {
      extraFields.push("propertyType", "bedrooms", "bathrooms", "maxGuests");
    } else {
      // service
      extraFields.push("duration", "experience", "subcategory");
    }
    // Languages apply to all
    extraFields.push("languages");
    const fields = [...coreFields, ...extraFields];
    const total = fields.length;
    let filled = 0;
    for (const f of fields) {
      const val = (profile as any)[f];
      if (Array.isArray(val)) { if (val.length > 0) filled++; }
      else if (typeof val === "number") { if (val > 0) filled++; }
      else if (val && typeof val === "string" && val.length > 0) filled++;
    }
    return { filled, total, percent: Math.round((filled / total) * 100) };
  }, [profile, isTransport, isHost]);

  // Call the real AI backend
  const callAI = useCallback(async (conversationMessages: { role: string; content: string }[]): Promise<{
    message: string;
    profile_updates: Record<string, string>;
    action: ActionType;
    is_complete: boolean;
  }> => {
    const result = await getOnboardingAssistantService().respond({
      messages: conversationMessages as Array<{ role: "system" | "user" | "assistant"; content: string }>,
      // Always send the LATEST profile, not the one captured in the
      // useCallback closure. Otherwise a fast second turn ships the
      // pre-extraction state and the agent re-asks fields it already had.
      profile: profileRef.current,
      displayLang,
      entryType,
      // Thread observability events across this conversation's turns.
      sessionId: sessionIdRef.current,
    });

    if (!result.success || !result.data) {
      throw new Error(result.error || "Failed to reach AI assistant");
    }

    return {
      message: result.data.message || "I'm sorry, could you say that again?",
      profile_updates: result.data.profile_updates || {},
      action: result.data.action || "none",
      is_complete: result.data.is_complete || false,
    };
  }, [profile, displayLang, entryType]);

  const handleInput = useCallback(async (input: string) => {
    // Synchronous re-entrancy guard. Without this, two fast Enter presses
    // both see isProcessing=false (it hasn't committed yet) and both fire
    // the agent. Result: two responses per user message, which the user
    // experienced as Sathi asking two different follow-up questions.
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;

    addMessage("user", input);
    setIsProcessing(true);

    try {
      // Build conversation history from the LATEST messages (via ref) +
      // the just-sent user message. Reading state from closure here
      // lost the previous turn whenever the user sent two messages
      // before a re-render — the agent then forgot what the user said
      // a moment ago.
      const history = [...messagesRef.current, { role: "user" as const, content: input, id: "", timestamp: new Date() }]
        .map(m => ({ role: m.role, content: m.content }));

      const result = await callAI(history);

      // Apply profile updates. The agent emits Phase-6 mode-aware fields
      // (packageOptions, etc.) with numeric prices/hours, but the form
      // editor stores those as strings while the user is typing. Normalize
      // here so the typed shape on either path stays consistent.
      if (result.profile_updates && Object.keys(result.profile_updates).length > 0) {
        setProfile(prev => ({ ...prev, ...normalizeAgentPatch(result.profile_updates) }));
      }

      // Set UI action
      setCurrentAction(result.action);

      // Add AI response
      const options = result.action === "availability_select" ? [
        { label: "🟢 Available Now", value: "Available Now" },
        { label: "📅 Weekdays Only", value: "Weekdays Only" },
        { label: "🏖️ Weekends Only", value: "Weekends Only" },
        { label: "⏰ 24/7 Available", value: "24/7 Available" },
        { label: "📞 Book in Advance", value: "Book in Advance" },
        { label: "🔄 Flexible Hours", value: "Flexible Hours" },
      ] : undefined;

      addMessage("assistant", result.message, result.action, options);

      // Check completion
      if (result.is_complete) {
        setTimeout(() => setShowPreview(true), 1500);
      }

      setIsProcessing(false);
      isProcessingRef.current = false;
      return { response: result.message, speakText: result.message };
    } catch (err: any) {
      setIsProcessing(false);
      isProcessingRef.current = false;
      const errorMsg = err?.message?.includes("Rate limited")
        ? "I'm a bit busy right now. Please try again in a moment! 🙏"
        : "Sorry, I had a hiccup. Could you try that again? 🙏";
      addMessage("assistant", errorMsg);
      return { response: errorMsg, speakText: errorMsg };
    }
    // messages/profile read via refs above, so handleInput stays stable.
  }, [addMessage, callAI]);

  const handleCategorySelect = useCallback(async (category: string, label: string) => {
    return handleInput(label);
  }, [handleInput]);

  const handleLocationDetected = useCallback(async (lat: number, lng: number, name: string) => {
    setProfile(prev => ({ ...prev, lat, lng }));
    return handleInput(`My location is ${name}`);
  }, [handleInput]);

  const handleAvailabilitySelect = useCallback(async (value: string) => {
    return handleInput(value);
  }, [handleInput]);

  const startConversation = useCallback(() => {
    const greeting = displayLang === "hi"
      ? "नमस्ते! 👋 मैं Ista AI हूं, आपका IstaSeva सहायक। आप IstaSeva पर क्या ऑफर करना चाहते हैं?"
      : "Hi there! 👋 I'm Ista AI, your IstaSeva assistant. What would you like to offer on IstaSeva?";

    // No auto-picker on start — the voice agent + text input handle category
    // detection conversationally, and showing 14 service tiles eats half the
    // screen on a fresh page. The agent can still call set_picker_action
    // mid-conversation if it decides chips would help (e.g. user says "I
    // don't know what category I am").
    addMessage("assistant", greeting);

    return greeting;
  }, [addMessage, displayLang]);

  const confirmAndSubmit = useCallback(async (extra?: {
    /** Room types to bulk-create after the listing is created.
        Applied when the listing is a multi-room stay (hotel/lodge/heritage).
        Each room type carries its own physical layout (bedrooms/bathrooms/
        sleeps) and an optional list of per-room identifiers. */
    pendingRooms?: Array<{
      name: string;
      description?: string;
      basePricePaise: number;
      maxGuests: number;
      quantity?: number;
      photos: string[];
      bedrooms?: number;
      bathrooms?: number;
      unitIdentifiers?: string[];
      /** Per-room amenities authored in the room-types editor. */
      amenities?: string[];
    }>;
  }) => {
    if (!user?.id) {
      toast.error("Please sign in again before publishing your listing.");
      throw new Error("Missing authenticated user");
    }

    // Payload construction is shared with the admin ops console's assisted
    // onboarding — see buildListingCreatePayload above.
    const payload = buildListingCreatePayload(profile, {
      providerName: user.name || user.email?.split("@")[0] || "Provider",
    });
    const listingType = payload.metadata.listingType;

    const result = await getListingService().create({ userId: user.id, ...payload });

    if (!result.success) {
      toast.error(result.error || "We couldn't publish your listing yet.");
      throw new Error(result.error || "Failed to create listing");
    }

    // Warn-only guardrail nudges (e.g. a street address typed into the
    // public description) — the listing saved; long duration because this is
    // safety advice the host should actually read. Mirrors EditListingModal.
    for (const w of result.warnings ?? []) toast.warning(w, { duration: 10000 });

    // P3: For service & transport providers, also upsert the provider_profile
    // row with the scheduling fields the smart-schedule algorithm needs.
    // Stays don't have provider profiles in the dispatch sense, so we skip
    // them. Failure here is non-fatal — the listing is live, the host can
    // edit scheduling fields later from the dashboard.
    if (listingType !== "stay") {
      try {
        const { apiRequest, getJsonHeaders } = await import("@/lib/api-client");
        await apiRequest("/api/providers/me/profile", {
          method: "PUT",
          headers: getJsonHeaders(),
          body: JSON.stringify({
            display_name: profile.name || user.name,
            service_categories: [profile.category],
            lat: profile.lat || undefined,
            lng: profile.lng || undefined,
            service_radius_km: profile.serviceRadius,
            vehicle_class: profile.vehicleClass,
            max_jobs_per_day: profile.maxJobsPerDay,
            working_hours: (() => {
              // If the user phrased their hours in the chat ("9am to 8pm"),
              // sync that into the per-day workingHours grid so the dashboard
              // editor matches what they actually said. Falls back to the
              // existing structured value when the text can't be parsed.
              return deriveWorkingHoursFromAvailability(profile.availability, profile.workingHours) || profile.workingHours;
            })(),
            buffer_minutes: profile.bufferMinutes,
          }),
        });
      } catch (err) {
        // Don't block the success path — log and surface as a soft warning.
        // eslint-disable-next-line no-console
        console.warn("provider profile upsert failed", err);
      }
    }

    // Bulk-create room types for hotel listings — non-blocking for the success
    // path. If a room creation fails the host can edit/add from the dashboard.
    const createdListing: any = result.data;
    const listingId: string | undefined = createdListing?.id;
    // Multi-room stays (hotel/lodge/heritage) carry per-room layout in
    // listing_room_types. Single-unit stays (homestay/village-stay/
    // farm-stay) get rented as one whole place — no room rows needed.
    // Gate on propertyType, not category, since the StayTypePicker
    // collapses both into a single decision.
    // Sathrams sit under the `homestay` category but expose multiple cell /
    // dormitory tiers and now carry per-room amenities, so they belong in
    // the multi-room creation path alongside hotel/lodge/heritage.
    const isMultiRoomProperty = ['hotel', 'lodge', 'heritage', 'sathram'].includes(profile.propertyType);
    if (listingId && isMultiRoomProperty && extra?.pendingRooms?.length) {
      const svc = getListingService();
      for (let i = 0; i < extra.pendingRooms.length; i++) {
        const r = extra.pendingRooms[i];
        const rr = await svc.createRoomType(listingId, {
          name: r.name,
          description: r.description,
          basePricePaise: r.basePricePaise,
          maxGuests: r.maxGuests,
          quantity: r.quantity ?? 1,
          bedrooms: r.bedrooms ?? 1,
          bathrooms: r.bathrooms ?? 1,
          unitIdentifiers: r.unitIdentifiers ?? [],
          amenities: r.amenities ?? [],
          photos: r.photos,
          sortOrder: i,
        });
        if (!rr.success) {
          // Don't abort — the listing is already live and the host can finish
          // up from the dashboard. Surface the issue so they know.
          toast.warning(`Couldn't add room "${r.name}": ${rr.error || 'unknown error'}. You can add it from the dashboard.`);
        }
      }
    }

    // Make sure the marketplace + host dashboard show the new listing right
    // away. Both surfaces read from React Query; without invalidation, a
    // host who finishes onboarding and immediately opens the dashboard sees
    // a stale "0 listings" until they refresh.
    void queryClient.invalidateQueries({ queryKey: ["my-listings", user?.id] });
    void queryClient.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("marketplace-"),
    });

    // Stash the new listing id so the post-onboarding success screen
    // can deep-link to it. Set BEFORE flipping isComplete so the
    // success screen renders with the id already in state on the same
    // commit (avoids a render where the Dashboard button briefly
    // points at the dashboard root).
    if (listingId) setCreatedListingId(listingId);
    setIsComplete(true);
    setShowPreview(false);
    const successMsg = "🎉 Almost there! Your listing has been created. Complete KYC verification to go live and start receiving bookings!";
    addMessage("assistant", successMsg);
    toast.success("Listing created! Complete verification to go live.");
    return successMsg;
  }, [addMessage, profile, user?.id, queryClient]);

  const getSilenceNudge = useCallback(() => {
    return displayLang === "hi"
      ? "मैं यहां हूं! कोई जल्दी नहीं — बोलिए या टाइप कीजिए।"
      : "Still there? No rush — just speak or type your answer whenever you're ready!";
  }, [displayLang]);

  return {
    messages, profile, currentAction, isProcessing,
    isComplete, showPreview, isHost, isTransport,
    /** Id of the listing just created — set the moment confirmAndSubmit
     *  resolves successfully. Null before any create call. Consumed by
     *  the success screen in AIOnboarding for ?listing=<id> deep-link. */
    createdListingId,
    getProgress, handleInput, handleCategorySelect,
    handleLocationDetected, handleAvailabilitySelect,
    startConversation, confirmAndSubmit,
    setShowPreview, setCurrentAction, getSilenceNudge, addMessage,
    setProfile,
  };
}
