/**
 * Shared builder for a listing's normalized `priceableOptions` menu — the
 * type-agnostic list of EVERY priced option (stay room types, service variants,
 * transport modes/packages) plus service-wide add-ons, in one shape.
 *
 * Extracted from get-listing-details.tool.ts so TWO callers can use the SAME
 * computation:
 *   1. get_listing_details — surfaces it to the model.
 *   2. the full-menu backstop's self-fetch (user-assistant.service.ts) — when
 *      the model answered "tell me more" WITHOUT calling get_listing_details
 *      (improvising from the thin search hit), the backstop fetches the listing
 *      itself and builds this list to complete the partial reply.
 *
 * Behavior-preserving: this must produce the same array the tool's inline block
 * did. The get_listing_details tests + service-variant-pricing integration test
 * guard against drift.
 */

export interface PriceableOption {
  group: string;
  name: string;
  price: number;
  unit: 'per_visit' | 'per_hour' | 'per_night' | 'per_day' | 'package';
  maxGuests?: number;
  addOns?: Array<{ name: string; price: number }>;
}

type AddOn = { id: string; label: string; price: number };

/** Positive finite number from a string/number, else undefined. */
function num(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'string' ? Number(v.replace(/[^\d.]/g, '')) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Validate + normalize an add-on array (variant or listing-level). Mirrors the
 *  shape get_listing_details surfaces so the menu matches what the user saw. */
function normalizeAddOns(raw: unknown): AddOn[] {
  if (!Array.isArray(raw)) return [];
  const out: AddOn[] = [];
  raw.forEach((p, idx) => {
    if (!p || typeof p !== 'object') return;
    const row = p as Record<string, unknown>;
    const label = typeof row.label === 'string' ? row.label.trim() : '';
    const priceNum = Number(row.price);
    if (!label || !Number.isFinite(priceNum) || priceNum < 0) return;
    out.push({
      id: typeof row.id === 'string' && row.id.trim() ? row.id : `addon-${idx + 1}`,
      label,
      price: Math.round(priceNum),
    });
  });
  return out;
}

/**
 * Build the normalized priced-options menu for a listing record (the shape
 * returned by listingsService.getById, with room_types joined in and metadata
 * as JSONB). Returns [] when nothing is priceable.
 */
export function buildPriceableOptions(listing: Record<string, unknown>): PriceableOption[] {
  // Rooms — prices live in room_types.base_price_paise.
  const rawRooms = Array.isArray(listing.room_types)
    ? (listing.room_types as Array<Record<string, unknown>>)
    : [];
  const rooms = rawRooms.map((r) => {
    const paise = Number(r.base_price_paise);
    return {
      name: typeof r.name === 'string' ? r.name : undefined,
      pricePerNight: Number.isFinite(paise) && paise > 0 ? Math.round(paise / 100) : undefined,
      maxGuests: typeof r.max_guests === 'number' ? r.max_guests : undefined,
    };
  });
  const hasRoomTypes = rooms.length > 0;

  const meta = (listing.metadata as Record<string, unknown> | null | undefined) ?? {};
  const listingType = String(listing.listing_type ?? meta.listingType ?? '').toLowerCase();
  const isService = listingType === 'service';
  const isTransport = listingType === 'transport';

  // Transport priced modes.
  const pricePerHour = isTransport ? num(meta.pricePerHour) : undefined;
  const pricePerDay = isTransport ? num(meta.pricePerDay) : undefined;
  const packageOptions: Array<{ label: string; price: number }> = [];
  if (isTransport && Array.isArray(meta.packageOptions)) {
    (meta.packageOptions as unknown[]).forEach((p) => {
      if (!p || typeof p !== 'object') return;
      const row = p as Record<string, unknown>;
      const label = typeof row.label === 'string' ? row.label : '';
      const price = num(row.price);
      if (!label || price == null) return;
      packageOptions.push({ label, price });
    });
  }
  const transportModes: Array<'hourly' | 'day' | 'package'> = [];
  if (pricePerHour != null) transportModes.push('hourly');
  if (pricePerDay != null) transportModes.push('day');
  if (packageOptions.length > 0) transportModes.push('package');

  // Service-wide add-ons.
  const addOns = isService ? normalizeAddOns(meta.addOns) : [];

  // Service variants (Men's / Women's / Kid's …), each with its own add-ons.
  const serviceCatalog: Array<{ name: string; basePrice: number; addOns: AddOn[] }> = [];
  if (isService && Array.isArray(meta.servicesCatalog)) {
    (meta.servicesCatalog as unknown[]).forEach((g) => {
      if (!g || typeof g !== 'object') return;
      const row = g as Record<string, unknown>;
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      const basePrice = Number(row.basePrice);
      if (!name || !Number.isFinite(basePrice) || basePrice <= 0) return;
      serviceCatalog.push({ name, basePrice: Math.round(basePrice), addOns: normalizeAddOns(row.addOns) });
    });
  }

  const serviceUnit: 'per_visit' | 'per_hour' = meta.pricingUnit === 'per_hour' ? 'per_hour' : 'per_visit';

  // Single-price listings (one nightly rate / single-price service).
  const singlePriceRupees: number | undefined = (() => {
    if (typeof listing.price_paise === 'number' && listing.price_paise > 0) return Math.round(listing.price_paise / 100);
    if (typeof listing.price === 'number' && listing.price > 0) return Math.round(listing.price);
    if (typeof listing.price === 'string') {
      const n = Number(listing.price.replace(/[^\d.]/g, ''));
      return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
    }
    if (typeof listing.price_per_night === 'number' && listing.price_per_night > 0) return Math.round(listing.price_per_night);
    return undefined;
  })();
  const maxGuestsTop = typeof listing.guests === 'number' ? listing.guests : undefined;

  const out: PriceableOption[] = [];
  if (hasRoomTypes) {
    rooms.forEach((r) => {
      if (r.pricePerNight == null) return;
      out.push({
        group: 'Rooms',
        name: r.name || 'Room',
        price: r.pricePerNight,
        unit: 'per_night',
        ...(r.maxGuests != null ? { maxGuests: r.maxGuests } : {}),
      });
    });
  } else if (isService && serviceCatalog.length > 0) {
    serviceCatalog.forEach((v) => {
      out.push({
        group: 'Services',
        name: v.name,
        price: v.basePrice,
        unit: serviceUnit,
        ...(v.addOns.length > 0 ? { addOns: v.addOns.map((a) => ({ name: a.label, price: a.price })) } : {}),
      });
    });
  } else if (isTransport && transportModes.length > 0) {
    if (pricePerHour != null) out.push({ group: 'Transport', name: 'Hourly rental', price: pricePerHour, unit: 'per_hour' });
    if (pricePerDay != null) out.push({ group: 'Transport', name: 'Day rental', price: pricePerDay, unit: 'per_day' });
    packageOptions.forEach((p) => out.push({ group: 'Transport', name: p.label, price: p.price, unit: 'package' }));
  } else if (singlePriceRupees != null) {
    out.push({
      group: isService ? 'Service' : 'Stay',
      name: String(listing.title ?? listing.name ?? 'Option'),
      price: singlePriceRupees,
      unit: isService ? serviceUnit : 'per_night',
      ...(maxGuestsTop != null ? { maxGuests: maxGuestsTop } : {}),
    });
  }
  // Service-wide add-ons — listed once, on their own.
  if (isService && addOns.length > 0) {
    addOns.forEach((a) => out.push({ group: 'Add-ons', name: a.label, price: a.price, unit: serviceUnit }));
  }
  return out;
}
