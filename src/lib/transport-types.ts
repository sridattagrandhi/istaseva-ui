// India-relevant transportation catalog.
//
// Single source of truth for every place transportation types are listed:
// onboarding (multi-select + per-type detail forms), filters (vehicle-type
// chip row), booking modal (sub-type picker when a listing offers more than
// one), and the legacy single-string `metadata.transportType` field used by
// the old adapter path.
//
// Each entry carries a stable internal `id` (snake_case) plus a friendly
// `label` for display. Never store the label in metadata — the id is the
// stable contract; labels can be renamed without a migration.

export type TransportTypeKind =
  | "vehicle"        // Has seats, AC, plate, etc. (cab/auto/tempo/etc.)
  | "goods"          // Cargo/luggage carrier — weight + capacity
  | "package_driver" // Tour-package driver — packages + route
  | "service"        // Driver-only, hourly rental, route service (no per-vehicle fields)
  | "route";         // Airport pickup/drop, outstation, etc. (route + per-km + per-trip)

export type PricingUnit =
  | "per_km"
  | "per_hour"
  | "per_day"
  | "per_trip"
  | "per_package"
  | "fixed";

/** Field ids the per-type detail form knows how to render. Kept narrow so
 *  the UI is predictable; "other" can carry free-text in the notes field. */
export type DetailFieldId =
  | "vehicleName"
  | "seatingCapacity"
  | "acAvailable"
  | "luggageCapacity"
  | "goodsCapacityKg"
  | "pricingUnit"
  | "basePrice"
  | "perKmPrice"
  | "perHourPrice"
  | "perDayPrice"
  | "operatingAreas"
  | "routesOrAirports"
  | "minHours"
  | "maxHours"
  | "packageNotes"
  | "notes";

export interface TransportTypeDef {
  id: string;
  label: string;
  kind: TransportTypeKind;
  /** Default pricing unit pre-filled in the per-type details form. */
  defaultPricingUnit: PricingUnit;
  /** Which detail fields appear for this type. Order matters — UI renders
   *  in this order. */
  fields: DetailFieldId[];
  /** Required field ids for this type. The per-type validator highlights
   *  missing values. */
  requiredFields: DetailFieldId[];
  /** Legacy single-string slugs that should fold into this id when
   *  migrating old `metadata.transportType` values. */
  legacyAliases?: string[];
}

const baseVehicleFields: DetailFieldId[] = [
  "vehicleName", "seatingCapacity", "acAvailable", "luggageCapacity",
  "pricingUnit", "basePrice", "perKmPrice", "operatingAreas", "notes",
];

export const TRANSPORT_TYPES: TransportTypeDef[] = [
  {
    id: "auto_rickshaw",
    label: "Auto rickshaw",
    kind: "vehicle",
    defaultPricingUnit: "per_km",
    fields: ["vehicleName", "seatingCapacity", "pricingUnit", "basePrice", "perKmPrice", "operatingAreas", "notes"],
    requiredFields: ["seatingCapacity", "basePrice"],
    legacyAliases: ["auto", "driver-auto"],
  },
  {
    id: "e_rickshaw",
    label: "E-rickshaw",
    kind: "vehicle",
    defaultPricingUnit: "per_km",
    fields: ["vehicleName", "seatingCapacity", "pricingUnit", "basePrice", "perKmPrice", "operatingAreas", "notes"],
    requiredFields: ["seatingCapacity", "basePrice"],
    legacyAliases: ["e-auto", "e-rickshaw", "electric-auto"],
  },
  {
    id: "bike_taxi",
    label: "Bike taxi",
    kind: "vehicle",
    defaultPricingUnit: "per_km",
    fields: ["vehicleName", "pricingUnit", "basePrice", "perKmPrice", "operatingAreas", "notes"],
    requiredFields: ["basePrice"],
    legacyAliases: ["bike", "motorbike-taxi"],
  },
  {
    id: "scooter_taxi",
    label: "Scooter taxi",
    kind: "vehicle",
    defaultPricingUnit: "per_km",
    fields: ["vehicleName", "pricingUnit", "basePrice", "perKmPrice", "operatingAreas", "notes"],
    requiredFields: ["basePrice"],
    legacyAliases: ["scooter"],
  },
  {
    id: "hatchback_cab",
    label: "Hatchback cab",
    kind: "vehicle",
    defaultPricingUnit: "per_km",
    fields: [...baseVehicleFields],
    requiredFields: ["seatingCapacity", "basePrice"],
    legacyAliases: ["hatchback"],
  },
  {
    id: "sedan_cab",
    label: "Sedan cab",
    kind: "vehicle",
    defaultPricingUnit: "per_km",
    fields: [...baseVehicleFields],
    requiredFields: ["seatingCapacity", "basePrice"],
    legacyAliases: ["sedan", "cab", "driver-cab"],
  },
  {
    id: "suv_cab",
    label: "SUV cab",
    kind: "vehicle",
    defaultPricingUnit: "per_km",
    fields: [...baseVehicleFields],
    requiredFields: ["seatingCapacity", "basePrice"],
    legacyAliases: ["suv"],
  },
  {
    id: "luxury_cab",
    label: "Luxury cab",
    kind: "vehicle",
    defaultPricingUnit: "per_km",
    fields: [...baseVehicleFields, "perHourPrice"],
    requiredFields: ["seatingCapacity", "basePrice"],
    legacyAliases: ["luxury", "premium-cab"],
  },
  {
    id: "tempo_traveller",
    label: "Tempo Traveller",
    kind: "vehicle",
    defaultPricingUnit: "per_day",
    fields: ["vehicleName", "seatingCapacity", "acAvailable", "luggageCapacity",
             "pricingUnit", "basePrice", "perKmPrice", "perDayPrice", "operatingAreas", "notes"],
    requiredFields: ["seatingCapacity", "basePrice"],
    legacyAliases: ["tempo", "traveller"],
  },
  {
    id: "mini_bus",
    label: "Mini bus",
    kind: "vehicle",
    defaultPricingUnit: "per_day",
    fields: ["vehicleName", "seatingCapacity", "acAvailable", "luggageCapacity",
             "pricingUnit", "basePrice", "perKmPrice", "perDayPrice", "operatingAreas", "notes"],
    requiredFields: ["seatingCapacity", "basePrice"],
    legacyAliases: ["minibus"],
  },
  {
    id: "bus",
    label: "Bus",
    kind: "vehicle",
    defaultPricingUnit: "per_day",
    fields: ["vehicleName", "seatingCapacity", "acAvailable", "luggageCapacity",
             "pricingUnit", "basePrice", "perKmPrice", "perDayPrice", "operatingAreas", "notes"],
    requiredFields: ["seatingCapacity", "basePrice"],
    legacyAliases: ["bus", "coach"],
  },
  {
    id: "driver_only",
    label: "Driver only (no vehicle)",
    kind: "service",
    defaultPricingUnit: "per_hour",
    fields: ["pricingUnit", "basePrice", "perHourPrice", "perDayPrice", "operatingAreas", "notes"],
    requiredFields: ["basePrice"],
    legacyAliases: ["driver", "chauffeur"],
  },
  {
    id: "goods_carrier",
    label: "Goods carrier / luggage transport",
    kind: "goods",
    defaultPricingUnit: "per_km",
    fields: ["vehicleName", "goodsCapacityKg", "pricingUnit", "basePrice", "perKmPrice",
             "operatingAreas", "notes"],
    requiredFields: ["goodsCapacityKg", "basePrice"],
    legacyAliases: ["van", "truck", "goods"],
  },
  {
    id: "airport_transfer",
    label: "Airport pickup / drop",
    kind: "route",
    defaultPricingUnit: "per_trip",
    fields: ["vehicleName", "seatingCapacity", "pricingUnit", "basePrice", "routesOrAirports", "notes"],
    requiredFields: ["basePrice", "routesOrAirports"],
    legacyAliases: ["airport"],
  },
  {
    id: "outstation_travel",
    label: "Outstation travel",
    kind: "route",
    defaultPricingUnit: "per_km",
    fields: ["vehicleName", "seatingCapacity", "acAvailable", "pricingUnit",
             "basePrice", "perKmPrice", "perDayPrice", "routesOrAirports", "notes"],
    requiredFields: ["basePrice"],
    legacyAliases: ["outstation", "intercity"],
  },
  {
    id: "local_hourly_rental",
    label: "Local hourly rental",
    kind: "service",
    defaultPricingUnit: "per_hour",
    fields: ["vehicleName", "seatingCapacity", "pricingUnit", "basePrice",
             "perHourPrice", "minHours", "maxHours", "operatingAreas", "notes"],
    requiredFields: ["basePrice", "perHourPrice"],
    legacyAliases: ["hourly", "local-rental"],
  },
  {
    id: "tour_package_driver",
    label: "Tour package driver",
    kind: "package_driver",
    defaultPricingUnit: "per_package",
    fields: ["vehicleName", "seatingCapacity", "acAvailable", "pricingUnit",
             "basePrice", "packageNotes", "operatingAreas", "notes"],
    requiredFields: ["basePrice", "packageNotes"],
    legacyAliases: ["package", "tour"],
  },
];

/** Special sentinel id used when the provider picks "Other vehicle or
 *  service type" — entries with this id store a free-text label in
 *  `displayName` and may carry minimal details. */
export const TRANSPORT_TYPE_OTHER = "other";

export interface TransportationTypeDetails {
  vehicleName?: string;
  seatingCapacity?: number;
  acAvailable?: boolean;
  luggageCapacity?: string;
  goodsCapacityKg?: number;
  pricingUnit?: PricingUnit;
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
}

export interface TransportationTypeEntry {
  type: string;
  displayName: string;
  details: TransportationTypeDetails;
}

const ID_INDEX = new Map(TRANSPORT_TYPES.map((t) => [t.id, t] as const));
const ALIAS_INDEX = new Map<string, TransportTypeDef>();
for (const t of TRANSPORT_TYPES) {
  for (const alias of t.legacyAliases ?? []) ALIAS_INDEX.set(alias.toLowerCase(), t);
  ALIAS_INDEX.set(t.id.toLowerCase(), t);
}

/** Lookup a catalog entry by id. */
export function getTransportTypeById(id: string): TransportTypeDef | undefined {
  return ID_INDEX.get(id);
}

/** Friendly label for a catalog id, or the id itself when unknown. */
export function getTransportTypeLabel(id: string, fallback?: string): string {
  return ID_INDEX.get(id)?.label ?? fallback ?? id;
}

/** Map a legacy single-string transport type ("cab", "driver-auto", "van")
 *  to the new catalog id. Returns null when no mapping exists. */
export function legacyToTypeId(legacy: string | undefined | null): string | null {
  if (!legacy) return null;
  const cleaned = String(legacy).toLowerCase().replace(/^driver-/, "");
  return ALIAS_INDEX.get(cleaned)?.id ?? ALIAS_INDEX.get(legacy.toLowerCase())?.id ?? null;
}

/** Coerce whatever the backend sent on `metadata.transportationTypes` into a
 *  well-formed array. Tolerates legacy rows that only have
 *  `metadata.transportType` (a single string) — folds them into a one-entry
 *  array using the legacy alias map. Returns [] when nothing usable exists. */
export function normalizeTransportationTypes(
  rawTypes: unknown,
  legacyTransportType?: unknown,
): TransportationTypeEntry[] {
  const out: TransportationTypeEntry[] = [];
  if (Array.isArray(rawTypes)) {
    for (const item of rawTypes) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const type = typeof obj.type === "string" ? obj.type : "";
      if (!type) continue;
      const displayName = typeof obj.displayName === "string" && obj.displayName.trim()
        ? obj.displayName
        : getTransportTypeLabel(type, type);
      const details = (obj.details && typeof obj.details === "object" ? obj.details : {}) as TransportationTypeDetails;
      out.push({ type, displayName, details });
    }
  }
  if (out.length === 0 && legacyTransportType) {
    const id = legacyToTypeId(String(legacyTransportType));
    if (id) {
      out.push({ type: id, displayName: getTransportTypeLabel(id), details: {} });
    } else {
      const raw = String(legacyTransportType);
      out.push({
        type: TRANSPORT_TYPE_OTHER,
        displayName: raw.charAt(0).toUpperCase() + raw.slice(1),
        details: {},
      });
    }
  }
  return out;
}

/** Check whether a per-type entry has all its required fields filled. Used
 *  by the onboarding form to highlight incomplete cards. */
export function validateTransportationTypeEntry(entry: TransportationTypeEntry): {
  ok: boolean;
  missing: DetailFieldId[];
} {
  if (entry.type === TRANSPORT_TYPE_OTHER) {
    const missing: DetailFieldId[] = [];
    if (!entry.displayName.trim()) {
      // The custom label IS the required field for "Other".
      missing.push("notes");
    }
    // basePrice must be strictly positive — free rides aren't a product
    // feature today, and 0 was previously a silent way to publish an
    // unpriced listing.
    if (entry.details.basePrice == null || !(entry.details.basePrice > 0)) {
      missing.push("basePrice");
    }
    return { ok: missing.length === 0, missing };
  }
  const def = ID_INDEX.get(entry.type);
  if (!def) return { ok: true, missing: [] };
  const missing: DetailFieldId[] = [];
  for (const f of def.requiredFields) {
    const v = entry.details[f as keyof TransportationTypeDetails];
    // Pricing fields (basePrice / perKmPrice / perHourPrice / perDayPrice
    // / goodsCapacityKg / seatingCapacity / minHours / maxHours) must be
    // strictly positive when declared required — 0 is treated as
    // "unfilled", not "intentionally free".
    const isNumericField = f === "basePrice" || f === "perKmPrice"
      || f === "perHourPrice" || f === "perDayPrice"
      || f === "goodsCapacityKg" || f === "seatingCapacity"
      || f === "minHours" || f === "maxHours";
    if (v == null || v === "" || (typeof v === "number" && Number.isNaN(v))) {
      missing.push(f);
    } else if (isNumericField && typeof v === "number" && v <= 0) {
      missing.push(f);
    }
  }
  return { ok: missing.length === 0, missing };
}

/** Friendly label for a detail field — used by the form labels and by the
 *  "missing: X, Y" warning lines so both stay in sync. */
export const DETAIL_FIELD_LABEL: Record<DetailFieldId, string> = {
  vehicleName: "Vehicle name / model",
  seatingCapacity: "Seating capacity",
  acAvailable: "AC available",
  luggageCapacity: "Luggage capacity",
  goodsCapacityKg: "Cargo capacity (kg)",
  pricingUnit: "Pricing unit",
  basePrice: "Base price (₹)",
  perKmPrice: "Per km (₹)",
  perHourPrice: "Per hour (₹)",
  perDayPrice: "Per day (₹)",
  operatingAreas: "Operating areas / routes",
  routesOrAirports: "Routes / airports served",
  minHours: "Minimum hours",
  maxHours: "Maximum hours",
  packageNotes: "Package route & inclusions",
  notes: "Notes / special requirements",
};

export const PRICING_UNIT_LABEL: Record<PricingUnit, string> = {
  per_km: "Per kilometre",
  per_hour: "Per hour",
  per_day: "Per day",
  per_trip: "Per trip",
  per_package: "Per package",
  fixed: "Fixed price",
};

/** Friendly labels for transport-type filter chips. Sorted by the order of
 *  TRANSPORT_TYPES so the most common ones (auto, cab, etc.) come first. */
export function transportTypeFilterOptions(): Array<{ id: string; label: string }> {
  return TRANSPORT_TYPES.map(({ id, label }) => ({ id, label }));
}
