/**
 * Server-side mirror of the transport catalog's required-fields contract.
 *
 * Kept narrow on purpose — the rich catalog (labels, kinds, default
 * pricing units, etc.) lives in `src/lib/transport-types.ts` on the
 * frontend and drives the manual onboarding UI. The server only needs
 * "for this id, which detail fields are required and what shape do they
 * take?" so it can reject incomplete `transportationTypes[]` entries
 * submitted by the AI agent.
 *
 * If you add a new catalog id on the frontend, mirror it here. Drift is
 * possible but the test surface is tiny and the failure mode is a
 * client-side green light + server-side reject — visible, not silent.
 */

export type DetailFieldId =
  | 'vehicleName'
  | 'seatingCapacity'
  | 'acAvailable'
  | 'luggageCapacity'
  | 'goodsCapacityKg'
  | 'pricingUnit'
  | 'basePrice'
  | 'perKmPrice'
  | 'perHourPrice'
  | 'perDayPrice'
  | 'operatingAreas'
  | 'routesOrAirports'
  | 'minHours'
  | 'maxHours'
  | 'packageNotes'
  | 'notes';

export interface TransportTypeDef {
  id: string;
  requiredFields: DetailFieldId[];
}

/** Required-fields map for every catalog id. Mirrors
 *  `TRANSPORT_TYPES.requiredFields` in `src/lib/transport-types.ts`. */
export const SERVER_TRANSPORT_TYPE_REQUIREMENTS: TransportTypeDef[] = [
  { id: 'auto_rickshaw',         requiredFields: ['seatingCapacity', 'basePrice'] },
  { id: 'e_rickshaw',            requiredFields: ['seatingCapacity', 'basePrice'] },
  { id: 'bike_taxi',             requiredFields: ['basePrice'] },
  { id: 'scooter_taxi',          requiredFields: ['basePrice'] },
  { id: 'hatchback_cab',         requiredFields: ['seatingCapacity', 'basePrice'] },
  { id: 'sedan_cab',             requiredFields: ['seatingCapacity', 'basePrice'] },
  { id: 'suv_cab',               requiredFields: ['seatingCapacity', 'basePrice'] },
  { id: 'luxury_cab',            requiredFields: ['seatingCapacity', 'basePrice'] },
  { id: 'tempo_traveller',       requiredFields: ['seatingCapacity', 'basePrice'] },
  { id: 'mini_bus',              requiredFields: ['seatingCapacity', 'basePrice'] },
  { id: 'bus',                   requiredFields: ['seatingCapacity', 'basePrice'] },
  { id: 'driver_only',           requiredFields: ['basePrice'] },
  { id: 'goods_carrier',         requiredFields: ['goodsCapacityKg', 'basePrice'] },
  { id: 'airport_transfer',      requiredFields: ['basePrice', 'routesOrAirports'] },
  { id: 'outstation_travel',     requiredFields: ['basePrice'] },
  { id: 'local_hourly_rental',   requiredFields: ['basePrice', 'perHourPrice'] },
  { id: 'tour_package_driver',   requiredFields: ['basePrice', 'packageNotes'] },
];

const SERVER_TRANSPORT_TYPE_OTHER = 'other';

/** Numeric fields where 0 means "not filled". Strict-positive when
 *  declared required — matches the client's
 *  `validateTransportationTypeEntry`. */
const NUMERIC_FIELDS = new Set<DetailFieldId>([
  'basePrice', 'perKmPrice', 'perHourPrice', 'perDayPrice',
  'goodsCapacityKg', 'seatingCapacity', 'minHours', 'maxHours',
]);

const REQUIREMENTS_BY_ID = new Map(
  SERVER_TRANSPORT_TYPE_REQUIREMENTS.map((d) => [d.id, d.requiredFields] as const),
);

export interface ServerTransportEntry {
  type?: unknown;
  displayName?: unknown;
  details?: Record<string, unknown>;
}

/** Validate one entry's required fields. Returns the list of missing
 *  field ids, empty when complete. Catalog-unknown ids return [] —
 *  the client may have a newer catalog than the server; we don't want
 *  to block valid listings on a server-side data drift. */
export function validateServerTransportEntry(entry: ServerTransportEntry): {
  ok: boolean;
  missing: DetailFieldId[];
} {
  if (!entry || typeof entry !== 'object') return { ok: false, missing: ['basePrice'] };
  const type = typeof entry.type === 'string' ? entry.type : '';
  if (!type) return { ok: false, missing: ['basePrice'] };

  const details = (entry.details && typeof entry.details === 'object'
    ? entry.details
    : {}) as Record<string, unknown>;

  if (type === SERVER_TRANSPORT_TYPE_OTHER) {
    const missing: DetailFieldId[] = [];
    const displayName = typeof entry.displayName === 'string' ? entry.displayName.trim() : '';
    // Custom entries: displayName is required (label-the-thing) plus a
    // positive basePrice.
    if (!displayName) missing.push('notes');
    if (!isPositiveNumber(details.basePrice)) missing.push('basePrice');
    return { ok: missing.length === 0, missing };
  }

  const required = REQUIREMENTS_BY_ID.get(type);
  if (!required) return { ok: true, missing: [] };

  const missing: DetailFieldId[] = [];
  for (const f of required) {
    const v = details[f];
    if (NUMERIC_FIELDS.has(f)) {
      if (!isPositiveNumber(v)) missing.push(f);
    } else {
      if (typeof v !== 'string' || v.trim().length === 0) missing.push(f);
    }
  }
  return { ok: missing.length === 0, missing };
}

function isPositiveNumber(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) && n > 0;
  }
  return false;
}

/** Walk every entry and collect per-type missing fields. Returns a
 *  human-friendly list the caller can include in a "Not ready" error. */
export function validateServerTransportationTypes(entries: unknown[]): {
  ok: boolean;
  errors: Array<{ type: string; missing: DetailFieldId[] }>;
} {
  const errors: Array<{ type: string; missing: DetailFieldId[] }> = [];
  for (const raw of entries) {
    const entry = raw as ServerTransportEntry;
    const { ok, missing } = validateServerTransportEntry(entry);
    if (!ok) {
      const typeLabel = typeof entry?.type === 'string' && entry.type
        ? entry.type
        : 'unknown';
      errors.push({ type: typeLabel, missing });
    }
  }
  return { ok: errors.length === 0, errors };
}
