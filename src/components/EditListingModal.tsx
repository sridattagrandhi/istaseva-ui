import { useEffect, useRef, useState } from "react";
import { X, MapPin, DollarSign, Clock, FileText, Tag, Plus, Trash2, Globe, Briefcase, Users, BedDouble, Bath, Home, Store, Ruler, ImagePlus, Loader2, Landmark, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { getListingService } from "@/domains";
import type { Listing } from "@/types/domain";
import { toast } from "sonner";
import { getAccessToken } from "@/lib/api-client";
import { buildUploadKey } from "@/lib/storage-key";
import { ChipListInput } from "@/components/ChipListInput";
import { ListingNotReadyDialog, type ListingNotReadyItem } from "./ListingNotReadyDialog";
import { parseWorkingHoursFromAvailability } from "@/hooks/useConversationEngine";
import { totalDwellMinutes, widestWorkingWindowMinutes } from "@/lib/tour-package";
import { useLanguage } from "@/contexts/LanguageContext";

interface EditListingModalProps {
  listing: Listing;
  onClose: () => void;
  onSave: (updated: Listing) => void | Promise<void>;
  /** When the modal is opened from a "listing not ready" activation flow,
   *  pass the structured missing items so the modal can pre-highlight the
   *  offending fields with red borders + scroll the host straight to the
   *  first one. Without this, the host has to scroll an entire form to
   *  hunt for a field they didn't know was missing. */
  initialMissing?: ListingNotReadyItem[];
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Mode-aware constants — kept aligned with the onboarding form so a listing
// edited here round-trips identically to one created via /onboarding.
type ServiceMode = "at-home" | "visit-provider" | "online";
type TransportMode = "point" | "hourly" | "day" | "package";

const SERVICE_MODE_OPTIONS: Array<{ value: ServiceMode; label: string; emoji: string; hint: string }> = [
  { value: "at-home",        label: "At customer's home", emoji: "🏠", hint: "You travel to them" },
  { value: "visit-provider", label: "At your location",   emoji: "🏪", hint: "Customer visits you" },
  { value: "online",         label: "Online / remote",    emoji: "💻", hint: "Video / phone session" },
];

const PRICING_UNIT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "",            label: "Auto / blank" },
  { value: "per_hour",    label: "Per hour" },
  { value: "per_visit",   label: "Per visit" },
  { value: "per_session", label: "Per session" },
  { value: "per_day",     label: "Per day" },
  { value: "fixed",       label: "Fixed price" },
];

// Point ride is intentionally disabled — full routing/pricing isn't built yet.
// Keeping the option visible (with a badge) makes the staged rollout explicit.
const TRANSPORT_MODE_OPTIONS: Array<{
  value: TransportMode; label: string; emoji: string; hint: string; disabled?: boolean; badge?: string;
}> = [
  { value: "hourly",  label: "Hourly rental", emoji: "⏰", hint: "Book by the hour" },
  { value: "day",     label: "Day rental",    emoji: "📅", hint: "Full-day with driver" },
  { value: "package", label: "Tour package",  emoji: "🗺️", hint: "Predefined itineraries" },
  { value: "point",   label: "Point ride",    emoji: "📍", hint: "A → B fixed trip", disabled: true, badge: "Coming soon" },
];

/** One transport package row in the edit modal. Numeric fields stay as
 *  strings while editing so the inputs don't fight the user; they're parsed
 *  back to numbers in the save payload. */
interface EditPackageStop {
  place: string;
  dwellMinutes: string;
}

interface EditPackageOption {
  id: string;
  label: string;
  price: string;
  hours: string;
  description: string;
  stops: EditPackageStop[];
  distanceKmMin: string;
  distanceKmMax: string;
  languages: string[];
}

function metadataToEditPackages(value: unknown): EditPackageOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((o) => o && typeof o === "object")
    .map((o: any, idx) => {
      // Tolerate the legacy `string[]` stops shape as well as the current
      // `{ place, dwellMinutes? }[]` shape so existing listings open
      // cleanly in edit mode.
      const rawStops: unknown = o.stops;
      const stops: EditPackageStop[] = Array.isArray(rawStops)
        ? rawStops
            .map((s): EditPackageStop | null => {
              if (typeof s === "string") {
                const place = s.trim();
                return place ? { place, dwellMinutes: "" } : null;
              }
              if (s && typeof s === "object") {
                const place = typeof (s as any).place === "string" ? (s as any).place.trim() : "";
                if (!place) return null;
                const dwell = (s as any).dwellMinutes == null ? "" : String((s as any).dwellMinutes);
                return { place, dwellMinutes: dwell };
              }
              return null;
            })
            .filter((s): s is EditPackageStop => !!s)
        : [];
      const langs = Array.isArray(o.languages)
        ? o.languages.filter((l: unknown): l is string => typeof l === "string" && l.trim().length > 0)
        : [];
      return {
        id: typeof o.id === "string" && o.id ? o.id : `pkg-${idx + 1}`,
        label: typeof o.label === "string" ? o.label : (typeof o.name === "string" ? o.name : ""),
        price: o.price == null ? "" : String(o.price).replace(/[^\d.]/g, ""),
        hours: o.hours == null ? "" : String(o.hours).replace(/[^\d.]/g, ""),
        description: typeof o.description === "string" ? o.description : "",
        stops: stops.length > 0 ? stops : [{ place: "", dwellMinutes: "" }],
        distanceKmMin: o.distanceKmMin == null ? "" : String(o.distanceKmMin),
        distanceKmMax: o.distanceKmMax == null ? "" : String(o.distanceKmMax),
        languages: langs,
      };
    });
}

function editPackagesToMetadata(rows: EditPackageOption[]): Array<Record<string, unknown>> {
  return rows
    .filter((r) => r.label.trim() && Number(r.price) > 0)
    .map((r) => {
      const stops = r.stops
        .map((s) => ({ place: (s.place || "").trim(), dwellMinutes: Number(s.dwellMinutes) }))
        .filter((s) => s.place.length > 0)
        .map((s) => Number.isFinite(s.dwellMinutes) && s.dwellMinutes > 0
          ? { place: s.place, dwellMinutes: Math.round(s.dwellMinutes) }
          : { place: s.place });
      const minKm = Number(r.distanceKmMin);
      const maxKm = Number(r.distanceKmMax);
      const langs = r.languages.map((l) => l.trim()).filter((l) => l.length > 0);
      return {
        id: r.id,
        label: r.label.trim(),
        price: Number(r.price) || 0,
        hours: Number(r.hours) || 0,
        ...(r.description ? { description: r.description } : {}),
        ...(stops.length > 0 ? { stops } : {}),
        ...(Number.isFinite(minKm) && minKm > 0 ? { distanceKmMin: minKm } : {}),
        ...(Number.isFinite(maxKm) && maxKm > 0 ? { distanceKmMax: maxKm } : {}),
        ...(langs.length > 0 ? { languages: langs } : {}),
      };
    });
}

/** Mirror of the synthesizer in useConversationEngine.confirmAndSubmit.
 *  When the simplified transport form doesn't carry a catalog-shaped
 *  `transportationTypes` array, build a one-entry fallback so backend
 *  readiness passes. Keeps any pre-existing entries on the listing when
 *  they're already non-empty — we only synthesize when the array is empty. */
function synthesizeTransportationTypes(input: {
  category: string;
  vehicleType: string;
  vehicleName: string;
  seatingCapacity: string;
  pricePerHour: string;
  pricePerDay: string;
  existing: unknown[];
}): Array<Record<string, unknown>> {
  if (Array.isArray(input.existing) && input.existing.length > 0) {
    return input.existing as Array<Record<string, unknown>>;
  }
  // category is typed string but is null at runtime for drafts — guard the
  // string ops so editing such a listing can't crash (same class as the
  // MyListings / ListingDetailsModal fixes).
  const rawCategory = input.category?.startsWith("driver-")
    ? input.category.replace(/^driver-/, "")
    : (input.category || "");
  if (!rawCategory) return [];
  const mapToCatalogId = (c: string): string => {
    if (c === "cab") return "sedan_cab";
    if (c === "auto") return "auto_rickshaw";
    if (c === "van") return "goods_carrier";
    if (c === "tempo") return "tempo_traveller";
    if (c === "bike") return "bike_taxi";
    return c;
  };
  const seatsNum = Number(input.seatingCapacity);
  const details: Record<string, unknown> = {
    // Backend requires basePrice > 0; fall back to 1 so the synthesized
    // entry still passes when the driver hasn't priced any mode yet.
    basePrice:
      Number(input.pricePerHour) ||
      Number(input.pricePerDay) ||
      1,
  };
  if (input.vehicleName) details.vehicleName = input.vehicleName;
  if (input.vehicleType) details.vehicleType = input.vehicleType;
  if (Number.isFinite(seatsNum) && seatsNum > 0) details.seatingCapacity = seatsNum;
  if (Number(input.pricePerHour) > 0) details.perHourPrice = Number(input.pricePerHour);
  if (Number(input.pricePerDay) > 0) details.perDayPrice = Number(input.pricePerDay);
  return [{
    type: mapToCatalogId(rawCategory),
    displayName: input.vehicleType || input.vehicleName || rawCategory,
    details,
  }];
}

// Canonical service catalog shape. Mirrors OnboardingProfile.servicesCatalog
// so a listing edited here round-trips to the same data the onboarding flow
// produces. Each group is one bookable service with its own basePrice and
// optional add-ons; the top-level legacy `price` + `metadata.addOns` shim is
// derived from these at save time so older readers keep working.
type ServicesCatalogAddOn = { id: string; label: string; price: number };
type ServicesCatalogGroup = {
  id: string;
  name: string;
  basePrice: number;
  addOns: ServicesCatalogAddOn[];
};

function coerceLegacyToCatalog(
  meta: Record<string, unknown>,
  price: string | number | undefined,
): ServicesCatalogGroup[] {
  const existingRaw = Array.isArray((meta as { servicesCatalog?: unknown }).servicesCatalog)
    ? ((meta as { servicesCatalog?: unknown }).servicesCatalog as unknown[])
    : [];
  if (existingRaw.length > 0) {
    return existingRaw.map((g: any, i) => ({
      id: typeof g?.id === "string" && g.id ? g.id : `svc-${i + 1}`,
      name: typeof g?.name === "string" ? g.name : "",
      basePrice: Number(g?.basePrice) || 0,
      addOns: Array.isArray(g?.addOns)
        ? g.addOns.map((a: any, j: number) => ({
            id: typeof a?.id === "string" && a.id ? a.id : `addon-${i}-${j}`,
            label: typeof a?.label === "string" ? a.label : "",
            price: Number(a?.price) || 0,
          }))
        : [],
    }));
  }
  // Legacy fallback: synthesize one group from price + flat addOns.
  const priceNum =
    Number(typeof price === "string" ? price.replace(/[^\d.]/g, "") : price) || 0;
  const legacyAddOns = Array.isArray((meta as { addOns?: unknown }).addOns)
    ? ((meta as { addOns?: unknown }).addOns as unknown[])
    : [];
  if (priceNum <= 0 && legacyAddOns.length === 0) return [];
  // Prefer the canonical array's first entry; fall back to the legacy scalar
  // for old listings that never wrote `subcategories[]`. This keeps the
  // synthesized group's name meaningful (e.g. "Haircut") instead of the
  // generic "Service" placeholder for any listing predating the catalog.
  const subcatArr = Array.isArray((meta as { subcategories?: unknown }).subcategories)
    ? ((meta as { subcategories?: unknown[] }).subcategories as unknown[])
    : [];
  const subcatFromArr = subcatArr.find((s): s is string => typeof s === "string" && s.trim().length > 0);
  const subcat = subcatFromArr
    ?? (typeof (meta as { subcategory?: unknown }).subcategory === "string"
      ? ((meta as { subcategory?: string }).subcategory as string)
      : "");
  return [
    {
      id: "svc-1",
      name: subcat || "Service",
      basePrice: priceNum,
      addOns: legacyAddOns.map((a: any, j: number) => ({
        id: typeof a?.id === "string" && a.id ? a.id : `addon-1-${j}`,
        label: typeof a?.label === "string" ? a.label : "",
        price: Number(a?.price) || 0,
      })),
    },
  ];
}

function normalizeServiceModes(value: unknown): ServiceMode[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const out: ServiceMode[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const n = item.trim().toLowerCase().replace(/_/g, "-");
    if (n === "at-home" || n === "visit-provider" || n === "online") {
      if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}

function normalizeTransportMode(value: unknown): TransportMode {
  if (typeof value === "string") {
    const n = value.trim().toLowerCase();
    if (n === "hourly" || n === "day" || n === "package" || n === "point") return n;
  }
  return "hourly";
}

const LANGUAGE_OPTIONS = ["English", "Hindi", "Telugu", "Tamil", "Kannada", "Malayalam", "Marathi", "Bengali", "Gujarati", "Punjabi", "Urdu", "Odia"];

const DEFAULT_AMENITIES = ["WiFi", "AC", "TV", "Kitchen", "Parking", "Hot Water", "Power Backup", "Washing Machine", "Balcony", "Garden", "Pool", "Security", "CCTV", "Elevator", "Room Service", "Laundry", "Gym", "Bonfire", "Home Food", "Restaurant", "Pet Friendly"];
// Property-wide facilities for multi-room stays (hotel/lodge/heritage/sathram).
// Multi-room stays don't use the listing-level amenities field for in-room
// amenities (those live per room in the Rooms manager), so it carries the
// shared facilities instead — pool, gym, restaurant — and stays filterable.
const DEFAULT_FACILITIES = ["Pool", "Gym", "Restaurant", "Parking", "Spa", "Bar", "Garden", "Laundry", "Power Backup", "Lift", "Room Service", "Banquet Hall", "Rooftop", "Travel Desk", "EV Charging", "Wheelchair Accessible"];

interface AvailabilityDay {
  enabled: boolean;
  startTime: string;
  endTime: string;
}

function parseAvailabilityToUI(text: string | undefined): AvailabilityDay[] {
  const defaults: AvailabilityDay[] = DAY_LABELS.map(() => ({ enabled: true, startTime: "09:00", endTime: "18:00" }));
  if (!text) return defaults;
  const parsed = parseWorkingHoursFromAvailability(text);
  if (parsed) return workingHoursToAvailDays(parsed);
  const lower = text.toLowerCase().trim();
  if (lower === "weekdays only") return defaults.map((d, i) => ({ ...d, enabled: i >= 1 && i <= 5 }));
  if (lower === "weekends only") return defaults.map((d, i) => ({ ...d, enabled: i === 0 || i === 6 }));
  if (lower === "24/7 available") return defaults.map(d => ({ ...d, startTime: "00:00", endTime: "23:59" }));
  if (lower === "available now" || lower === "flexible hours") return defaults.map(d => ({ ...d, startTime: "08:00", endTime: "20:00" }));
  const match = lower.replace(/\s+/g, " ").match(/^(mon|tue|wed|thu|fri|sat|sun)\s*-\s*(mon|tue|wed|thu|fri|sat|sun),?\s*(\d{1,2})\s*(am|pm)\s*-\s*(\d{1,2})\s*(am|pm)$/i);
  if (match) {
    const dayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const startDay = dayMap[match[1].slice(0, 3)];
    const endDay = dayMap[match[2].slice(0, 3)];
    const to24 = (h: number, m: string) => { if (m === "pm" && h !== 12) return h + 12; if (m === "am" && h === 12) return 0; return h; };
    const sh = to24(parseInt(match[3]), match[4]);
    const eh = to24(parseInt(match[5]), match[6]);
    const st = `${String(sh).padStart(2, "0")}:00`;
    const et = `${String(eh).padStart(2, "0")}:00`;
    return defaults.map((d, i) => {
      let inRange = false;
      for (let day = startDay; ; day = (day + 1) % 7) {
        if (day === i) { inRange = true; break; }
        if (day === endDay) break;
      }
      return { enabled: inRange, startTime: st, endTime: et };
    });
  }
  return defaults;
}

// Match Sunday-first index from DAY_LABELS ("Sun","Mon",...,"Sat") to the
// working-hours JSON key shape ({ mon, tue, wed, thu, fri, sat, sun }).
const WH_KEYS_BY_INDEX: Array<"sun"|"mon"|"tue"|"wed"|"thu"|"fri"|"sat"> = [
  "sun","mon","tue","wed","thu","fri","sat",
];

function availDaysToWorkingHours(days: AvailabilityDay[]): Record<string, [string, string] | null> {
  const out: Record<string, [string, string] | null> = {
    mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
  };
  days.forEach((d, i) => {
    const key = WH_KEYS_BY_INDEX[i];
    if (!key) return;
    out[key] = d.enabled ? [d.startTime, d.endTime] : null;
  });
  return out;
}

function workingHoursToAvailDays(value: unknown): AvailabilityDay[] {
  const defaults: AvailabilityDay[] = DAY_LABELS.map(() => ({ enabled: true, startTime: "09:00", endTime: "18:00" }));
  if (!value || typeof value !== "object") return defaults;
  const obj = value as Record<string, unknown>;
  return WH_KEYS_BY_INDEX.map((key, idx) => {
    const window = obj[key];
    if (!Array.isArray(window) || window.length !== 2 || typeof window[0] !== "string" || typeof window[1] !== "string") {
      return { ...defaults[idx], enabled: false };
    }
    return { enabled: true, startTime: window[0], endTime: window[1] };
  });
}

const SLOT_DAY_LABEL: Record<string, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};
function _fmtTime12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}
function _durationToMinutes(value: string | undefined): number {
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
function deriveSlotsFromAvailDays(days: AvailabilityDay[], duration: string | undefined, bufferMin: number = 15): string[] {
  const durationMin = _durationToMinutes(duration);
  const stride = durationMin + Math.max(0, bufferMin);
  const slots: string[] = [];
  days.forEach((d, i) => {
    if (!d.enabled) return;
    const dayKey = WH_KEYS_BY_INDEX[i];
    if (!dayKey) return;
    const [sh, sm] = d.startTime.split(":").map(Number);
    const [eh, em] = d.endTime.split(":").map(Number);
    if (Number.isNaN(sh) || Number.isNaN(eh)) return;
    let cur = sh * 60 + (sm || 0);
    const stop = eh * 60 + (em || 0);
    while (cur + durationMin <= stop) {
      const h = Math.floor(cur / 60);
      const m = cur % 60;
      slots.push(`${SLOT_DAY_LABEL[dayKey]} ${_fmtTime12(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`)}`);
      cur += stride;
    }
  });
  return slots;
}

function serializeAvailability(days: AvailabilityDay[]): string {
  const enabledDays = days.map((d, i) => d.enabled ? i : -1).filter(i => i >= 0);
  if (enabledDays.length === 0) return "Available Now";
  const allSameTime = days.filter(d => d.enabled).every(d => d.startTime === days[enabledDays[0]].startTime && d.endTime === days[enabledDays[0]].endTime);
  if (!allSameTime) return "Flexible Hours";
  const { startTime, endTime } = days[enabledDays[0]];
  if (enabledDays.length === 7 && startTime === "00:00" && (endTime === "23:59" || endTime === "23:00")) return "24/7 Available";
  if (enabledDays.length === 7) return `Mon-Sun, ${formatTime12(startTime)} - ${formatTime12(endTime)}`;
  const isWeekdays = enabledDays.length === 5 && [1, 2, 3, 4, 5].every(d => enabledDays.includes(d));
  const isWeekends = enabledDays.length === 2 && enabledDays.includes(0) && enabledDays.includes(6);
  if (isWeekdays) return `Mon-Fri, ${formatTime12(startTime)} - ${formatTime12(endTime)}`;
  if (isWeekends) return `Sat-Sun, ${formatTime12(startTime)} - ${formatTime12(endTime)}`;
  const startIdx = enabledDays[0];
  const endIdx = enabledDays[enabledDays.length - 1];
  return `${DAY_LABELS[startIdx]}-${DAY_LABELS[endIdx]}, ${formatTime12(startTime)} - ${formatTime12(endTime)}`;
}

function formatTime12(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${hour12} ${period}` : `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

async function uploadFileToServer(file: File, bucket: string, key: string): Promise<string> {
  const token = await getAccessToken();
  const response = await fetch(`${import.meta.env.VITE_API_URL || ""}/api/storage/upload`, {
    method: "POST",
    headers: {
      "Content-Type": file.type,
      "x-upload-bucket": bucket,
      "x-upload-key": key,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: file,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = typeof err.error === "string" ? err.error : err.error?.message || err.message || "Failed to upload image";
    const uploadError = new Error(msg) as Error & { code?: string };
    uploadError.code = typeof err.error === "object" ? err.error?.code : undefined;
    throw uploadError;
  }
  const result = await response.json();
  return result.publicUrl;
}

const EditListingModal = ({ listing, onClose, onSave, initialMissing }: EditListingModalProps) => {
  const { t } = useLanguage();
  const [form, setForm] = useState({ ...listing });
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [customAmenity, setCustomAmenity] = useState("");
  const [featuresText, setFeaturesText] = useState(() => (listing.metadata?.features || []).join(", "));
  const [availDays, setAvailDays] = useState<AvailabilityDay[]>(() => {
    const structured = listing.metadata?.workingHours;
    return structured && typeof structured === "object"
      ? workingHoursToAvailDays(structured)
      : parseAvailabilityToUI(listing.availability);
  });
  // Photos: mix of existing URL strings and new File uploads
  const [photoItems, setPhotoItems] = useState<{ url?: string; file?: File; preview: string }[]>(
    () => (listing.photos || []).filter(Boolean).map(url => ({ url, preview: url }))
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  // Structured "missing requirements" surfaced as a modal instead of a toast
  // so the host can read the list and act on it. See ListingNotReadyDialog.
  const [notReadyMissing, setNotReadyMissing] = useState<ListingNotReadyItem[] | null>(
    initialMissing && initialMissing.length > 0 ? initialMissing : null,
  );
  // The same `missing` payload, but indexed by `code` for fast lookup so
  // the form can paint red borders on whichever inputs the readiness
  // validator flagged. Cleared on the next save attempt so fixed fields
  // stop showing in red.
  const [missingCodes, setMissingCodes] = useState<Set<string>>(
    () => new Set((initialMissing ?? []).map((m) => m.code)),
  );
  // Scroll the host to the first highlighted field once on mount when the
  // modal was opened from a "not ready" dialog. Without this, the host
  // sees a tall form with no obvious focus point — the failing field
  // could be 1000px down (e.g. transport service radius). RAF gives React
  // a tick to mount the conditional sections before we query the DOM.
  useEffect(() => {
    if (!initialMissing || initialMissing.length === 0) return;
    const id = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(".border-destructive, [data-missing-field='true']");
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(id);
  }, [initialMissing]);
  const has = (code: string) => missingCodes.has(code);
  const RED_FIELD = "border-destructive ring-2 ring-destructive/30";
  const errCls = (code: string) =>
    has(code) ? RED_FIELD : "";
  // Combined highlight: red when the server flagged `code` OR the local
  // pre-save validation recorded `formKey` as missing.
  const errClsLocal = (formKey: string, code?: string) =>
    (formErrors[formKey] || (code && has(code))) ? RED_FIELD : "";
  const clearFormErr = (key: string) =>
    setFormErrors(prev => { if (!prev[key]) return prev; const n = { ...prev }; delete n[key]; return n; });

  const metadata = form.metadata || {};
  const isTransport = [
    "driver-auto", "driver-cab", "driver-bus", "driver-tempo",
    "driver-scooter", "driver-motorcycle",
  ].includes(form.category);
  const isStay = ["hotel", "homestay", "lodge", "village-stay", "farm-stay", "heritage", "sathram"].includes(form.category);
  const isService = !isTransport && !isStay;
  // Multi-room stays cover hotel/lodge/heritage (the `hotel` category bucket)
  // AND sathram (stored as category=`homestay` with property_type=`sathram`).
  // For them, price / max guests / bedrooms / bathrooms / amenities all
  // live on each room type — the property-level inputs would either be
  // meaningless or actively misleading. Single-unit stays keep all of them.
  // `form.propertyType` reads the top-level `listings.property_type` column;
  // metadata fallback covers legacy rows that only stamped it on metadata.
  const stayPropertyType = String(
    form.propertyType
      || (form.metadata as any)?.propertyType
      || form.category
      || ""
  );
  const isMultiRoomStay = isStay && ["hotel", "lodge", "heritage", "sathram"].includes(stayPropertyType);

  // Mode-aware state. Seeded from existing metadata so legacy listings still
  // open the modal cleanly (defaults to ["at-home"] for services and "hourly"
  // for transport when nothing is set). These are written back into metadata
  // inside handleSave so the existing update API doesn't change shape.
  const [serviceModes, setServiceModes] = useState<ServiceMode[]>(
    () => (() => {
      const seeded = normalizeServiceModes(listing.metadata?.serviceModes ?? listing.metadata?.serviceMode);
      return seeded.length > 0 ? seeded : ["at-home"];
    })(),
  );
  // "Where you are" / service-radius / service-area inputs only matter for
  // services where the provider TRAVELS to the customer (at-home mode).
  // For visit-provider only (customer comes to the shop) or online sessions,
  // the shop address is already covered by visitAddress / meetingDetails
  // and there's no travel radius to capture. Mirror the onboarding +
  // customer-facing listing detail behavior here so the edit modal stops
  // asking for location, service area, and service radius in those cases.
  // Empty `serviceModes` falls through to false (treat as legacy → keep
  // fields visible).
  const serviceOnlineOnly =
    isService && serviceModes.length > 0 && !serviceModes.includes("at-home");
  const [pricingUnit, setPricingUnit] = useState<string>(
    typeof listing.metadata?.pricingUnit === "string" ? listing.metadata.pricingUnit : ""
  );
  const [visitAddress, setVisitAddress] = useState<string>(
    typeof listing.metadata?.visitAddress === "string" ? listing.metadata.visitAddress : ""
  );
  const [meetingDetails, setMeetingDetails] = useState<string>(
    typeof listing.metadata?.meetingDetails === "string" ? listing.metadata.meetingDetails : ""
  );
  const [transportMode, setTransportMode] = useState<TransportMode>(
    () => normalizeTransportMode(listing.metadata?.transportMode)
  );
  // Multi-select equivalent — mirrors the onboarding picker. Seeded from
  // metadata.transportModes when present, otherwise from the legacy
  // single-mode field so existing listings still surface what they have.
  const [transportModes, setTransportModes] = useState<TransportMode[]>(() => {
    const raw = (listing.metadata as { transportModes?: unknown })?.transportModes;
    if (Array.isArray(raw)) {
      const allowed: TransportMode[] = ["hourly", "day", "package", "point"];
      const filtered = raw.filter((m): m is TransportMode => allowed.includes(m as TransportMode));
      if (filtered.length > 0) return filtered;
    }
    const single = normalizeTransportMode(listing.metadata?.transportMode);
    return single ? [single] : [];
  });
  const toggleTransportMode = (mode: TransportMode) => {
    if (mode === "point") return; // gated
    setTransportModes((prev) => {
      const next = prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode];
      // Keep the legacy single-mode field in sync with the first selected
      // mode so adapters that only read transportMode stay consistent.
      setTransportMode((next[0] || "hourly") as TransportMode);
      return next;
    });
  };
  const hasTransportMode = (mode: TransportMode) => transportModes.includes(mode);
  // Transport-only top-level fields that the manual onboarding writes
  // directly (vs nested catalog details). Seeded from listing.metadata
  // for listings created via the simplified transport flow.
  const [vehicleType, setVehicleType] = useState<string>(() => {
    const m = listing.metadata as { vehicleType?: unknown; transportationTypes?: unknown } | undefined;
    if (typeof m?.vehicleType === "string" && m.vehicleType.trim()) return m.vehicleType;
    // Older / AI-onboarded listings never stamped a top-level
    // metadata.vehicleType — the value lives inside the synthesized catalog
    // entry (transportationTypes[0].details.vehicleType). Fall back to it so
    // the field isn't blank when editing those listings.
    const first = Array.isArray(m?.transportationTypes) ? (m!.transportationTypes[0] as { details?: { vehicleType?: unknown } }) : null;
    const fromDetails = first?.details?.vehicleType;
    return typeof fromDetails === "string" ? fromDetails : "";
  });
  const [seatingCapacity, setSeatingCapacity] = useState<string>(() => {
    const v = (listing.metadata as { seatingCapacity?: unknown })?.seatingCapacity;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "string") return v;
    return "";
  });
  // Vehicle colour + number plate — required, shown to riders in the booking
  // summary. Seeded from listing.metadata for previously-created listings.
  const [vehicleColor, setVehicleColor] = useState<string>(() => {
    const v = (listing.metadata as { vehicleColor?: unknown })?.vehicleColor;
    return typeof v === "string" ? v : "";
  });
  const [licensePlate, setLicensePlate] = useState<string>(() => {
    const v = (listing.metadata as { licensePlate?: unknown })?.licensePlate;
    return typeof v === "string" ? v : "";
  });
  const [pricePerHour, setPricePerHour] = useState<string>(
    listing.metadata?.pricePerHour != null ? String(listing.metadata.pricePerHour) : ""
  );
  const [pricePerDay, setPricePerDay] = useState<string>(
    listing.metadata?.pricePerDay != null ? String(listing.metadata.pricePerDay) : ""
  );
  const [packageOptions, setPackageOptions] = useState<EditPackageOption[]>(
    () => metadataToEditPackages(listing.metadata?.packageOptions)
  );
  // Service slot state: optional curated overrides on top of working-hours-derived slots.
  // Persisted as metadata.serviceTimeSlots; empty = use derived slots from workingHours + duration.
  const [serviceSlotsCustom, setServiceSlotsCustom] = useState<string[]>(() => {
    const fromMeta = listing.metadata?.serviceTimeSlots ?? listing.metadata?.slots;
    return Array.isArray(fromMeta) ? fromMeta.filter((s: unknown): s is string => typeof s === "string") : [];
  });
  const [showSlotEditor, setShowSlotEditor] = useState(false);
  const [newSlotInput, setNewSlotInput] = useState("");
  const [editingSlotIndex, setEditingSlotIndex] = useState<number | null>(null);
  const [editingSlotDraft, setEditingSlotDraft] = useState("");
  const [bufferMinutes, setBufferMinutes] = useState<number>(() => {
    const v = listing.metadata?.bufferMinutes;
    return typeof v === "number" && v >= 0 ? v : 15;
  });
  // Transport-only informational flag. Accept a real boolean or the string
  // "true" the AI JSON path can emit; anything else (incl. "false") = off.
  const [flexibleHours, setFlexibleHours] = useState<boolean>(() => {
    const v = listing.metadata?.flexibleHours;
    return v === true || v === "true";
  });
  // WS6 host consent: visit addresses are withheld from unbooked viewers
  // unless the host opts in (walk-in shop/salon/clinic). Strict === true —
  // absence means private, matching the server-side scrub.
  const [showAddressPublicly, setShowAddressPublicly] = useState<boolean>(() => {
    const v = listing.metadata?.showAddressPublicly;
    return v === true || v === "true";
  });
  // Services catalog state. Seeded from metadata.servicesCatalog when present,
  // otherwise coerced from legacy `metadata.addOns` + top-level `price` so
  // pre-migration listings render correctly on first edit. Save-time derives
  // legacy `price` + `metadata.addOns` from this state so older readers
  // (listing detail, booking modal) keep working until they're migrated too.
  const [servicesCatalog, setServicesCatalog] = useState<ServicesCatalogGroup[]>(
    () => coerceLegacyToCatalog(listing.metadata || {}, listing.price),
  );

  const updateMeta = (key: string, value: unknown) => {
    setForm(p => ({ ...p, metadata: { ...p.metadata, [key]: value } }));
  };

  const toggleServiceMode = (mode: ServiceMode) => {
    setServiceModes((prev) => prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode]);
  };
  const setTransportModeChecked = (mode: TransportMode) => {
    if (mode === "point") return; // gated
    setTransportMode(mode);
  };
  const patchPackage = (id: string, partial: Partial<EditPackageOption>) =>
    setPackageOptions((prev) => prev.map((r) => (r.id === id ? { ...r, ...partial } : r)));
  const removePackage = (id: string) =>
    setPackageOptions((prev) => prev.filter((r) => r.id !== id));
  const addPackage = () =>
    setPackageOptions((prev) => [
      ...prev,
      {
        id: `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        label: "", price: "", hours: "", description: "",
        stops: [{ place: "", dwellMinutes: "" }],
        distanceKmMin: "", distanceKmMax: "", languages: [],
      },
    ]);
  const patchStop = (pkgId: string, stopIdx: number, partial: Partial<EditPackageStop>) =>
    setPackageOptions((prev) => prev.map((r) => r.id === pkgId
      ? { ...r, stops: r.stops.map((s, i) => i === stopIdx ? { ...s, ...partial } : s) }
      : r));
  const addStop = (pkgId: string) =>
    setPackageOptions((prev) => prev.map((r) => r.id === pkgId
      ? { ...r, stops: [...r.stops, { place: "", dwellMinutes: "" }] }
      : r));
  const removeStop = (pkgId: string, stopIdx: number) =>
    setPackageOptions((prev) => prev.map((r) => r.id === pkgId
      ? { ...r, stops: r.stops.filter((_, i) => i !== stopIdx) }
      : r));

  const toggleLanguage = (lang: string) => {
    const current: string[] = metadata.languages || [];
    const next = current.includes(lang) ? current.filter((l: string) => l !== lang) : [...current, lang];
    updateMeta("languages", next);
  };

  const toggleAmenity = (amenity: string) => {
    const current: string[] = form.amenities || [];
    const next = current.includes(amenity) ? current.filter(a => a !== amenity) : [...current, amenity];
    setForm(p => ({ ...p, amenities: next }));
    setFormErrors(prev => { const n = { ...prev }; delete n.amenities; return n; });
  };

  const addCustomAmenity = () => {
    const trimmed = customAmenity.trim();
    if (!trimmed) return;
    const current: string[] = form.amenities || [];
    if (current.includes(trimmed) || DEFAULT_AMENITIES.includes(trimmed)) {
      toast.error(t("editListing.amenityExists", { defaultValue: "Amenity already exists" }));
      return;
    }
    setForm(p => ({ ...p, amenities: [...(p.amenities || []), trimmed] }));
    setCustomAmenity("");
  };

  // Facilities (multi-room stays) share form.amenities + the customAmenity
  // input — only one of the two pickers renders per listing, so no clash.
  const addCustomFacility = () => {
    const trimmed = customAmenity.trim();
    if (!trimmed) return;
    const current: string[] = form.amenities || [];
    if (current.includes(trimmed) || DEFAULT_FACILITIES.includes(trimmed)) {
      toast.error(t("editListing.facilityExists", { defaultValue: "Facility already exists" }));
      return;
    }
    setForm(p => ({ ...p, amenities: [...(p.amenities || []), trimmed] }));
    setCustomAmenity("");
  };

  // ─── Photo handlers ───
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const validTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
    const maxSize = 5 * 1024 * 1024;
    for (const file of files) {
      if (!validTypes.has(file.type)) { toast.error(t("editListing.photoTypeError", { defaultValue: "{{name}}: Only JPG, PNG, and WebP images are allowed", name: file.name })); return; }
      if (file.size > maxSize) { toast.error(t("editListing.photoSizeError", { defaultValue: "{{name}}: File size must be under 5MB", name: file.name })); return; }
    }
    const newItems = files.map(file => ({ file, preview: URL.createObjectURL(file) }));
    setPhotoItems(prev => [...prev, ...newItems]);
    setFormErrors(prev => { const n = { ...prev }; delete n.photos; return n; });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removePhoto = (index: number) => {
    setPhotoItems(prev => {
      const item = prev[index];
      if (item.file) URL.revokeObjectURL(item.preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  const toggleDay = (index: number) => {
    setAvailDays(prev => prev.map((d, i) => i === index ? { ...d, enabled: !d.enabled } : d));
  };

  const setDayTime = (index: number, field: "startTime" | "endTime", value: string) => {
    setAvailDays(prev => prev.map((d, i) => i === index ? { ...d, [field]: value } : d));
  };

  const applyTimeToAll = () => {
    const first = availDays.find(d => d.enabled);
    if (!first) return;
    setAvailDays(prev => prev.map(d => d.enabled ? { ...d, startTime: first.startTime, endTime: first.endTime } : d));
  };

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = t("editListing.errName", { defaultValue: "Name is required" });
    if (isStay) {
      if (!form.location?.trim()) errors.location = t("editListing.errLocation", { defaultValue: "Location is required" });
      if (photoItems.length < 5) errors.photos = t("editListing.errPhotosMin", { defaultValue: "Minimum 5 photos required ({{count}} added)", count: photoItems.length });
      // Multi-room stays carry amenities per room in the Rooms manager, not
      // on the listing itself. Skip the property-level minimum for them so
      // the modal saves cleanly. Single-unit homestays / village / farm
      // still require at least one amenity.
      if (!isMultiRoomStay && !(form.amenities || []).length) errors.amenities = t("editListing.errAmenities", { defaultValue: "Select at least one amenity" });
    }
    if (isService) {
      if (serviceModes.length === 0) errors.serviceModes = t("editListing.errServiceModes", { defaultValue: "Pick at least one service mode" });
      if (serviceModes.includes("visit-provider") && !visitAddress.trim()) errors.visitAddress = t("editListing.errVisitAddress", { defaultValue: "Visit address is required for 'visit you' mode" });
      if (serviceModes.includes("online") && !meetingDetails.trim()) errors.meetingDetails = t("editListing.errMeetingDetails", { defaultValue: "Online delivery details are required for online mode" });
      const validCatalogGroups = servicesCatalog.filter(
        (g) => g.name.trim().length > 0 && g.basePrice > 0,
      );
      if (validCatalogGroups.length === 0) {
        errors.servicesCatalog = t("editListing.errServicesCatalog", { defaultValue: "Add at least one service with a name and base price" });
      }
    }
    if (isTransport) {
      // Vehicle identity + driver context — mirror the onboarding/activation
      // requirements so a host can't save an incomplete transport listing and
      // the missing fields light up red immediately (not after a server round-trip).
      if (!vehicleType.trim()) errors.vehicleType = t("editListing.errVehicleType", { defaultValue: "Vehicle type is required" });
      if (!(form.vehicleName || "").trim()) errors.vehicleName = t("editListing.errVehicleName", { defaultValue: "Model is required" });
      if (!vehicleColor.trim()) errors.vehicleColor = t("editListing.errVehicleColor", { defaultValue: "Vehicle colour is required" });
      if (!licensePlate.trim()) errors.licensePlate = t("editListing.errLicensePlate", { defaultValue: "Number plate is required" });
      if (!(Number(seatingCapacity) > 0)) errors.seatingCapacity = t("editListing.errSeatingCapacity", { defaultValue: "Seating capacity is required" });
      if (!String(metadata.experience ?? "").trim()) errors.experience = t("editListing.errYearsDriving", { defaultValue: "Years driving is required" });
      if (!(Number(metadata.serviceRadius) > 0)) errors.serviceRadius = t("editListing.errServiceRadius", { defaultValue: "Service radius is required" });
      // "point" stays gated/beta — a saved listing in that mode would be
      // un-bookable, so block it here too (the picker already disables it).
      if (transportMode !== "hourly" && transportMode !== "day" && transportMode !== "package") {
        errors.transportMode = t("editListing.errTransportMode", { defaultValue: "Pick hourly, day, or package — point ride is in beta" });
      }
      if (transportMode === "hourly" && !pricePerHour) errors.pricePerHour = t("editListing.errPricePerHour", { defaultValue: "Hourly rate is required" });
      if (transportMode === "day" && !pricePerDay) errors.pricePerDay = t("editListing.errPricePerDay", { defaultValue: "Day rate is required" });
      if (transportMode === "package" &&
          !packageOptions.some((p) => p.label.trim() && Number(p.price) > 0)) {
        errors.packageOptions = t("editListing.errPackageOptions", { defaultValue: "Add at least one package with a label and price" });
      }
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) {
      // Name the missing fields in the toast so the host doesn't have to
      // hunt for the red outlines. Field keys map 1:1 to user-readable
      // labels — anything not in the map falls back to the key, which is
      // already close to human-readable.
      const FIELD_LABELS: Record<string, string> = {
        name: t("editListing.fieldName", { defaultValue: "Name" }),
        location: t("editListing.fieldLocation", { defaultValue: "Location" }),
        photos: t("editListing.fieldPhotos", { defaultValue: "Photos" }),
        amenities: t("editListing.fieldAmenities", { defaultValue: "Amenities" }),
        serviceModes: t("editListing.fieldServiceMode", { defaultValue: "Service mode" }),
        visitAddress: t("editListing.fieldVisitAddress", { defaultValue: "Visit address" }),
        meetingDetails: t("editListing.fieldOnlineDeliveryDetails", { defaultValue: "Online delivery details" }),
        transportMode: t("editListing.fieldTransportMode", { defaultValue: "Transport mode" }),
        transportationTypes: t("editListing.fieldTransportationTypes", { defaultValue: "Transportation types" }),
        vehicleType: t("editListing.fieldVehicleType", { defaultValue: "Vehicle type" }),
        vehicleName: t("editListing.fieldModel", { defaultValue: "Model" }),
        vehicleColor: t("editListing.fieldVehicleColor", { defaultValue: "Vehicle colour" }),
        licensePlate: t("editListing.fieldLicensePlate", { defaultValue: "Number plate" }),
        seatingCapacity: t("editListing.fieldSeatingCapacity", { defaultValue: "Seating capacity" }),
        pricePerHour: t("editListing.fieldPerHourPrice", { defaultValue: "Per-hour price" }),
        pricePerDay: t("editListing.fieldPerDayPrice", { defaultValue: "Per-day price" }),
        packageOptions: t("editListing.fieldPackageOptions", { defaultValue: "Package options" }),
        servicesCatalog: t("editListing.fieldServicesCatalog", { defaultValue: "Services catalog" }),
        experience: t("editListing.fieldExperience", { defaultValue: "Experience" }),
        serviceRadius: t("editListing.fieldServiceRadius", { defaultValue: "Service radius" }),
        pricingUnit: t("editListing.fieldPricingUnit", { defaultValue: "Pricing unit" }),
        duration: t("editListing.fieldServiceDuration", { defaultValue: "Service duration" }),
        category: t("editListing.fieldCategory", { defaultValue: "Category" }),
      };
      const labels = Object.keys(formErrors).map((k) => FIELD_LABELS[k] || k);
      const summary = labels.length > 0
        ? t("editListing.stillMissing", { defaultValue: "Still missing: {{fields}}.", fields: labels.join(", ") })
        : t("editListing.fixErrorsAbove", { defaultValue: "Please fix the errors above." });
      toast.error(summary);
      // Scroll the first highlighted field into view.
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(".border-destructive, [data-missing-field='true']");
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return;
    }

    // Clear stale missing-field highlights — anything still missing
    // after this save round will be re-flagged by the server response.
    setMissingCodes(new Set());
    setIsSaving(true);
    try {
      // Upload new file-based photos
      setIsUploading(true);
      const photoUrls: string[] = [];
      for (const item of photoItems) {
        if (item.url) {
          photoUrls.push(item.url);
        } else if (item.file) {
          const key = buildUploadKey(`properties/${listing.userId}`, item.file.name);
          try {
            const url = await uploadFileToServer(item.file, "listing-images", key);
            photoUrls.push(url);
          } catch (uploadErr) {
            const e = uploadErr as Error & { code?: string };
            if (e.code === "IMAGE_CONTENT_REJECTED") {
              // Server-side NSFW moderation gate. Drop the rejected photo so
              // the host can pick a replacement, and abort this save — the
              // rest of the form is untouched and can be re-saved.
              setPhotoItems((prev) => prev.filter((p) => p !== item));
              toast.error(`${item.file.name}: ${e.message}`);
              setIsSaving(false);
              setIsUploading(false);
              return;
            }
            throw uploadErr;
          }
        }
      }
      setIsUploading(false);

      // Stays keep `availability` as a free-form string ("Year-round",
      // "Seasonal Oct-March") — they don't have per-day open hours. Only
      // service / transport listings get the per-day grid serialized
      // back. Without this gate, opening a stay in the edit modal and
      // saving would overwrite the year-round string with a meaningless
      // "Sun 09:00-18:00, Mon 09:00-18:00, ..." blob.
      const availabilityText = isStay
        ? (form.availability || "")
        : serializeAvailability(availDays);

      // Service catalog → back-compat shim. Drop invalid rows (no name or
      // non-positive base price) silently, same as onboarding. Derived
      // legacy fields: top-level price = min basePrice across groups;
      // metadata.addOns = the first group's add-ons. These keep older
      // readers (listing detail, marketplace adapter) working until they
      // migrate to read servicesCatalog directly.
      const validCatalogGroups = isService
        ? servicesCatalog
            .filter((g) => g.name.trim().length > 0 && g.basePrice > 0)
            .map((g) => ({
              ...g,
              name: g.name.trim(),
              addOns: g.addOns
                .filter((a) => a.label.trim().length > 0)
                .map((a) => ({ ...a, label: a.label.trim() })),
            }))
        : [];
      const derivedServicePrice = validCatalogGroups.length > 0
        ? String(Math.min(...validCatalogGroups.map((g) => g.basePrice)))
        : (typeof form.price === "string" ? form.price : String(form.price ?? ""));
      const legacyAddOns = validCatalogGroups[0]?.addOns ?? [];

      const result = await getListingService().update(listing.id, {
        name: form.name,
        description: form.description,
        location: form.location,
        serviceArea: form.serviceArea,
        // Services can rename their category in place (custom-category
        // support). Stays / transport are gated above so their category
        // never changes — only the kebab slug from the input survives.
        ...(isService ? { category: form.category } : {}),
        price: isService ? derivedServicePrice : form.price,
        availability: availabilityText,
        photos: photoUrls,
        amenities: form.amenities,
        vehicleName: form.vehicleName,
        vehicleYear: form.vehicleYear,
        propertyType: form.propertyType,
        bedrooms: form.bedrooms,
        bathrooms: form.bathrooms,
        maxGuests: form.maxGuests,
        discountPercent: form.discountPercent,
        metadata: {
          ...metadata,
          features: featuresText.split(",").map(s => s.trim()).filter(Boolean),
          // Mode-aware fields. Stamped on every save so a provider can flip
          // between modes without leaving stale keys around. Mode-specific
          // sub-fields are written conditionally — e.g. visitAddress only
          // when visit-provider is on — so toggling a mode off cleans up
          // the value too (an empty string overwrites the previous one).
          ...(isService
            ? {
                serviceModes,
                pricingUnit,
                visitAddress: serviceModes.includes("visit-provider") ? visitAddress : "",
                // Host consent to publish the visit address to unbooked
                // browsers (WS6). Cleared when visit-provider is toggled off
                // so a stale opt-in can't outlive the address it covered.
                showAddressPublicly: serviceModes.includes("visit-provider") ? showAddressPublicly : false,
                meetingDetails: serviceModes.includes("online") ? meetingDetails : "",
                // Canonical scheduling source: serialize the per-day availability
                // grid into the same shape onboarding writes, so the booking
                // modal can derive bookable slots without an extra lookup.
                workingHours: availDaysToWorkingHours(availDays),
                bufferMinutes,
                // Curated overrides (empty = use derived slots).
                serviceTimeSlots: serviceSlotsCustom,
                slots: serviceSlotsCustom,
                // Canonical service catalog. Back-compat shim: also write
                // metadata.addOns = the first group's add-ons so older
                // readers that haven't migrated yet still see something
                // useful. Both keys overwrite whatever ...metadata had.
                servicesCatalog: validCatalogGroups,
                addOns: legacyAddOns,
              }
            : {}),
          ...(isTransport
            ? {
                transportMode,
                // Backend readiness requires `metadata.transportationTypes`
                // to be a non-empty array with every entry priced. The
                // create path in useConversationEngine synthesizes this
                // from the simplified vehicleType/vehicleName/price fields;
                // edits used to silently leave whatever was in metadata,
                // which failed readiness for listings whose original
                // creation didn't run that synthesis (legacy + AI-onboarded
                // rows). Always rebuild the entry from the current form
                // values so save = create on parity terms.
                transportationTypes: synthesizeTransportationTypes({
                  category: form.category,
                  vehicleType,
                  vehicleName: form.vehicleName || "",
                  seatingCapacity,
                  pricePerHour,
                  pricePerDay,
                  existing: Array.isArray((metadata as { transportationTypes?: unknown }).transportationTypes)
                    ? (metadata as { transportationTypes: unknown[] }).transportationTypes
                    : [],
                }),
                // Multi-select source of truth. Adapters that only know
                // the legacy single field still get transportMode (first
                // selected) — see toggleTransportMode for the sync.
                transportModes,
                // Cast to numbers in metadata so the adapter's `toNumber`
                // path resolves cleanly. Empty input means "unset" — we
                // persist 0 so the field stops contributing to mode
                // inference rather than leaving a stale value behind.
                // Only persist a price for modes that are still enabled
                // — that way deselecting "hourly" in edit zeroes the
                // hourly rate so the booking modal won't offer it.
                pricePerHour: transportModes.includes("hourly") ? Number(pricePerHour) || 0 : 0,
                pricePerDay: transportModes.includes("day") ? Number(pricePerDay) || 0 : 0,
                // Only write packageOptions if package is in the multi-
                // select set. Other states get an empty array so leftover
                // packages don't surface after a deselect.
                packageOptions: transportModes.includes("package")
                  ? editPackagesToMetadata(packageOptions)
                  : [],
                // Top-level fields manual onboarding writes for the
                // simplified transport flow. seatingCapacity coerces to
                // integer when parseable; vehicleType passes through.
                vehicleType: vehicleType.trim(),
                // Vehicle colour + number plate — required identity fields the
                // rider sees in the booking summary.
                vehicleColor: vehicleColor.trim(),
                licensePlate: licensePlate.trim(),
                seatingCapacity: Number(seatingCapacity) > 0 ? Number(seatingCapacity) : 0,
                // Persist the Availability Schedule grid for transport too.
                // It's rendered for both service and transport edits, but
                // the save handler was only writing it under isService —
                // so transport drivers' edits silently dropped. Booking
                // modal + dashboard schedule both read this.
                workingHours: availDaysToWorkingHours(availDays),
                bufferMinutes,
                // Informational tag only — does not change workingHours/slots.
                flexibleHours,
              }
            : {}),
        },
      } as any);

      if (!result.success || !result.data) {
        // Surface the structured `missing` list from the server's readiness
        // validator as a modal — same UX as MyListings activation. A toast
        // gets dismissed before hosts can read the full list.
        const details = result.errorDetails as { missing?: ListingNotReadyItem[] } | undefined;
        if (result.code === "LISTING_NOT_READY" && details?.missing?.length) {
          setNotReadyMissing(details.missing);
          // Drive in-form red borders off the same codes so the host
          // can see exactly which inputs to fix without parsing the
          // modal copy.
          setMissingCodes(new Set(details.missing.map((m) => m.code)));
          return;
        }
        const errMsg = typeof result.error === "string" ? result.error : (result.error as any)?.message || t("editListing.unableToUpdate", { defaultValue: "Unable to update listing" });
        toast.error(errMsg);
        return;
      }

      // Sync the canonical scheduling fields onto the provider_profile row so
      // the backend smart-schedule (which reads provider_profiles.working_hours)
      // agrees with what the booking modal renders. Non-fatal on failure —
      // the listing has already saved.
      if (isService || isTransport) {
        try {
          const { apiRequest, getJsonHeaders } = await import("@/lib/api-client");
          await apiRequest("/api/providers/me/profile", {
            method: "PUT",
            headers: getJsonHeaders(),
            body: JSON.stringify({
              working_hours: availDaysToWorkingHours(availDays),
              ...(isService ? { buffer_minutes: bufferMinutes } : {}),
            }),
          });
        } catch {
          // Listing already saved — provider can re-save to retry the sync.
        }
      }

      await onSave(result.data);
      toast.success(t("editListing.listingUpdated", { defaultValue: "Listing updated!" }));
      // Warn-only guardrail nudges (e.g. a street address typed into the
      // description) — the save succeeded; show them AFTER the success toast
      // so the host reads them as advice, not failure.
      for (const w of result.warnings ?? []) toast.warning(w, { duration: 10000 });
      onClose();
    } catch (err: any) {
      const errMsg = typeof err?.message === "string" ? err.message : t("editListing.failedToSave", { defaultValue: "Failed to save changes" });
      toast.error(errMsg);
    } finally {
      setIsSaving(false);
      setIsUploading(false);
    }
  };

  const allAmenities = [...DEFAULT_AMENITIES, ...(form.amenities || []).filter(a => !DEFAULT_AMENITIES.includes(a))];
  const allFacilities = [...DEFAULT_FACILITIES, ...(form.amenities || []).filter(a => !DEFAULT_FACILITIES.includes(a))];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/50 backdrop-blur-sm" onClick={() => { if (!isSaving) onClose(); }} />
      <div className="relative bg-card rounded-2xl border border-border shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto animate-scale-in p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h3 className="font-display font-bold text-lg">{isStay ? t("editListing.titleProperty", { defaultValue: "Edit Property" }) : isTransport ? t("editListing.titleVehicle", { defaultValue: "Edit Vehicle" }) : t("editListing.titleService", { defaultValue: "Edit Service" })}</h3>
          <button onClick={() => { if (!isSaving) onClose(); }} className="p-1.5 rounded-full hover:bg-muted transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-5">
          {/* Category. For services we let providers rename the category in
              place — onboarding allows free-text custom categories, so the
              edit modal has to round-trip them too. Stays / transport keep a
              read-only badge because their categories drive booking-flow
              gating (room types, transport modes) and shouldn't shift. */}
          {isService ? (
            <div>
              <Label className="text-sm font-medium mb-1.5 flex items-center gap-1">
                <Tag className="w-3.5 h-3.5 text-muted-foreground" />{t("editListing.serviceCategory", { defaultValue: "Service category" })}
              </Label>
              <Input
                value={form.category}
                onChange={(e) => {
                  const slug = e.target.value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
                  setForm((p) => ({ ...p, category: slug }));
                }}
                className="rounded-xl"
                placeholder={t("editListing.serviceCategoryPlaceholder", { defaultValue: "e.g. cleaning, astrologer, drone-pilot" })}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("editListing.storedAs", { defaultValue: "Stored as" })} <code>{form.category || "—"}</code>. {t("editListing.useSubcategoryHint", { defaultValue: "Use Subcategory below for finer detail." })}
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-xl text-sm">
              <Tag className="w-4 h-4 text-primary" />
              {/* Null-safe: a draft's category can be null at runtime. */}
              <span className="font-medium capitalize">{form.category?.replace(/-/g, " ") ?? "—"}</span>
            </div>
          )}

          {/* ─── Basic Info ─── */}
          <div>
            <Label className="text-sm font-medium mb-1.5 flex items-center gap-1"><FileText className="w-3.5 h-3.5 text-muted-foreground" />{t("editListing.nameLabel", { defaultValue: "Name" })} *</Label>
            <Input value={form.name} onChange={e => { setForm(p => ({ ...p, name: e.target.value })); setFormErrors(prev => { const n = { ...prev }; delete n.name; return n; }); }} className={`rounded-xl ${formErrors.name || has("name_required") ? "border-destructive ring-2 ring-destructive/30" : ""}`} />
            {(formErrors.name || has("name_required")) && <p className="text-xs text-destructive mt-1">{formErrors.name || t("editListing.addListingName", { defaultValue: "Add a listing name." })}</p>}
          </div>

          <div>
            <Label className="text-sm font-medium mb-1.5">{t("editListing.descriptionLabel", { defaultValue: "Description" })}{has("description_required") && " *"}</Label>
            <Textarea value={form.description || ""} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} className={`rounded-xl ${errCls("description_required")}`} rows={3} placeholder={t("editListing.descriptionPlaceholder", { defaultValue: "Describe what makes this listing special..." })} />
            {has("description_required") && <p className="text-xs text-destructive mt-1">{t("editListing.addDescription", { defaultValue: "Add a description." })}</p>}
          </div>

          {/* Online-only services have no physical base — hide the whole
              Location + Service Area block for them. Stays, transport, and
              services with at-home/visit-provider still see it. */}
          {!serviceOnlineOnly && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium mb-1.5 flex items-center gap-1"><MapPin className="w-3.5 h-3.5 text-muted-foreground" />{t("editListing.locationLabel", { defaultValue: "Location" })} {(isStay || has("location_required")) && "*"}</Label>
                <Input value={form.location || ""} onChange={e => { setForm(p => ({ ...p, location: e.target.value })); setFormErrors(prev => { const n = { ...prev }; delete n.location; return n; }); }} className={`rounded-xl ${formErrors.location || has("location_required") ? "border-destructive ring-2 ring-destructive/30" : ""}`} placeholder={t("editListing.locationPlaceholder", { defaultValue: "e.g. Coorg, Karnataka" })} />
                {(formErrors.location || has("location_required")) && <p className="text-xs text-destructive mt-1">{formErrors.location || t("editListing.addLocation", { defaultValue: "Add a location/address." })}</p>}
                <p className="text-xs text-muted-foreground mt-1">
                  {t("editListing.locationPrivacyHint", { defaultValue: "Include the full street address — browsers only ever see \"City, State\"; the exact address is shared only after a confirmed booking." })}
                </p>
              </div>
              {!isStay && (
                <div>
                  <Label className="text-sm font-medium mb-1.5">{t("editListing.serviceAreaLabel", { defaultValue: "Service Area" })}</Label>
                  <Input value={form.serviceArea || ""} onChange={e => setForm(p => ({ ...p, serviceArea: e.target.value }))} className="rounded-xl" placeholder={t("editListing.serviceAreaPlaceholder", { defaultValue: "e.g. All of Hyderabad" })} />
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            {/* Multi-room stays (hotel/lodge/heritage/sathram) carry price
                on each room type — the property-level "Price / night" input
                is meaningless for them. Hide it so the modal matches the
                onboarding form, which already drops the property-level
                price for these categories. */}
            {!isMultiRoomStay && !isService && !isTransport && (
              <div>
                <Label className="text-sm font-medium mb-1.5 flex items-center gap-1"><DollarSign className="w-3.5 h-3.5 text-muted-foreground" />{t("editListing.priceLabel", { defaultValue: "Price" })} {isStay ? t("editListing.pricePerNightUnit", { defaultValue: "(₹ / night)" }) : t("editListing.priceRupeeUnit", { defaultValue: "(₹)" })}</Label>
                <Input type="number" value={typeof form.price === "string" ? form.price.replace(/[^0-9.]/g, "").match(/[\d.]+/)?.[0] || "" : form.price || ""} onChange={e => setForm(p => ({ ...p, price: e.target.value }))} className="rounded-xl" placeholder={t("editListing.pricePlaceholder", { defaultValue: "e.g. 1200" })} />
              </div>
            )}
            {isStay && (
              <div>
                <Label className="text-sm font-medium mb-1.5 flex items-center gap-1">{t("editListing.hostDiscount", { defaultValue: "Host Discount (%)" })}</Label>
                <Input
                  type="number"
                  min={0}
                  max={90}
                  value={form.discountPercent ?? 0}
                  onChange={e => {
                    const v = Math.max(0, Math.min(90, Number(e.target.value) || 0));
                    setForm(p => ({ ...p, discountPercent: v }));
                  }}
                  className="rounded-xl"
                  placeholder="0"
                />
                <p className="text-[11px] text-muted-foreground mt-1">{t("editListing.hostDiscountHint", { defaultValue: "Shows as a strikethrough + \"% off\" badge on your listing. 0 = no discount." })}</p>
              </div>
            )}
            {isService && (
              <>
                <div>
                  <Label className="text-sm font-medium mb-1.5 flex items-center gap-1"><Clock className="w-3.5 h-3.5 text-muted-foreground" />{t("editListing.durationLabel", { defaultValue: "Duration" })}</Label>
                  <Input value={metadata.duration || ""} onChange={e => updateMeta("duration", e.target.value)} className="rounded-xl" placeholder={t("editListing.durationPlaceholder", { defaultValue: "e.g. 1 hour, 30 mins" })} />
                </div>
                <div>
                  <Label className="text-sm font-medium mb-1.5 flex items-center gap-1"><Clock className="w-3.5 h-3.5 text-muted-foreground" />{t("editListing.bufferJobsLabel", { defaultValue: "Buffer between jobs (min)" })}</Label>
                  <Input
                    type="number"
                    min={0}
                    max={240}
                    value={String(bufferMinutes)}
                    onChange={e => {
                      const v = Number(e.target.value);
                      setBufferMinutes(Number.isFinite(v) ? Math.max(0, Math.min(240, Math.round(v))) : 15);
                    }}
                    className="rounded-xl"
                    placeholder="15"
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">{t("editListing.bufferJobsHint", { defaultValue: "Extra minutes between back-to-back bookings (travel, prep). Default 15." })}</p>
                </div>
              </>
            )}
          </div>

          {/* ─── Stay-specific fields ─── */}
          {isStay && (
            <div className="space-y-4 border-t border-border pt-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t("editListing.propertyDetails", { defaultValue: "Property Details" })}</p>
              {/* For multi-room stays the layout numbers (max-guests /
                  bedrooms / bathrooms) live on each ROOM type. Only show
                  the Type picker so the host can correct the propertyType
                  if needed; the rest is handled in the Rooms manager. */}
              <div className={`grid gap-3 ${isMultiRoomStay ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-2 sm:grid-cols-4"}`}>
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><Home className="w-3 h-3" />{t("editListing.typeLabel", { defaultValue: "Type" })}</Label>
                  <select value={form.propertyType || form.category} onChange={e => setForm(p => ({ ...p, propertyType: e.target.value }))}
                    className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20 outline-none">
                    <option value="hotel">{t("editListing.typeHotel", { defaultValue: "Hotel" })}</option>
                    <option value="homestay">{t("editListing.typeHomestay", { defaultValue: "Homestay" })}</option>
                    <option value="lodge">{t("editListing.typeLodge", { defaultValue: "Lodge" })}</option>
                    <option value="village-stay">{t("editListing.typeVillageStay", { defaultValue: "Village Stay" })}</option>
                    <option value="farm-stay">{t("editListing.typeFarmStay", { defaultValue: "Farm Stay" })}</option>
                    <option value="heritage">{t("editListing.typeHeritage", { defaultValue: "Heritage" })}</option>
                    <option value="sathram">{t("editListing.typeSathram", { defaultValue: "Sathram" })}</option>
                  </select>
                </div>
                {!isMultiRoomStay && (
                  <>
                    <div>
                      <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><Users className="w-3 h-3" />{t("editListing.maxGuests", { defaultValue: "Max Guests" })}</Label>
                      <Input type="number" min={1} value={form.maxGuests || ""} onChange={e => setForm(p => ({ ...p, maxGuests: parseInt(e.target.value) || 1 }))} className="rounded-xl" />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><BedDouble className="w-3 h-3" />{t("editListing.bedrooms", { defaultValue: "Bedrooms" })}</Label>
                      <Input type="number" min={1} value={form.bedrooms || ""} onChange={e => setForm(p => ({ ...p, bedrooms: parseInt(e.target.value) || 1 }))} className="rounded-xl" />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><Bath className="w-3 h-3" />{t("editListing.bathrooms", { defaultValue: "Bathrooms" })}</Label>
                      <Input type="number" min={1} value={form.bathrooms || ""} onChange={e => setForm(p => ({ ...p, bathrooms: parseInt(e.target.value) || 1 }))} className="rounded-xl" />
                    </div>
                  </>
                )}
                {isMultiRoomStay && (
                  <p className="text-[11px] text-muted-foreground self-end sm:col-span-1">
                    {t("editListing.multiRoomCapacityHintPre", { defaultValue: "Capacity, bedrooms, bathrooms, and price live on each room type. Use the" })} <strong>{t("editListing.roomsButton", { defaultValue: "Rooms" })}</strong> {t("editListing.multiRoomCapacityHintPost", { defaultValue: "button on the listing card to edit them." })}
                  </p>
                )}
              </div>

            </div>
          )}

          {/* ─── Amenities (single-unit stays only) ───
              Multi-room properties (hotel/lodge/heritage/sathram) author
              amenities PER ROOM in the dedicated Rooms manager. Showing a
              property-level amenity picker on top of that forced every room
              to share the same set, which doesn't match reality. */}
          {isStay && !isMultiRoomStay && (
            <div>
              <Label className="text-sm font-medium mb-1.5">{t("editListing.amenitiesLabel", { defaultValue: "Amenities" })} *</Label>
              <div className="flex flex-wrap gap-2 mb-3">
                {allAmenities.map(a => (
                  <button key={a} type="button" onClick={() => toggleAmenity(a)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all ${
                      (form.amenities || []).includes(a)
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "bg-muted/60 text-muted-foreground hover:bg-primary/10 hover:text-foreground"
                    }`}>
                    {a}
                    {(form.amenities || []).includes(a) && !DEFAULT_AMENITIES.includes(a) && <X className="w-3 h-3" />}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <Input type="text" value={customAmenity} onChange={e => setCustomAmenity(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addCustomAmenity(); } }}
                  placeholder={t("editListing.addCustomAmenity", { defaultValue: "Add custom amenity..." })} className="flex-1 rounded-xl" />
                <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={addCustomAmenity}>
                  <Plus className="w-4 h-4 mr-1" /> {t("editListing.add", { defaultValue: "Add" })}
                </Button>
              </div>
              {formErrors.amenities && <p className="text-xs text-red-500 mt-1">{formErrors.amenities}</p>}
            </div>
          )}

          {/* ─── Hotel facilities (multi-room stays) ───
              Property-WIDE facilities — the pool/gym/restaurant the whole
              hotel shares. Stored in the listing-level amenities field
              (unused for in-room amenities on multi-room stays, which live
              per room in the Rooms manager). Optional. */}
          {isStay && isMultiRoomStay && (
            <div>
              <Label className="text-sm font-medium mb-1.5">{t("editListing.hotelFacilities", { defaultValue: "Hotel facilities" })}</Label>
              <p className="text-xs text-muted-foreground mb-2">{t("editListing.hotelFacilitiesHint", { defaultValue: "Shared facilities guests can use — separate from in-room amenities, which live on each room type." })}</p>
              <div className="flex flex-wrap gap-2 mb-3">
                {allFacilities.map(a => (
                  <button key={a} type="button" onClick={() => toggleAmenity(a)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all ${
                      (form.amenities || []).includes(a)
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "bg-muted/60 text-muted-foreground hover:bg-primary/10 hover:text-foreground"
                    }`}>
                    {a}
                    {(form.amenities || []).includes(a) && !DEFAULT_FACILITIES.includes(a) && <X className="w-3 h-3" />}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <Input type="text" value={customAmenity} onChange={e => setCustomAmenity(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addCustomFacility(); } }}
                  placeholder={t("editListing.addCustomFacility", { defaultValue: "Add custom facility..." })} className="flex-1 rounded-xl" />
                <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={addCustomFacility}>
                  <Plus className="w-4 h-4 mr-1" /> {t("editListing.add", { defaultValue: "Add" })}
                </Button>
              </div>
            </div>
          )}

          {/* ─── Photos ─── */}
          <div className={has("photos_required") ? "rounded-xl border border-destructive ring-2 ring-destructive/30 p-2 -m-2" : ""}>
            <Label className="text-sm font-medium mb-1.5 flex items-center gap-1">
              {t("editListing.photosLabel", { defaultValue: "Photos" })} {(isStay || has("photos_required")) && "* "}{isStay && <span className="text-muted-foreground font-normal text-xs">{t("editListing.minimumFive", { defaultValue: "(minimum 5)" })}</span>}
            </Label>
            {has("photos_required") && (
              <p className="text-xs text-destructive mb-2">{t("editListing.addPhotoHint", { defaultValue: "Add at least one photo so guests can see what they're booking." })}</p>
            )}
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-3">
              {photoItems.map((item, idx) => (
                <div key={idx} className="relative aspect-square rounded-xl overflow-hidden border border-border group">
                  <img src={item.preview} alt={t("editListing.photoAlt", { defaultValue: "Photo {{n}}", n: idx + 1 })} className="w-full h-full object-cover" />
                  <button type="button" onClick={() => removePhoto(idx)}
                    className="absolute top-1 right-1 p-1 bg-black/60 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
                    <Trash2 className="w-3 h-3" />
                  </button>
                  <span className="absolute bottom-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">{idx + 1}</span>
                </div>
              ))}
              <button type="button" onClick={() => fileInputRef.current?.click()}
                className="aspect-square rounded-xl border-2 border-dashed border-border hover:border-primary/50 flex flex-col items-center justify-center gap-1 text-muted-foreground hover:text-primary transition-colors cursor-pointer">
                <ImagePlus className="w-5 h-5" />
                <span className="text-[10px]">{t("editListing.add", { defaultValue: "Add" })}</span>
              </button>
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFileSelect} className="hidden" />
            <p className="text-xs text-muted-foreground">{t("editListing.photoFormatHint", { defaultValue: "JPG, PNG, or WebP — max 5MB each" })}</p>
            {formErrors.photos && <p className="text-xs text-red-500 mt-1">{formErrors.photos}</p>}
          </div>

          {/* ─── Availability Schedule ───
              Stays don't have per-day open hours — they have an "open
              calendar window" (year-round / seasonal) and per-day
              check-in / check-out clock times. The per-day grid below
              only makes sense for service + transport providers who
              show up at specific hours each day. */}
          {isStay ? (
            <div className="space-y-3">
              <Label className="text-sm font-medium mb-1 flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                {t("editListing.bookingCalendarCheckin", { defaultValue: "Booking calendar & check-in" })}
              </Label>
              <div className="bg-muted/30 rounded-xl p-3 border border-border/50 space-y-3">
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5">{t("editListing.whenAcceptGuests", { defaultValue: "When you accept guests" })}</Label>
                  <Input
                    value={form.availability || ""}
                    onChange={e => setForm(p => ({ ...p, availability: e.target.value }))}
                    className="rounded-xl"
                    placeholder={t("editListing.acceptGuestsPlaceholder", { defaultValue: "e.g. Year-round, Seasonal Oct–March, Closed in July" })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1.5">{t("editListing.checkInTime", { defaultValue: "Check-in time" })}</Label>
                    <input
                      type="time"
                      value={metadata.checkInTime || ""}
                      onChange={e => updateMeta("checkInTime", e.target.value)}
                      className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1.5">{t("editListing.checkOutTime", { defaultValue: "Check-out time" })}</Label>
                    <input
                      type="time"
                      value={metadata.checkOutTime || ""}
                      onChange={e => updateMeta("checkOutTime", e.target.value)}
                      className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <Label className="text-sm font-medium mb-2 flex items-center gap-1"><Clock className="w-3.5 h-3.5 text-muted-foreground" />{t("editListing.availabilitySchedule", { defaultValue: "Availability Schedule" })}{has("working_hours_required") && " *"}</Label>
              {has("working_hours_required") && (
                <p className="text-xs text-destructive mb-2">{t("editListing.enableOneDayHint", { defaultValue: "Enable at least one day and set its hours so guests can book a time." })}</p>
              )}
              <div className={`space-y-2 bg-muted/30 rounded-xl p-3 border ${has("working_hours_required") ? "border-destructive ring-2 ring-destructive/30" : "border-border/50"}`}>
                {DAY_LABELS.map((day, i) => (
                  <div key={day} className="flex items-center gap-2">
                    <button onClick={() => toggleDay(i)}
                      className={`w-10 text-xs font-semibold py-1.5 rounded-lg transition-all ${availDays[i].enabled ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}>
                      {t(`editListing.day_${day.toLowerCase()}`, { defaultValue: day })}
                    </button>
                    {availDays[i].enabled ? (
                      <div className="flex items-center gap-1.5 text-sm">
                        <input type="time" value={availDays[i].startTime} onChange={e => setDayTime(i, "startTime", e.target.value)} className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs focus:ring-2 focus:ring-primary/20 outline-none" />
                        <span className="text-muted-foreground text-xs">{t("editListing.to", { defaultValue: "to" })}</span>
                        <input type="time" value={availDays[i].endTime} onChange={e => setDayTime(i, "endTime", e.target.value)} className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs focus:ring-2 focus:ring-primary/20 outline-none" />
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground italic">{t("editListing.unavailable", { defaultValue: "Unavailable" })}</span>
                    )}
                  </div>
                ))}
                <button onClick={applyTimeToAll} className="mt-1 rounded px-1.5 py-0.5 text-xs text-primary transition-colors hover:bg-primary/10">{t("editListing.applyTimeToAll", { defaultValue: "Apply first day's time to all enabled days" })}</button>
              </div>

              {/* Service-only: bookable time slot editor. Derives slots from
                  the availability grid + duration, with optional custom
                  overrides. Keeps the customer booking modal and provider
                  edit modal reading from the same canonical source. */}
              {isService && (() => {
                const derived = deriveSlotsFromAvailDays(availDays, metadata.duration, bufferMinutes);
                const slots = serviceSlotsCustom.length > 0 ? serviceSlotsCustom : derived;
                const isCustom = serviceSlotsCustom.length > 0;
                const preview = slots.slice(0, 6);
                const extra = Math.max(0, slots.length - preview.length);
                const addSlot = () => {
                  const v = newSlotInput.trim();
                  if (!v) return;
                  const base = serviceSlotsCustom.length > 0 ? serviceSlotsCustom : derived;
                  if (base.includes(v)) { setNewSlotInput(""); return; }
                  setServiceSlotsCustom([...base, v]);
                  setNewSlotInput("");
                };
                const removeSlot = (s: string) => {
                  const base = serviceSlotsCustom.length > 0 ? serviceSlotsCustom : derived;
                  setServiceSlotsCustom(base.filter((x) => x !== s));
                };
                return (
                  <div className="mt-3 space-y-2 rounded-xl border border-border bg-muted/30 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold text-foreground">{t("editListing.bookableTimeSlots", { defaultValue: "Bookable time slots" })}</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {isCustom
                            ? (slots.length === 1
                                ? t("editListing.customSlotsCount_one", { defaultValue: "{{count}} custom slot.", count: slots.length })
                                : t("editListing.customSlotsCount_other", { defaultValue: "{{count}} custom slots.", count: slots.length }))
                            : slots.length > 0
                              ? t("editListing.slotsAutoGenerated", { defaultValue: "Auto-generated from your hours and {{duration}} duration.", duration: metadata.duration || t("editListing.defaultDuration", { defaultValue: "60 min" }) })
                              : t("editListing.setHoursToGenerate", { defaultValue: "Set hours and a duration to generate slots." })}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowSlotEditor((v) => !v)}
                        className="text-[11px] font-bold text-primary hover:underline shrink-0"
                      >
                        {showSlotEditor ? t("editListing.hide", { defaultValue: "Hide" }) : t("editListing.customize", { defaultValue: "Customize" })}
                      </button>
                    </div>
                    {slots.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {preview.map((s) => (
                          <span key={s} className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] font-medium text-foreground">
                            {s}
                          </span>
                        ))}
                        {extra > 0 && !showSlotEditor && (
                          <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                            {t("editListing.extraMore", { defaultValue: "+{{count}} more", count: extra })}
                          </span>
                        )}
                      </div>
                    )}
                    {showSlotEditor && (
                      <div className="space-y-2 pt-2 border-t border-border">
                        <div className="flex items-center justify-between">
                          <p className="text-[11px] font-semibold text-foreground">{t("editListing.customizeSlots", { defaultValue: "Customize slots" })}</p>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => setServiceSlotsCustom(derived)}
                              className="text-[10px] font-semibold px-2 py-1 rounded-md border border-border bg-background hover:bg-muted"
                            >
                              {t("editListing.regenerateFromHours", { defaultValue: "Regenerate from hours" })}
                            </button>
                            {isCustom && (
                              <button
                                type="button"
                                onClick={() => setServiceSlotsCustom([])}
                                className="text-[10px] font-semibold px-2 py-1 rounded-md border border-border bg-background hover:bg-muted"
                              >
                                {t("editListing.resetToAuto", { defaultValue: "Reset to auto" })}
                              </button>
                            )}
                          </div>
                        </div>
                        {slots.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
                            {slots.map((s, idx) => {
                              const isEditing = editingSlotIndex === idx;
                              if (isEditing) {
                                return (
                                  <span key={`edit-${idx}`} className="inline-flex items-center gap-1 rounded-full border border-primary bg-background px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                                    <input
                                      autoFocus
                                      value={editingSlotDraft}
                                      onChange={(e) => setEditingSlotDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                          e.preventDefault();
                                          const v = editingSlotDraft.trim();
                                          if (!v) { setEditingSlotIndex(null); return; }
                                          const base = serviceSlotsCustom.length > 0 ? serviceSlotsCustom : derived;
                                          setServiceSlotsCustom(base.map((x, i) => i === idx ? v : x));
                                          setEditingSlotIndex(null);
                                        }
                                        if (e.key === "Escape") { e.preventDefault(); setEditingSlotIndex(null); }
                                      }}
                                      className="w-28 px-1.5 py-0.5 text-[11px] rounded border border-border bg-background outline-none focus:ring-2 focus:ring-primary/20"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const v = editingSlotDraft.trim();
                                        if (!v) { setEditingSlotIndex(null); return; }
                                        const base = serviceSlotsCustom.length > 0 ? serviceSlotsCustom : derived;
                                        setServiceSlotsCustom(base.map((x, i) => i === idx ? v : x));
                                        setEditingSlotIndex(null);
                                      }}
                                      className="text-primary font-bold"
                                      aria-label={t("editListing.saveSlot", { defaultValue: "Save slot" })}
                                    >
                                      ✓
                                    </button>
                                    <button type="button" onClick={() => setEditingSlotIndex(null)} className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted/70" aria-label={t("editListing.cancelEdit", { defaultValue: "Cancel edit" })}>×</button>
                                  </span>
                                );
                              }
                              return (
                                <span key={`${s}-${idx}`} className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] font-medium text-foreground">
                                  <button
                                    type="button"
                                    onClick={() => { setEditingSlotIndex(idx); setEditingSlotDraft(s); }}
                                    className="hover:underline"
                                    title={t("editListing.clickToEdit", { defaultValue: "Click to edit" })}
                                  >
                                    {s}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const base = serviceSlotsCustom.length > 0 ? serviceSlotsCustom : derived;
                                      setServiceSlotsCustom(base.filter((_, i) => i !== idx));
                                    }}
                                    className="ml-0.5 text-muted-foreground hover:text-destructive"
                                    aria-label={t("editListing.removeItem", { defaultValue: "Remove {{item}}", item: s })}
                                  >
                                    ×
                                  </button>
                                </span>
                              );
                            })}
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <input
                            value={newSlotInput}
                            onChange={(e) => setNewSlotInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSlot(); } }}
                            placeholder={t("editListing.slotPlaceholder", { defaultValue: "e.g. Sat 11:00 AM" })}
                            className="flex-1 px-3 py-1.5 border border-border rounded-md text-xs bg-background outline-none focus:ring-2 focus:ring-primary/20"
                          />
                          <button
                            type="button"
                            onClick={addSlot}
                            className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90"
                          >
                            {t("editListing.add", { defaultValue: "Add" })}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* ─── Service-specific ─── */}
          {isService && (
            <div className="space-y-4 border-t border-border pt-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t("editListing.serviceDetails", { defaultValue: "Service Details" })}</p>

              {/* Service modes — multi-select. Conditional follow-ups for
                  visit-provider (address) and online (delivery details).
                  Mirrors the onboarding form so a listing edited here is
                  shape-identical to one created via /onboarding. */}
              <div>
                <Label className="text-sm font-medium mb-1.5">{t("editListing.howDeliverService", { defaultValue: "How do you deliver this service?" })}</Label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {SERVICE_MODE_OPTIONS.map((opt) => {
                    const on = serviceModes.includes(opt.value);
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => toggleServiceMode(opt.value)}
                        className={`px-3 py-2.5 rounded-xl border text-xs font-medium transition-all text-left ${
                          on
                            ? "bg-primary text-primary-foreground border-primary shadow-sm"
                            : "bg-background border-border hover:border-primary/40"
                        }`}
                      >
                        <div className="text-base">{opt.emoji}</div>
                        <div className="font-semibold">{t(`editListing.serviceMode_${opt.value}_label`, { defaultValue: opt.label })}</div>
                        <div className="text-[10px] opacity-70">{t(`editListing.serviceMode_${opt.value}_hint`, { defaultValue: opt.hint })}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {serviceModes.includes("visit-provider") && (
                <div className="space-y-2">
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><Store className="w-3 h-3" />{t("editListing.shopAddressLabel", { defaultValue: "Your shop / studio / clinic address" })}</Label>
                    <Input
                      value={visitAddress}
                      onChange={(e) => setVisitAddress(e.target.value)}
                      className="rounded-xl"
                      placeholder={t("editListing.shopAddressPlaceholder", { defaultValue: "e.g. Shop 4, 2nd Cross, Indiranagar" })}
                    />
                  </div>
                  {/* WS6 host consent: OFF (default) = customers get this
                      address only after a confirmed booking; ON = it shows
                      on the public listing (walk-in premises). Same switch
                      card pattern as "Flexible with hours" below. */}
                  <div className="flex items-start gap-3 rounded-xl border border-border/50 bg-muted/30 px-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">{t("editListing.showAddressPubliclyLabel", { defaultValue: "Show this address publicly" })}</p>
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                        {t("editListing.showAddressPubliclyHint", { defaultValue: "For a shop, salon, or clinic customers walk into. When off, the address is shared only after a confirmed booking." })}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowAddressPublicly(v => !v)}
                      role="switch"
                      aria-checked={showAddressPublicly}
                      aria-label={t("editListing.showAddressPubliclyLabel", { defaultValue: "Show this address publicly" })}
                      className={`relative mt-0.5 inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                        showAddressPublicly ? "bg-success" : "bg-muted"
                      }`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${showAddressPublicly ? "translate-x-4" : "translate-x-0.5"}`} />
                    </button>
                  </div>
                </div>
              )}

              {serviceModes.includes("online") && (
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><Globe className="w-3 h-3" />{t("editListing.onlineDeliveryDetailsLabel", { defaultValue: "Online delivery details" })}</Label>
                  <Textarea
                    value={meetingDetails}
                    onChange={(e) => setMeetingDetails(e.target.value)}
                    className="rounded-xl"
                    rows={2}
                    placeholder={t("editListing.onlineDeliveryPlaceholder", { defaultValue: "e.g. I'll WhatsApp the Zoom link 30 min before your slot." })}
                  />
                </div>
              )}

              <div className={`grid gap-3 ${serviceOnlineOnly ? "grid-cols-1" : "grid-cols-2"}`}>
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><Briefcase className="w-3 h-3" />{t("editListing.experienceLabel", { defaultValue: "Experience" })}</Label>
                  <Input value={metadata.experience || ""} onChange={e => updateMeta("experience", e.target.value)} className={`rounded-xl ${errCls("experience_required")}`} placeholder={t("editListing.experiencePlaceholder", { defaultValue: "e.g. 5 years" })} />
                </div>
                {/* Service radius is meaningless for online-only providers —
                    they don't travel. Hide the field for them (parity with
                    onboarding and the listing detail page). */}
                {!serviceOnlineOnly && (
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><Ruler className="w-3 h-3" />{t("editListing.serviceRadiusKm", { defaultValue: "Service Radius (km)" })}</Label>
                    <Input type="number" value={metadata.serviceRadius || ""} onChange={e => updateMeta("serviceRadius", Number(e.target.value))} className="rounded-xl" placeholder="15" />
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5">{t("editListing.subcategories", { defaultValue: "Subcategories" })}</Label>
                  {/* Read both shapes so legacy listings (single string) keep
                      working alongside new array writes. Writes BOTH so old
                      readers (marketplace adapter fallback, search providers)
                      still see a primary value while the array drives the
                      filter chips + AI rerank. */}
                  <ChipListInput
                    value={
                      Array.isArray(metadata.subcategories) && metadata.subcategories.length > 0
                        ? (metadata.subcategories as string[])
                        : (typeof metadata.subcategory === "string" && metadata.subcategory
                            ? [metadata.subcategory]
                            : [])
                    }
                    onChange={(next) => {
                      updateMeta("subcategories", next);
                      updateMeta("subcategory", next[0] ?? "");
                    }}
                    placeholder={t("editListing.serviceSubcatPlaceholder", { defaultValue: "e.g. Beard trim, Deep cleaning, Math tutoring" })}
                    emptyHint={t("editListing.serviceSubcatHint", { defaultValue: "Add each sub-skill you offer — customers can search and filter by these." })}
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5">{t("editListing.pricingUnit", { defaultValue: "Pricing unit" })}</Label>
                  <select
                    value={pricingUnit}
                    onChange={(e) => setPricingUnit(e.target.value)}
                    className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20 outline-none"
                  >
                    {PRICING_UNIT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{t(`editListing.pricingUnit_${opt.value || "auto"}`, { defaultValue: opt.label })}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5">{t("editListing.highlightsFeatures", { defaultValue: "Highlights / Features" })}</Label>
                <Textarea value={featuresText} onChange={e => setFeaturesText(e.target.value)} className="rounded-xl" rows={2} placeholder={t("editListing.highlightsPlaceholder", { defaultValue: "Eco-friendly products, Pet-safe, Deep stain removal" })} />
                <p className="text-[11px] text-muted-foreground mt-1">{t("editListing.commaSeparatedList", { defaultValue: "Comma-separated list" })}</p>
              </div>
              <ServicesCatalogEditor
                value={servicesCatalog}
                onChange={(next) => {
                  setServicesCatalog(next);
                  setFormErrors((prev) => {
                    const n = { ...prev };
                    delete n.servicesCatalog;
                    return n;
                  });
                }}
              />
              {formErrors.servicesCatalog && (
                <p className="text-xs text-destructive mt-1">{formErrors.servicesCatalog}</p>
              )}
            </div>
          )}

          {/* ─── Transport-specific ─── */}
          {isTransport && (
            <div className="space-y-4 border-t border-border pt-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t("editListing.vehicleDetails", { defaultValue: "Vehicle Details" })}</p>
              {(has("transportation_types_required") || has("transportation_type_base_price_required")) && (
                <div className="rounded-lg border border-destructive bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {has("transportation_types_required")
                    ? t("editListing.transportTypesRequiredHint", { defaultValue: "Add a vehicle type, model and seating capacity so guests know what they're booking." })
                    : t("editListing.transportBasePriceHint", { defaultValue: "Every transportation type needs a base price — fill in at least one of Hourly rate / Day rate, or add a tour package." })}
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5">{t("editListing.vehicleType", { defaultValue: "Vehicle type" })}{(has("transportation_types_required") || formErrors.vehicleType) && " *"}</Label>
                  <Input value={vehicleType} onChange={e => { setVehicleType(e.target.value); clearFormErr("vehicleType"); }} className={`rounded-xl ${((has("transportation_types_required") && !vehicleType.trim()) || formErrors.vehicleType) ? RED_FIELD : ""}`} placeholder={t("editListing.vehicleTypePlaceholder", { defaultValue: "e.g. Sedan, SUV, Tempo" })} />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5">{t("editListing.model", { defaultValue: "Model" })}{(has("transportation_types_required") || formErrors.vehicleName) && " *"}</Label>
                  <Input value={form.vehicleName || ""} onChange={e => { setForm(p => ({ ...p, vehicleName: e.target.value })); clearFormErr("vehicleName"); }} className={`rounded-xl ${((has("transportation_types_required") && !(form.vehicleName || "").trim()) || formErrors.vehicleName) ? RED_FIELD : ""}`} placeholder={t("editListing.modelPlaceholder", { defaultValue: "e.g. Maruti Swift Dzire" })} />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5">{t("editListing.seatingCapacity", { defaultValue: "Seating capacity" })}{(has("transportation_types_required") || formErrors.seatingCapacity) && " *"}</Label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={seatingCapacity}
                    onChange={(e) => { setSeatingCapacity(e.target.value.replace(/[^0-9]/g, "")); clearFormErr("seatingCapacity"); }}
                    className={`rounded-xl ${((has("transportation_types_required") && !(Number(seatingCapacity) > 0)) || formErrors.seatingCapacity) ? RED_FIELD : ""}`}
                    placeholder="4"
                  />
                </div>
              </div>

              {/* Vehicle colour + number plate — riders see these in the
                  booking summary to identify the car, so both are required. */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5">{t("editListing.vehicleColor", { defaultValue: "Vehicle colour" })}{(has("vehicle_color_required") || formErrors.vehicleColor) && " *"}</Label>
                  <Input value={vehicleColor} onChange={e => { setVehicleColor(e.target.value); clearFormErr("vehicleColor"); }} className={`rounded-xl ${((has("vehicle_color_required") && !vehicleColor.trim()) || formErrors.vehicleColor) ? RED_FIELD : ""}`} placeholder={t("editListing.vehicleColorPlaceholder", { defaultValue: "e.g. White" })} />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5">{t("editListing.licensePlate", { defaultValue: "Number plate" })}{(has("license_plate_required") || formErrors.licensePlate) && " *"}</Label>
                  <Input value={licensePlate} onChange={e => { setLicensePlate(e.target.value); clearFormErr("licensePlate"); }} className={`rounded-xl ${((has("license_plate_required") && !licensePlate.trim()) || formErrors.licensePlate) ? RED_FIELD : ""}`} placeholder={t("editListing.licensePlatePlaceholder", { defaultValue: "e.g. KA 01 AB 1234" })} />
                </div>
              </div>

              {/* Driver context fields — mirror the manual onboarding form so
                  AI-onboarded transport listings can be edited end-to-end
                  from this modal. */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><Briefcase className="w-3 h-3" />{t("editListing.yearsDriving", { defaultValue: "Years driving" })}{(has("experience_required") || formErrors.experience) && " *"}</Label>
                  <Input value={metadata.experience || ""} onChange={e => { updateMeta("experience", e.target.value); clearFormErr("experience"); }} className={`rounded-xl ${errClsLocal("experience", "experience_required")}`} placeholder={t("editListing.yearsDrivingPlaceholder", { defaultValue: "e.g. 8 years" })} />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                    <Ruler className="w-3 h-3" />{t("editListing.serviceRadiusKmLower", { defaultValue: "Service radius (km)" })}{(has("service_radius_required") || formErrors.serviceRadius) && " *"}
                  </Label>
                  <Input
                    type="number"
                    value={metadata.serviceRadius || ""}
                    onChange={e => { updateMeta("serviceRadius", Number(e.target.value)); clearFormErr("serviceRadius"); }}
                    className={`rounded-xl ${errClsLocal("serviceRadius", "service_radius_required")}`}
                    placeholder="25"
                  />
                  {(has("service_radius_required") || formErrors.serviceRadius) && (
                    <p className="text-xs text-destructive mt-1">{t("editListing.setServiceRadiusHint", { defaultValue: "Set the area / radius you cover (km)." })}</p>
                  )}
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5">{t("editListing.subcategoriesOptional", { defaultValue: "Subcategories (optional)" })}</Label>
                {/* Same dual-write pattern as the service block above so
                    legacy single-string readers keep working. Drivers can
                    list every route type they cover (airport, intercity,
                    pilgrimage) so passengers see and filter by each. */}
                <ChipListInput
                  value={
                    Array.isArray(metadata.subcategories) && metadata.subcategories.length > 0
                      ? (metadata.subcategories as string[])
                      : (typeof metadata.subcategory === "string" && metadata.subcategory
                          ? [metadata.subcategory]
                          : [])
                  }
                  onChange={(next) => {
                    updateMeta("subcategories", next);
                    updateMeta("subcategory", next[0] ?? "");
                  }}
                  placeholder={t("editListing.transportSubcatPlaceholder", { defaultValue: "e.g. Airport runs, Pilgrimage routes, Intercity" })}
                  emptyHint={t("editListing.transportSubcatHint", { defaultValue: "Each route type passengers can search for." })}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><Clock className="w-3 h-3" />{t("editListing.bufferTripsLabel", { defaultValue: "Buffer between trips (min)" })}</Label>
                <Input
                  type="number"
                  min={0}
                  max={240}
                  value={String(bufferMinutes)}
                  onChange={e => {
                    const v = Number(e.target.value);
                    setBufferMinutes(Number.isFinite(v) ? Math.max(0, Math.min(240, Math.round(v))) : 15);
                  }}
                  className="rounded-xl"
                  placeholder="15"
                />
                <p className="text-[11px] text-muted-foreground mt-1">{t("editListing.bufferTripsHint", { defaultValue: "Extra minutes between back-to-back trips (travel, rest). Default 15." })}</p>
              </div>

              {/* Flexible-hours flag — informational only. Does NOT change the
                  Availability Schedule above; adds a "Flexible hours" tag to
                  the listing so riders know they can message to arrange times
                  outside the listed hours. */}
              <div className="flex items-start gap-3 rounded-xl border border-border/50 bg-muted/30 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{t("editListing.flexibleWithHours", { defaultValue: "Flexible with hours" })}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                    {t("editListing.flexibleHoursHint", { defaultValue: "Shows a “Flexible hours” tag on your listing. Your schedule above stays the same — this just lets riders know they can message you to work out timing outside it after booking." })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setFlexibleHours(v => !v)}
                  role="switch"
                  aria-checked={flexibleHours}
                  aria-label={t("editListing.flexibleWithHours", { defaultValue: "Flexible with hours" })}
                  className={`relative mt-0.5 inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                    flexibleHours ? "bg-success" : "bg-muted"
                  }`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${flexibleHours ? "translate-x-4" : "translate-x-0.5"}`} />
                </button>
              </div>

              {/* Transport modes — multi-select. Click again to deselect a
                  mode; deselecting also zeroes that mode's price on save
                  so the booking modal stops offering it. Point ride is
                  disabled (beta) — the badge keeps the staged rollout
                  visible to operators. */}
              <div>
                <Label className="text-sm font-medium mb-1.5">{t("editListing.bookingModesAccepted", { defaultValue: "Booking modes accepted" })}</Label>
                <p className="text-[11px] text-muted-foreground mb-2">{t("editListing.bookingModesHint", { defaultValue: "Tap each mode you offer. Tap again to deselect — that mode's price will be cleared on save." })}</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {TRANSPORT_MODE_OPTIONS.map((opt) => {
                    const on = hasTransportMode(opt.value);
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => toggleTransportMode(opt.value)}
                        disabled={opt.disabled}
                        aria-pressed={on}
                        className={`px-3 py-2.5 rounded-xl border text-xs font-medium transition-all text-left ${
                          opt.disabled
                            ? "bg-muted text-muted-foreground border-border opacity-60 cursor-not-allowed"
                            : on
                              ? "bg-primary text-primary-foreground border-primary shadow-sm"
                              : "bg-background border-border hover:border-primary/40"
                        }`}
                      >
                        <div className="text-base">{opt.emoji}</div>
                        <div className="font-semibold">{t(`editListing.transportMode_${opt.value}_label`, { defaultValue: opt.label })}</div>
                        <div className="text-[10px] opacity-70">{t(`editListing.transportMode_${opt.value}_hint`, { defaultValue: opt.hint })}</div>
                        {opt.badge && (
                          <div className="mt-1 inline-block px-1.5 py-0.5 rounded text-[9px] bg-yellow-50 text-yellow-700 border border-yellow-200">
                            {t(`editListing.transportMode_${opt.value}_badge`, { defaultValue: opt.badge })}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Per-mode pricing keyed off the multi-select array, not the
                  single legacy field. Each mode shows ONLY when selected. */}
              {hasTransportMode("hourly") && (
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5">{t("editListing.hourlyRate", { defaultValue: "Hourly rate (₹)" })}{has("price_per_hour_required") && " *"}</Label>
                  <Input type="number" value={pricePerHour} onChange={(e) => setPricePerHour(e.target.value)} className={`rounded-xl ${errCls("price_per_hour_required")}`} placeholder={t("editListing.hourlyRatePlaceholder", { defaultValue: "e.g. 350" })} />
                  {has("price_per_hour_required") && <p className="text-xs text-destructive mt-1">{t("editListing.setHourlyPrice", { defaultValue: "Set the hourly price." })}</p>}
                </div>
              )}

              {hasTransportMode("day") && (
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5">{t("editListing.dayRate", { defaultValue: "Day rate (₹)" })}{has("price_per_day_required") && " *"}</Label>
                  <Input type="number" value={pricePerDay} onChange={(e) => setPricePerDay(e.target.value)} className={`rounded-xl ${errCls("price_per_day_required")}`} placeholder={t("editListing.dayRatePlaceholder", { defaultValue: "e.g. 4500" })} />
                  {has("price_per_day_required") && <p className="text-xs text-destructive mt-1">{t("editListing.setDayPrice", { defaultValue: "Set the per-day price." })}</p>}
                </div>
              )}

              {hasTransportMode("package") && (() => {
                // Validate package duration against the host's open-day
                // working hours so they catch "10 hr tour but only 6 hr open"
                // before publish.
                const widestMin = widestWorkingWindowMinutes(availDaysToWorkingHours(availDays));
                const widestHours = widestMin / 60;
                return (
                <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-3">
                  <Label className="text-sm font-medium mb-0 flex items-center gap-1">
                    <Landmark className="w-3.5 h-3.5 text-muted-foreground" />
                    {t("editListing.tourPackages", { defaultValue: "Tour packages" })}
                  </Label>
                  {packageOptions.length === 0 && (
                    <div className="text-center py-3 border-2 border-dashed border-border rounded-lg text-xs text-muted-foreground">
                      {t("editListing.noPackagesYet", { defaultValue: "No packages yet — add one so customers can pick." })}
                    </div>
                  )}
                  {packageOptions.map((row, idx) => {
                    const hoursNum = Number(row.hours);
                    const overflowsWindow = widestMin > 0
                      && Number.isFinite(hoursNum) && hoursNum > 0
                      && hoursNum * 60 > widestMin;
                    const minKm = Number(row.distanceKmMin);
                    const maxKm = Number(row.distanceKmMax);
                    const kmRangeBackwards = Number.isFinite(minKm) && Number.isFinite(maxKm)
                      && minKm > 0 && maxKm > 0 && maxKm < minKm;
                    const dwellSumMin = totalDwellMinutes(row.stops);
                    const dwellOverflowsHours = hoursNum > 0
                      && dwellSumMin > 0
                      && dwellSumMin > hoursNum * 60;
                    return (
                    <div key={row.id} className="bg-background rounded-xl border border-border p-3 space-y-3">
                      {/* Title row */}
                      <div className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-[11px] font-bold flex items-center justify-center shrink-0">
                          {idx + 1}
                        </span>
                        <Input
                          value={row.label}
                          onChange={(e) => patchPackage(row.id, { label: e.target.value })}
                          placeholder={t("editListing.packageNamePlaceholder", { defaultValue: "Package name (e.g. North Goa Day Tour)" })}
                          className="flex-1 rounded-lg"
                        />
                        <Button type="button" size="icon" variant="ghost"
                          className="rounded-full h-8 w-8 text-destructive hover:text-destructive shrink-0"
                          onClick={() => removePackage(row.id)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>

                      {/* Price / Hours */}
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground mb-1">{t("editListing.packagePrice", { defaultValue: "Price (₹)" })}</Label>
                          <Input type="number" value={row.price} onChange={(e) => patchPackage(row.id, { price: e.target.value })} className="rounded-lg" placeholder="3500" />
                        </div>
                        <div>
                          <Label className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground mb-1">{t("editListing.packageHours", { defaultValue: "Hours" })}</Label>
                          <Input
                            type="number"
                            value={row.hours}
                            onChange={(e) => patchPackage(row.id, { hours: e.target.value })}
                            className={`rounded-lg ${overflowsWindow ? "border-destructive/60 focus-visible:ring-destructive/20" : ""}`}
                            placeholder="8"
                          />
                          {overflowsWindow && widestHours > 0 && (
                            <p className="mt-1 text-[11px] font-semibold text-destructive">
                              {t("editListing.tourLongerThanOpenDay", { defaultValue: "This tour ({{hours}}h) is longer than your widest open day ({{widest}}h).", hours: hoursNum, widest: widestHours.toFixed(widestHours % 1 === 0 ? 0 : 1) })}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Distance range */}
                      <div>
                        <Label className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground mb-1">{t("editListing.distanceCovered", { defaultValue: "Distance covered (km)" })}</Label>
                        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                          <Input
                            type="number"
                            value={row.distanceKmMin}
                            onChange={(e) => patchPackage(row.id, { distanceKmMin: e.target.value })}
                            placeholder={t("editListing.minPlaceholder", { defaultValue: "Min · 70" })}
                            className={`rounded-lg ${kmRangeBackwards ? "border-destructive/60 focus-visible:ring-destructive/20" : ""}`}
                          />
                          <span className="text-xs font-bold text-muted-foreground">{t("editListing.to", { defaultValue: "to" })}</span>
                          <Input
                            type="number"
                            value={row.distanceKmMax}
                            onChange={(e) => patchPackage(row.id, { distanceKmMax: e.target.value })}
                            placeholder={t("editListing.maxPlaceholder", { defaultValue: "Max · 90" })}
                            className={`rounded-lg ${kmRangeBackwards ? "border-destructive/60 focus-visible:ring-destructive/20" : ""}`}
                          />
                        </div>
                        {kmRangeBackwards && (
                          <p className="mt-1 text-[11px] font-semibold text-destructive">{t("editListing.maxKmAtLeastMin", { defaultValue: "Max km should be at least the min." })}</p>
                        )}
                      </div>

                      {/* Itinerary stops */}
                      <div>
                        <Label className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground mb-1">
                          {t("editListing.placesVisited", { defaultValue: "Places visited" })} <span className="text-destructive">*</span>
                          <span className="block text-[10px] font-normal text-muted-foreground/80 normal-case tracking-normal">{t("editListing.placesVisitedHint", { defaultValue: "Add each stop in order. Minutes column is optional." })}</span>
                        </Label>
                        <div className="grid gap-1.5">
                          {row.stops.map((stop, sIdx) => (
                            <div key={sIdx} className="grid grid-cols-[20px_1fr_92px_28px] items-center gap-1.5">
                              <span className="text-[11px] font-bold text-muted-foreground text-center">{sIdx + 1}.</span>
                              <Input
                                value={stop.place}
                                onChange={(e) => patchStop(row.id, sIdx, { place: e.target.value })}
                                placeholder={t("editListing.stopPlaceholder", { defaultValue: "e.g. Golconda Fort" })}
                                className="rounded-lg"
                              />
                              <Input
                                type="number"
                                value={stop.dwellMinutes}
                                onChange={(e) => patchStop(row.id, sIdx, { dwellMinutes: e.target.value })}
                                placeholder={t("editListing.minLabel", { defaultValue: "min" })}
                                className="rounded-lg"
                                aria-label={t("editListing.stopMinutesAria", { defaultValue: "Approx minutes at this stop (optional)" })}
                              />
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 rounded-full text-muted-foreground hover:text-destructive disabled:opacity-30"
                                onClick={() => removeStop(row.id, sIdx)}
                                disabled={row.stops.length <= 1}
                                aria-label={t("editListing.removeStop", { defaultValue: "Remove stop" })}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          ))}
                        </div>
                        <Button type="button" variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs"
                          onClick={() => addStop(row.id)}
                        >
                          <Plus className="w-3.5 h-3.5 mr-1" /> {t("editListing.addStop", { defaultValue: "Add stop" })}
                        </Button>
                        {dwellOverflowsHours && (
                          <p className="mt-1 text-[11px] font-semibold text-destructive">
                            {t("editListing.dwellOverflowsHours", { defaultValue: "Per-stop minutes total {{total}} min — longer than the {{hours}}h tour ({{tourMin}} min).", total: dwellSumMin, hours: hoursNum, tourMin: hoursNum * 60 })}
                          </p>
                        )}
                      </div>

                      {/* Per-package languages — optional */}
                      <div>
                        <Label className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground mb-1">
                          {t("editListing.languagesOnTour", { defaultValue: "Languages on this tour" })} <span className="font-normal normal-case tracking-normal text-muted-foreground/70">{t("editListing.languagesOnTourHint", { defaultValue: "(optional — defaults to listing)" })}</span>
                        </Label>
                        <ChipListInput
                          value={row.languages}
                          onChange={(next) => patchPackage(row.id, { languages: next })}
                          placeholder={t("editListing.tourLanguagesPlaceholder", { defaultValue: "e.g. English, Hindi, Telugu" })}
                        />
                      </div>

                      <Textarea
                        value={row.description}
                        onChange={(e) => patchPackage(row.id, { description: e.target.value })}
                        placeholder={t("editListing.packageDescriptionPlaceholder", { defaultValue: "Anything else? Meals, entry fees, what makes this tour special." })}
                        rows={2}
                        className="rounded-lg"
                      />
                    </div>
                  );
                  })}
                  <Button type="button" variant="outline" className="w-full rounded-lg" onClick={addPackage}>
                    <Plus className="w-4 h-4 mr-1" /> {t("editListing.addPackage", { defaultValue: "Add package" })}
                  </Button>
                </div>
                );
              })()}
            </div>
          )}

          {/* ─── Languages (all types) ─── */}
          <div className={has("languages_required") ? "rounded-xl border border-destructive ring-2 ring-destructive/30 p-2 -m-2" : ""}>
            <Label className="text-sm font-medium mb-1.5 flex items-center gap-1"><Globe className="w-3.5 h-3.5 text-muted-foreground" />{t("editListing.languagesSpoken", { defaultValue: "Languages Spoken" })}{has("languages_required") && " *"}</Label>
            {has("languages_required") && (
              <p className="text-xs text-destructive mb-2">{t("editListing.pickOneLanguage", { defaultValue: "Pick at least one language you speak." })}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {LANGUAGE_OPTIONS.map(lang => (
                <button key={lang} onClick={() => toggleLanguage(lang)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-all ${
                    (metadata.languages || []).includes(lang)
                      ? "bg-primary text-primary-foreground border-primary shadow-sm"
                      : "bg-background border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  }`}>
                  {lang}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ─── Actions ─── */}
        <div className="flex gap-3 pt-3 border-t border-border">
          <Button variant="outline" className="flex-1 rounded-xl" onClick={onClose} disabled={isSaving}>{t("editListing.cancel", { defaultValue: "Cancel" })}</Button>
          <Button className="flex-1 rounded-xl font-semibold shadow-md shadow-primary/20" onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {isUploading ? t("editListing.uploadingPhotos", { defaultValue: "Uploading photos..." }) : t("editListing.saving", { defaultValue: "Saving..." })}
              </span>
            ) : t("editListing.saveChanges", { defaultValue: "Save Changes" })}
          </Button>
        </div>
      </div>
      <ListingNotReadyDialog
        missing={notReadyMissing}
        onClose={() => setNotReadyMissing(null)}
      />
    </div>
  );
};

// Repeater for the service catalog. Edit-modal mirror of the
// ServicesCatalogRepeater in OnboardingForm.tsx — same UX (ghost first row,
// collapse/expand, first row auto-open, can't remove the last group) adapted
// to the edit modal's Input/Label primitives. Writes through to the parent's
// React state; the save handler is where the canonical metadata.servicesCatalog
// + back-compat shim get persisted.
function ServicesCatalogEditor({
  value,
  onChange,
}: {
  value: ServicesCatalogGroup[];
  onChange: (next: ServicesCatalogGroup[]) => void;
}) {
  const { t } = useLanguage();
  // When value is empty we render a ghost row that doesn't materialize until
  // the host actually edits one of its fields. Same approach as onboarding —
  // keeps the form from claiming a service the host never authored.
  const isGhost = !value || value.length === 0;
  const GHOST_ID = "svc-ghost";
  const rows: ServicesCatalogGroup[] = isGhost
    ? [{ id: GHOST_ID, name: "", basePrice: 0, addOns: [] }]
    : value;
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    rows.forEach((g, i) => { out[g.id] = i === 0; });
    return out;
  });

  const materializeGhost = (patch: Partial<ServicesCatalogGroup>) => {
    const realized: ServicesCatalogGroup = {
      id: `svc-${Date.now().toString(36)}-0`,
      name: "",
      basePrice: 0,
      addOns: [],
      ...patch,
    };
    onChange([realized]);
  };

  const updateGroup = (i: number, patch: Partial<ServicesCatalogGroup>) => {
    if (isGhost) {
      materializeGhost(patch);
      return;
    }
    const next = rows.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const removeGroup = (i: number) => {
    if (isGhost || rows.length <= 1) return;
    onChange(rows.filter((_, idx) => idx !== i));
  };
  const addGroup = () => {
    const base = isGhost
      ? [{ id: `svc-${Date.now().toString(36)}-0`, name: "", basePrice: 0, addOns: [] } as ServicesCatalogGroup]
      : rows;
    const id = `svc-${Date.now().toString(36)}-${base.length}`;
    onChange([...base, { id, name: "", basePrice: 0, addOns: [] }]);
    setExpanded((prev) => ({ ...prev, [id]: true }));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <Label className="text-xs text-muted-foreground">{t("editListing.servicesCatalogLabel", { defaultValue: "Services catalog" })} *</Label>
      </div>
      <p className="text-[11px] text-muted-foreground mb-2">
        {t("editListing.servicesCatalogHint", { defaultValue: "Each service has its own base price. Add optional add-ons (extras priced on top) under each service." })}
      </p>
      <div className="space-y-2.5">
        {rows.map((group, i) => {
          const isOpen = expanded[group.id] ?? (i === 0);
          return (
            <div key={group.id} className="rounded-xl border border-border bg-background/40 p-3 space-y-2.5">
              {!isOpen ? (
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => ({ ...prev, [group.id]: true }))}
                  className="w-full flex items-center justify-between text-left"
                >
                  <span className="text-sm font-semibold text-foreground truncate">
                    {group.name || t("editListing.untitledService", { defaultValue: "Untitled service" })}
                    <span className="text-muted-foreground font-normal"> · ₹{group.basePrice || 0} · {group.addOns.length === 1 ? t("editListing.addOnCount_one", { defaultValue: "{{count}} add-on", count: group.addOns.length }) : t("editListing.addOnCount_other", { defaultValue: "{{count}} add-ons", count: group.addOns.length })}</span>
                  </span>
                  <span className="text-xs font-semibold text-primary shrink-0 ml-2">{t("editListing.edit", { defaultValue: "Edit" })}</span>
                </button>
              ) : (
                <>
                  <div className="grid grid-cols-[1fr_140px_36px] items-center gap-2">
                    <Input
                      value={group.name}
                      onChange={(e) => updateGroup(i, { name: e.target.value })}
                      placeholder={t("editListing.serviceNamePlaceholder", { defaultValue: "Service name (e.g. Men's haircut)" })}
                      className="rounded-xl"
                    />
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">₹</span>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        value={Number.isFinite(group.basePrice) && group.basePrice > 0 ? String(group.basePrice) : ""}
                        onChange={(e) => updateGroup(i, { basePrice: Math.max(0, Number(e.target.value) || 0) })}
                        placeholder={t("editListing.basePrice", { defaultValue: "Base price" })}
                        className="rounded-xl pl-7 tabular-nums"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeGroup(i)}
                      disabled={rows.length <= 1}
                      aria-label={t("editListing.removeService", { defaultValue: "Remove service" })}
                      className="grid h-9 w-9 place-items-center rounded-xl border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/5 transition-colors disabled:opacity-40 disabled:hover:text-muted-foreground disabled:hover:border-border disabled:hover:bg-transparent disabled:cursor-not-allowed"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <CatalogAddOnsEditor
                    value={group.addOns}
                    onChange={(next) => updateGroup(i, { addOns: next })}
                  />
                </>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={addGroup}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
        >
          <Plus className="w-3.5 h-3.5" /> {t("editListing.addAnotherService", { defaultValue: "Add another service" })}
        </button>
      </div>
    </div>
  );
}

// Nested add-on editor used by each services-catalog group. Mirrors the
// onboarding CatalogAddOnsRepeater so the visual + data shape stay identical
// — only the styling primitives differ (Input vs raw input).
function CatalogAddOnsEditor({
  value,
  onChange,
}: {
  value: ServicesCatalogAddOn[];
  onChange: (next: ServicesCatalogAddOn[]) => void;
}) {
  const { t } = useLanguage();
  const rows = value ?? [];
  const updateRow = (i: number, patch: Partial<ServicesCatalogAddOn>) => {
    const next = rows.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const addRow = () => onChange([
    ...rows,
    { id: `addon-${Date.now().toString(36)}-${rows.length}`, label: "", price: 0 },
  ]);

  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-background/30 p-2.5 space-y-2">
      {rows.length === 0 ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground px-1 py-1">
          <Sparkles className="w-3 h-3 text-primary/60 shrink-0" />
          <span>{t("editListing.noAddOns", { defaultValue: "No add-ons for this service. Use \"Add an add-on\" for extras priced on top." })}</span>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={row.id || `addon-${i}`} className="grid grid-cols-[1fr_120px_32px] items-center gap-2">
              <Input
                value={row.label}
                onChange={(e) => updateRow(i, { label: e.target.value })}
                placeholder={t("editListing.addOnNamePlaceholder", { defaultValue: "Add-on name (e.g. Beard trim)" })}
                className="rounded-lg"
              />
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">₹</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={Number.isFinite(row.price) && row.price > 0 ? String(row.price) : ""}
                  onChange={(e) => updateRow(i, { price: Math.max(0, Number(e.target.value) || 0) })}
                  placeholder="0"
                  className="rounded-lg pl-6 tabular-nums"
                />
              </div>
              <button
                type="button"
                onClick={() => removeRow(i)}
                aria-label={t("editListing.removeAddOn", { defaultValue: "Remove add-on" })}
                className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/5 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={addRow}
        className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary hover:underline"
      >
        <Plus className="w-3 h-3" /> {t("editListing.addAnAddOn", { defaultValue: "Add an add-on" })}
      </button>
    </div>
  );
}

export default EditListingModal;
