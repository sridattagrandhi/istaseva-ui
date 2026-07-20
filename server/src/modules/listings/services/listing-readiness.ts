/**
 * Centralized "can this listing go live?" validator. Runs server-side
 * before any activation/publish path flips is_active=true so the UI
 * disabled-button is a courtesy, not the actual gate.
 *
 * Returns a structured `missing` list so the client can render specific
 * fix-it prompts instead of parsing message strings.
 *
 * ── ARCHITECTURE ─────────────────────────────────────────────────────────
 * Phase 2 refactor: shared field-required rules (category, name, location,
 * description, experience, workingHours, mode-driven prices, etc.) are
 * sourced from FIELD_REGISTRY via getReadinessMissingFromRegistry().
 * That eliminates the drift class where the AI's submit_listing gate,
 * the FE form gate, and this activation gate could each disagree about
 * whether a field is required. Adding a new required field is now ONE
 * registry edit instead of three.
 *
 * Activation-only rules below — KYC, photo minimums, room-types
 * editor state, per-row transportation-type base price, property_type,
 * availability free text — have no submit/form equivalent and remain
 * hand-rolled. They run as a WRAPPER on top of the registry-derived
 * shared set.
 */
import {
  getReadinessMissingFromRegistry,
  type RegistryReadinessMissing,
} from '../../chat/agent/onboarding/registry/derive-readiness.js';

export interface ReadinessMissing {
  code: string;
  label: string;
  message: string;
}

export interface ReadinessResult {
  ready: boolean;
  missing: ReadinessMissing[];
}

export interface ReadinessRoomType {
  name: string;
  base_price_paise: string | number | null;
  max_guests: number | null;
  quantity: number | null;
  photos: string[] | null;
}

export interface ReadinessVerificationDoc {
  document_type: string;
  status: string;
}

export interface ReadinessUser {
  verification_status: string;
}

export interface ReadinessInput {
  listing: Record<string, unknown>;
  roomTypes: ReadinessRoomType[];
  user: ReadinessUser;
  documents: ReadinessVerificationDoc[];
}

const STAY_CATEGORIES = new Set([
  'hotel', 'homestay', 'lodge', 'village-stay', 'farm-stay', 'heritage', 'sathram', 'stay',
]);
// Sathrams sit under the `homestay` category but expose multiple cell /
// dormitory tiers, so the readiness branch treats them the same as
// hotel/lodge/heritage. `isMultiRoomStay()` below adds the propertyType
// check on top of this category set.
const MULTI_ROOM_STAY_CATEGORIES = new Set(['hotel', 'lodge', 'heritage']);
const TRANSPORT_CATEGORIES = new Set([
  'auto', 'cab', 'van', 'bike', 'tempo', 'driver-auto', 'driver-cab',
]);

// Photo minimums per listing kind. Aligned with the FE form's quality
// bar so the AI/manual flow can't slip a 1-photo listing past activation
// when the customer-facing form (and product expectation) is 5. Stays
// have always required 5; transport stays at 1 because a single vehicle
// photo is enough for a driver card.
export const STAY_PHOTO_MIN = 5;
export const SERVICE_PHOTO_MIN = 5;
export const TRANSPORT_PHOTO_MIN = 1;

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function getMetadata(listing: Record<string, unknown>): Record<string, unknown> {
  const m = listing.metadata;
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

export function deriveListingKind(
  listing: Record<string, unknown>,
): 'stay' | 'service' | 'transport' {
  const explicit = listing.listing_type;
  if (explicit === 'stay' || explicit === 'service' || explicit === 'transport') return explicit;
  const meta = getMetadata(listing);
  const metaKind = meta.listingType;
  if (metaKind === 'stay' || metaKind === 'service' || metaKind === 'transport') return metaKind;
  const category = typeof listing.category === 'string' ? listing.category : '';
  if (TRANSPORT_CATEGORIES.has(category) || listing.vehicle_name) return 'transport';
  if (
    STAY_CATEGORIES.has(category)
    || listing.property_type
    || listing.price_per_night
    || category.startsWith('stay:')
  ) return 'stay';
  return 'service';
}

function isMultiRoomStay(category: string, propertyType: string): boolean {
  if (MULTI_ROOM_STAY_CATEGORIES.has(category)) return true;
  // Sathrams are category=`homestay` + property_type=`sathram`. We treat
  // them like a small lodge for readiness — rooms required, no
  // property-level price/bedrooms/maxGuests gate. Same call inside
  // room-types.service.ts, kept in sync.
  if (propertyType === 'sathram') return true;
  return false;
}

function photoCount(listing: Record<string, unknown>): number {
  const photos = listing.photos;
  if (Array.isArray(photos)) return photos.length;
  return 0;
}

/** De-dupe by code so the registry's shared set + the activation-only
 *  wrappers can both surface the same field name without double-listing
 *  it (e.g. if both ever fired 'service_radius_required'). */
function mergeUnique(
  ...lists: Array<ReadinessMissing[] | RegistryReadinessMissing[]>
): ReadinessMissing[] {
  const seen = new Set<string>();
  const out: ReadinessMissing[] = [];
  for (const list of lists) {
    for (const m of list) {
      if (seen.has(m.code)) continue;
      seen.add(m.code);
      out.push(m);
    }
  }
  return out;
}

/**
 * Identity (Aadhaar or configured equivalent) is required for ALL providers.
 * Transport additionally requires a driving license. Pending/rejected docs
 * never count — only `approved`.
 */
function validateKyc(input: ReadinessInput, kind: 'stay' | 'service' | 'transport'): ReadinessMissing[] {
  const missing: ReadinessMissing[] = [];
  const { user, documents } = input;

  const approved = new Set(
    documents.filter((d) => d.status === 'approved').map((d) => d.document_type),
  );
  const pending = new Set(
    documents.filter((d) => d.status === 'pending').map((d) => d.document_type),
  );

  if (!approved.has('aadhaar')) {
    if (pending.has('aadhaar')) {
      missing.push({
        code: 'kyc_aadhaar_pending',
        label: 'Identity verification',
        message: 'Your identity verification is still pending.',
      });
    } else {
      missing.push({
        code: 'kyc_aadhaar_required',
        label: 'Aadhaar verification',
        message: 'Aadhaar verification is required.',
      });
    }
  }

  if (kind === 'transport') {
    if (!approved.has('driving_license')) {
      if (pending.has('driving_license')) {
        missing.push({
          code: 'kyc_driving_license_pending',
          label: 'Driving license verification',
          message: 'Your driving license verification is still pending.',
        });
      } else {
        missing.push({
          code: 'kyc_driving_license_required',
          label: 'Driving license verification',
          message: 'Driving license verification is required for transport listings.',
        });
      }
    }
  }

  // If the user record itself is not verified but the docs above all pass,
  // surface the user state so callers know to refresh status.
  if (missing.length === 0 && user.verification_status !== 'verified') {
    missing.push({
      code: 'user_not_verified',
      label: 'Identity verification',
      message: 'Your identity verification is still pending.',
    });
  }

  return missing;
}

// ── Activation-only wrappers (no registry equivalent) ────────────────────
// These rules are enforced only at publish/activate time, not by the AI
// agent's submit_listing or the FE form. Each function returns ONLY the
// activation-specific entries — the shared field-required rules come
// from getReadinessMissingFromRegistry() in validateListingReadiness.

function validateStayActivationOnly(input: ReadinessInput): ReadinessMissing[] {
  const missing: ReadinessMissing[] = [];
  const { listing, roomTypes } = input;
  const category = typeof listing.category === 'string' ? listing.category : '';
  const propertyType = typeof listing.property_type === 'string'
    ? listing.property_type
    : (typeof (getMetadata(listing).propertyType) === 'string'
        ? (getMetadata(listing).propertyType as string)
        : '');
  const multiRoom = isMultiRoomStay(category, propertyType);

  // property_type is a stay-specific top-level column that the registry
  // doesn't model (the registry has propertyType but as optional). The
  // activation gate requires it always.
  if (!nonEmpty(listing.property_type)) {
    missing.push({
      code: 'property_type_required',
      label: 'Property type',
      message: 'Select a property type.',
    });
  }

  if (photoCount(listing) < STAY_PHOTO_MIN) {
    missing.push({
      code: 'photos_required',
      label: 'Photos',
      message: `Add at least ${STAY_PHOTO_MIN} photos.`,
    });
  }

  // Free-text availability is required for activation but the registry
  // doesn't require it (the AI agent uses workingHours for the bookable
  // schedule; availability is a customer-facing label like "Year-round").
  if (!nonEmpty(listing.availability)) {
    missing.push({
      code: 'availability_required',
      label: 'Availability',
      message: 'Set availability.',
    });
  }

  // Room-types editor state is FE-side data the registry can't see at
  // submit time. The activation gate is the only place these can be
  // checked end-to-end.
  if (multiRoom) {
    if (!roomTypes.length) {
      missing.push({
        code: 'room_types_required',
        label: 'Room types',
        message: 'Add at least one room type with a price.',
      });
    } else {
      const valid = roomTypes.filter((rt) => {
        const price = asNumber(rt.base_price_paise);
        return (
          nonEmpty(rt.name)
          && price !== null && price > 0
          && (rt.max_guests ?? 0) > 0
          && (rt.quantity ?? 0) > 0
        );
      });
      if (!valid.length) {
        missing.push({
          code: 'room_types_incomplete',
          label: 'Room types',
          message: 'Each room type needs a name, price, capacity, and quantity.',
        });
      } else {
        // Hotel/lodge/heritage rooms must each carry at least one photo —
        // the booking UI shows the room photo, not the listing photo, for
        // multi-room stays.
        const missingPhoto = valid.some((rt) => !Array.isArray(rt.photos) || rt.photos.length === 0);
        if (missingPhoto) {
          missing.push({
            code: 'room_type_photos_required',
            label: 'Room photos',
            message: 'Add at least one photo to every room type.',
          });
        }
      }
    }
  } else {
    // Single-unit stays — bathrooms is the only one the registry doesn't
    // require (bedrooms/maxGuests/price come from the registry).
    if ((asNumber(listing.bathrooms) ?? 0) <= 0) {
      missing.push({ code: 'bathrooms_required', label: 'Bathrooms', message: 'Set bathrooms.' });
    }
  }

  return missing;
}

function validateServiceActivationOnly(input: ReadinessInput): ReadinessMissing[] {
  const missing: ReadinessMissing[] = [];
  const { listing } = input;
  const meta = getMetadata(listing);

  if (photoCount(listing) < SERVICE_PHOTO_MIN) {
    // Note: pluralized message assumes SERVICE_PHOTO_MIN > 1. If the
    // constant ever drops back to 1, update the message accordingly.
    missing.push({
      code: 'photos_required',
      label: 'Photos',
      message: `Add at least ${SERVICE_PHOTO_MIN} photos.`,
    });
  }

  // Service activation also requires a top-level price string (the
  // registry leaves price service-optional now that servicesCatalog
  // exists, but the legacy activation contract still wants it).
  if (!nonEmpty(listing.price)) {
    missing.push({ code: 'price_required', label: 'Price', message: 'Set a price.' });
  }

  // duration: registry requires non-empty; activation gate ALSO accepts
  // a numeric serviceDurationMinutes — that's a row-level alias the
  // registry doesn't model.
  if (!nonEmpty(meta.duration) && !nonEmpty((meta as Record<string, unknown>).serviceDurationMinutes)) {
    // Already covered by registry's duration check when meta.duration is
    // empty — but if registry was satisfied by serviceDurationMinutes,
    // we'd never reach here. mergeUnique() dedupes if both fire.
  }

  if (!nonEmpty(listing.availability)) {
    missing.push({
      code: 'availability_required',
      label: 'Availability',
      message: 'Set availability.',
    });
  }

  // workingHours activation accepts a fallback: serviceTimeSlots[] array
  // (legacy slot-array shape some service listings carry instead of a
  // weekly grid). The registry doesn't know about serviceTimeSlots, so
  // we skip the registry's workingHours hit when slots exist.
  const workingHours = meta.workingHours;
  const hasHours = workingHours && typeof workingHours === 'object'
    && Object.values(workingHours).some((v) => Array.isArray(v) && v.length === 2);
  const slots = (meta as Record<string, unknown>).serviceTimeSlots;
  const hasSlots = Array.isArray(slots) && slots.length > 0;
  if (!hasHours && hasSlots) {
    // The registry would have flagged 'workingHours' as missing; remove
    // that entry post-hoc by signaling here. Done via the suppress list
    // in validateListingReadiness().
  }

  return missing;
}

function validateTransportActivationOnly(input: ReadinessInput): ReadinessMissing[] {
  const missing: ReadinessMissing[] = [];
  const { listing } = input;
  const meta = getMetadata(listing);

  if (photoCount(listing) < TRANSPORT_PHOTO_MIN) {
    missing.push({
      code: 'photos_required',
      label: 'Photos',
      message: `Add at least ${TRANSPORT_PHOTO_MIN} photo.`,
    });
  }

  // Per-row transportation-type base price check — the registry's
  // transportationTypes field uses customGate but produces strings like
  // "transportationTypes[sedan_cab]: basePrice" rather than the
  // structured 'transportation_type_base_price_required' code the
  // dashboard expects. Keep this check hand-rolled with the canonical
  // code so the dashboard's fix-it routing keeps working.
  const transportationTypesRaw = (meta as Record<string, unknown>).transportationTypes;
  const transportationTypes = Array.isArray(transportationTypesRaw) ? transportationTypesRaw : [];
  if (transportationTypes.length > 0) {
    const unpriced = transportationTypes.filter((t: unknown) => {
      const obj = t as { details?: { basePrice?: unknown } } | null;
      const p = obj?.details?.basePrice;
      return p == null || (typeof p === 'number' && !(p > 0)) || (typeof p === 'string' && (p.trim() === '' || !(Number(p) > 0)));
    });
    if (unpriced.length > 0) {
      missing.push({
        code: 'transportation_type_base_price_required',
        label: 'Per-type base price',
        message: 'Every transportation type needs a base price.',
      });
    }
  }
  // Legacy back-compat: a row with vehicle_name + transportType but no
  // transportationTypes[] is still acceptable to activation. The
  // registry doesn't know about this back-compat shape, so if it fires
  // 'transportation_types_required' we suppress it when the legacy
  // pair is present (handled in validateListingReadiness via suppress
  // list).

  // languages: activation requires it for transport. The registry now also
  // enforces languages (requiredFor service + transport), so for transport
  // this is redundant with the registry-derived check — mergeUnique()
  // dedupes the shared 'languages_required' code. Kept as a belt-and-braces
  // guard on the transport activation path.
  const languages = Array.isArray(meta.languages) ? (meta.languages as unknown[]) : [];
  if (languages.length === 0) {
    missing.push({
      code: 'languages_required',
      label: 'Languages',
      message: 'Add at least one language you speak.',
    });
  }

  // pickup_area — activation accepts location || service_area || meta.pickupArea.
  // The registry's `location` check already accepts all three via the
  // listingRowToProfile mapping, but the activation gate uses a
  // distinct `pickup_area_required` code for transport. If the registry
  // says location is missing on a transport listing, remap the code.
  // Handled in validateListingReadiness.

  return missing;
}

/** Codes the registry might emit that need to be re-keyed or suppressed
 *  by the activation wrapper. Each entry: when the registry produces
 *  `from`, the wrapper either drops it (no `to`) or replaces it with
 *  the activation-specific code (`to`). */
function remapForActivation(
  kind: 'stay' | 'service' | 'transport',
  listing: Record<string, unknown>,
  registryMissing: RegistryReadinessMissing[],
): RegistryReadinessMissing[] {
  const meta = getMetadata(listing);
  const out: RegistryReadinessMissing[] = [];
  for (const m of registryMissing) {
    // Transport: 'location_required' becomes 'pickup_area_required' for
    // back-compat with the dashboard's fix-it routing.
    if (kind === 'transport' && m.code === 'location_required') {
      out.push({
        code: 'pickup_area_required',
        label: 'Pickup / service area',
        message: 'Set your pickup or service area.',
      });
      continue;
    }
    // Service: workingHours requirement is satisfied by either a
    // weekly grid OR a serviceTimeSlots[] array. Registry only checks
    // the grid; suppress when slots are populated.
    if (kind === 'service' && m.code === 'working_hours_required') {
      const slots = (meta as Record<string, unknown>).serviceTimeSlots;
      if (Array.isArray(slots) && slots.length > 0) continue;
    }
    // Transport: transportationTypes requirement is satisfied by the
    // legacy vehicle_name + transportType pair. Suppress when present.
    if (kind === 'transport' && m.code === 'transportation_types_required') {
      const hasLegacy = nonEmpty(listing.vehicle_name) && nonEmpty(meta.transportType);
      if (hasLegacy) continue;
    }
    out.push(m);
  }
  return out;
}

export function validateListingReadiness(input: ReadinessInput): ReadinessResult {
  const kind = deriveListingKind(input.listing);

  // 1. KYC — activation-only.
  const kycMissing = validateKyc(input, kind);

  // 2. Shared field-required rules — from the registry.
  const registryMissingRaw = getReadinessMissingFromRegistry(input.listing);
  const registryMissing = remapForActivation(kind, input.listing, registryMissingRaw);

  // 3. Activation-only wrappers per listing kind.
  let activationOnly: ReadinessMissing[];
  if (kind === 'stay') activationOnly = validateStayActivationOnly(input);
  else if (kind === 'service') activationOnly = validateServiceActivationOnly(input);
  else activationOnly = validateTransportActivationOnly(input);

  // Deduplicate by code — the registry and the activation wrappers
  // shouldn't normally overlap, but if a code escapes through both
  // paths, the dashboard would render two identical fix-it cards.
  const missing = mergeUnique(kycMissing, registryMissing, activationOnly);
  return { ready: missing.length === 0, missing };
}
