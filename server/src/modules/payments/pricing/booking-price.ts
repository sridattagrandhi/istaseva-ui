/**
 * Backend booking-price helper — the SINGLE source of truth for the official
 * total stored on a booking and validated against payment.
 *
 * Why this exists:
 * The frontend renders pricing previews on the booking modal, the success
 * screen, and the email/invoice. Any of those numbers being off (rounding,
 * tampering, stale UI) used to flow straight into `bookings.agreed_price_paise`
 * because createHold trusted `input.agreedPrice`. That made the validation
 * in createOrder circular — server validated against a value the client had
 * supplied earlier.
 *
 * Now: every booking flow (stay modal, service modal, transport prebook,
 * transport quote-accept, assistant booking) computes the host subtotal from
 * authoritative DB rows (listing, room, transport metadata, provider quote),
 * then funnels through `applyFeesAndCoupon` for the platform fee + GST +
 * coupon math. The frontend may still post `agreedPrice` as a CLAIM; createHold
 * compares it to the server total and rejects on disagreement.
 *
 * Contract:
 *   discounted = max(0, subtotal − coupon discount)
 *   total      = (discounted + flatPlatformFee) × (1 + gstRate)  [rounded]
 *
 * Insurance is added later at payment time (createOrder), since insurance is
 * an opt-in toggled per checkout — not part of the held booking.
 */

import {
  computePlatformFeePaise,
  gstRateFor,
  LEGACY_PLATFORM_FEE_SPEC,
  type PlatformFeeSpec,
} from './fees.js';

export interface CouponSpec {
  /** percent (0–100) or fixed (rupees off the subtotal). */
  discountType: 'percent' | 'fixed';
  discountValue: number;
}

export interface BookingPriceBreakdown {
  /** Host's portion (pre-discount) in paise. */
  subtotalPaise: number;
  /** Coupon discount applied to subtotal in paise (0 when no coupon). */
  discountPaise: number;
  /** Subtotal after coupon — what fees + GST are computed against. */
  discountedSubtotalPaise: number;
  /** Platform fee in paise — from the resolved fee-rule spec when one is
   *  passed, else the legacy flat PLATFORM_FEE_PAISE. */
  platformFeePaise: number;
  /** GST in paise = round((discountedSubtotal + platformFee) × gstRate). */
  taxesPaise: number;
  /** GST rate that was applied (0.05 / 0.12 / 0.18). */
  gstRate: number;
  /** Net total the customer will be charged (excludes insurance). */
  totalPaise: number;
}

/**
 * Apply platform fee + GST to a subtotal that's already had any coupon
 * discount subtracted. Most call sites use `applyFeesAndCoupon` (which
 * computes the discount from a coupon spec) — `applyFees` is for callers
 * that resolve the discount transactionally elsewhere (createHold uses
 * `couponsService.consume` which atomically increments uses_count and
 * returns the canonical discount amount).
 *
 *   discounted = max(1 paise floor, subtotal − discount)
 *   platformFee = flat PLATFORM_FEE_PAISE
 *   taxes       = round((discounted + platformFee) × gstRate)
 *   total       = discounted + platformFee + taxes
 *
 * The 1-paise floor mirrors `couponsService.quoteFromRow` which never lets
 * the discounted price drop to zero (Razorpay rejects ₹0 orders).
 */
export function applyFees(input: {
  subtotalPaise: number;
  discountPaise?: number;
  category: string | null;
  nightlyHintPaise?: number | null;
  /** Resolved fee-rule spec from fee-rules.service. Omitted → legacy flat
   *  fee, which keeps every pre-panel call site and test byte-identical. */
  fee?: PlatformFeeSpec | null;
}): BookingPriceBreakdown {
  const subtotal = Math.max(0, Math.round(input.subtotalPaise || 0));
  const discount = Math.max(0, Math.min(subtotal, Math.round(input.discountPaise ?? 0)));
  const discounted = Math.max(1, subtotal - discount);
  const gstRate = gstRateFor(input.category, input.nightlyHintPaise ?? null);
  const platformFee = computePlatformFeePaise(discounted, input.fee ?? LEGACY_PLATFORM_FEE_SPEC);
  const taxes = Math.round((discounted + platformFee) * gstRate);
  const total = discounted + platformFee + taxes;
  return {
    subtotalPaise: subtotal,
    discountPaise: discount,
    discountedSubtotalPaise: discounted,
    platformFeePaise: platformFee,
    taxesPaise: taxes,
    gstRate,
    totalPaise: total,
  };
}

/**
 * Same math as `applyFees`, but computes the coupon discount from a coupon
 * spec (`{ discountType, discountValue }`). Use this in flows that don't
 * need transactional `consume` locking — preview pages, tests, etc.
 */
export function applyFeesAndCoupon(input: {
  subtotalPaise: number;
  category: string | null;
  nightlyHintPaise?: number | null;
  coupon?: CouponSpec | null;
}): BookingPriceBreakdown {
  const subtotal = Math.max(0, Math.round(input.subtotalPaise || 0));
  let discount = 0;
  if (input.coupon) {
    const value = Number(input.coupon.discountValue);
    discount = input.coupon.discountType === 'percent'
      ? Math.round(subtotal * (value / 100))
      : Math.round(value * 100);
  }
  return applyFees({
    subtotalPaise: subtotal,
    discountPaise: discount,
    category: input.category,
    nightlyHintPaise: input.nightlyHintPaise,
  });
}

// ─── Per-category subtotal helpers ────────────────────────────────────────────
//
// Each helper returns a host-portion subtotal in paise from the smallest
// possible set of inputs the caller has on hand. They're separate from
// applyFeesAndCoupon so the per-category data extraction stays explicit at
// the call site.

/** Stays: sum of nightly paise across the date range. Caller resolves any
 *  per-night overrides ahead of time and passes the final array. */
export function subtotalForStayPaise(input: {
  nightlyPaiseList: number[];
  /** Optional 0–100 host discount applied across all nights (mirrors the
   *  effectiveNightlyPrice math the frontend does on the listing card). */
  hostDiscountPercent?: number | null;
}): number {
  if (!input.nightlyPaiseList.length) return 0;
  const discountPct = Math.max(0, Math.min(90, Number(input.hostDiscountPercent ?? 0)));
  const factor = 1 - discountPct / 100;
  let total = 0;
  for (const n of input.nightlyPaiseList) {
    total += Math.max(0, Math.round((Number(n) || 0) * factor));
  }
  return total;
}

/**
 * Resolved per-night price list for a stay date range — applies the room
 * override > listing override > base nightly hierarchy. Mirrors the math
 * `computeHoldSubtotalPaise` in bookings.service.ts uses, factored out so
 * the assistant's pricing preview can produce a list that's byte-identical
 * to what the hold will compute. The hold is the source of truth; this is
 * how everyone else stays consistent with it.
 *
 * Callers pass an `overrideRows` array (the raw rows from
 * availabilityOverridesRepository.listForListing) and the function picks
 * the right override per night per scope. Pass empty array when overrides
 * aren't reachable — every night gets the base.
 */
export function resolveNightlyStayPaiseList(input: {
  nights: string[];                            // ['2026-05-21', '2026-05-22']
  nightlyBasePaise: number;                    // resolved per-night (room or listing)
  roomTypeId?: string | null;
  overrideRows?: Array<{ date: string; price_paise: number | null; room_type_id: string | null }>;
}): number[] {
  if (!input.nights.length || input.nightlyBasePaise <= 0) return [];
  const byDate = new Map<string, { listing: number | null; room: number | null }>();
  for (const o of input.overrideRows ?? []) {
    const date = typeof o.date === 'string' ? o.date.slice(0, 10) : String(o.date);
    if (!byDate.has(date)) byDate.set(date, { listing: null, room: null });
    const cell = byDate.get(date)!;
    if (input.roomTypeId && o.room_type_id === input.roomTypeId) {
      cell.room = o.price_paise == null ? null : Number(o.price_paise);
    } else if (o.room_type_id === null) {
      cell.listing = o.price_paise == null ? null : Number(o.price_paise);
    }
  }
  const out: number[] = [];
  for (const date of input.nights) {
    const cell = byDate.get(date);
    // Room override beats listing override; null means "no override".
    const override = cell?.room ?? cell?.listing ?? null;
    out.push(override != null ? override : input.nightlyBasePaise);
  }
  return out;
}

/** Services: a single line at the listing's price (rupees). Keeps the door
 *  open for hourly multipliers later (`durationHours`).
 *
 *  Add-ons (`addOnsRupees`) stack additively onto the base. They are NOT
 *  multiplied by `durationHours` — a customer who picks a 2-hour cleaning
 *  with a one-off "+₹100 extra-bathroom" extra should pay
 *  `price × 2 + 100`, not `(price + 100) × 2`. Caller resolves the add-on
 *  prices from `listing.metadata.addOns` server-side; never trust a
 *  client-supplied amount. */
export function subtotalForServicePaise(input: {
  priceRupees: number | string | null | undefined;
  durationHours?: number | null;
  addOnsRupees?: number | null;
}): number {
  const price = typeof input.priceRupees === 'string' ? Number(input.priceRupees) : Number(input.priceRupees ?? 0);
  if (!Number.isFinite(price) || price <= 0) return 0;
  const hours = Number.isFinite(input.durationHours ?? NaN) && (input.durationHours as number) > 0
    ? (input.durationHours as number)
    : 1;
  const addOns = Number(input.addOnsRupees ?? 0);
  const addOnsPaise = Number.isFinite(addOns) && addOns > 0 ? Math.round(addOns * 100) : 0;
  return Math.round(price * hours * 100) + addOnsPaise;
}

/**
 * Resolve customer-selected add-on ids against a listing's authoritative
 * `metadata.addOns` array. Returns the canonical snapshot (id + label +
 * server-side price in rupees) AND the rupee sum. This is the ONLY way
 * the booking flow learns add-on prices — never trust the client's
 * `price` field, which it sent only to render an optimistic breakdown.
 *
 * Throws ValidationError when an id is unknown (stale modal cache → the
 * customer must reload and reselect, rather than book at a phantom price).
 */
export function resolveServiceAddOns(input: {
  listingAddOns: unknown;
  selectedIds: ReadonlyArray<string> | null | undefined;
  /** The listing's raw `metadata.servicesCatalog`. When provided, a selected id
   *  that ISN'T one of `listingAddOns` is also matched against the listing's
   *  sibling SERVICE VARIANTS and priced at that variant's `basePrice`. This is
   *  how one appointment books multiple distinct catalog services (a haircut +
   *  a beard trim + a hair wash) when the host modelled each as its own service
   *  rather than as an add-on of the haircut. Shaped like an add-on
   *  (id/label/price) so it sums + renders identically downstream. Omit to keep
   *  the legacy add-ons-only behaviour. */
  catalogVariants?: unknown;
  /** The primary variant chosen as the booking's base (its `serviceCatalogId`).
   *  Excluded from sibling matching and skipped if echoed into `selectedIds`,
   *  so the base service is never double-charged as one of its own "add-ons". */
  baseVariantId?: string | null;
}): { items: Array<{ id: string; label: string; price: number }>; sumRupees: number } {
  const ids = Array.isArray(input.selectedIds) ? input.selectedIds.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
  if (ids.length === 0) return { items: [], sumRupees: 0 };

  const catalog: Array<{ id: string; label: string; price: number }> = [];
  if (Array.isArray(input.listingAddOns)) {
    for (const raw of input.listingAddOns) {
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as Record<string, unknown>;
      const id = typeof obj.id === 'string' ? obj.id : null;
      const label = typeof obj.label === 'string' ? obj.label : null;
      const price = Number(obj.price ?? 0);
      if (!id || !label || !Number.isFinite(price) || price < 0) continue;
      catalog.push({ id, label, price });
    }
  }

  // Sibling service variants → priceable line items (label = variant name,
  // price = basePrice). The chosen base variant is excluded; it's priced
  // separately as the booking's base, not as an extra.
  const variants: Array<{ id: string; label: string; price: number }> = [];
  if (Array.isArray(input.catalogVariants)) {
    for (const raw of input.catalogVariants) {
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as Record<string, unknown>;
      const id = typeof obj.id === 'string' ? obj.id : null;
      const label = typeof obj.name === 'string' ? obj.name : null;
      const price = Number(obj.basePrice ?? 0);
      if (!id || !label || !Number.isFinite(price) || price <= 0) continue;
      if (input.baseVariantId && id === input.baseVariantId) continue;
      variants.push({ id, label, price });
    }
  }

  const items: Array<{ id: string; label: string; price: number }> = [];
  let sumRupees = 0;
  // Preserve user's selection order (matches the order they ticked the
  // checkboxes) so the invoice line-items render predictably.
  const seen = new Set<string>();
  // Tolerant matching (mirrors resolveServiceCatalogGroup / matchRoomType): the
  // assistant passes a label or slug ("beard trim", "wash") instead of the real
  // id ("addon-mpnhwv8g-0" / "svc-mpnhouso-3"). Match by exact id first, then by
  // normalised label — otherwise a valid pick was rejected as "no longer offered".
  const norm = (s: unknown) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const matchIn = (pool: Array<{ id: string; label: string; price: number }>, id: string, want: string) =>
    pool.find((c) => c.id === id)
      ?? (want
        ? pool.find((c) => {
            const n = norm(c.label);
            return n.length > 0 && (n === want || n.includes(want) || want.includes(n));
          })
        : undefined);
  for (const id of ids) {
    // The model sometimes echoes the base variant into the add-on list — it's
    // already priced as the booking's base, so drop it rather than double-add.
    if (input.baseVariantId && id === input.baseVariantId) continue;
    const want = norm(id);
    // Add-ons win ties over sibling services, so a listing carrying both an
    // add-on and a variant of the same name keeps its prior (cheaper) semantics.
    const hit = matchIn(catalog, id, want) ?? matchIn(variants, id, want);
    if (!hit) {
      throw new Error('One of the selected add-ons or services is no longer offered by this listing. Reload and pick again.');
    }
    // Dedup on the RESOLVED id so "beard trim" + "addon-…-0" can't double-add.
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    items.push(hit);
    sumRupees += hit.price;
  }
  return { items, sumRupees };
}

/**
 * Resolve the selected service-catalog VARIANT (e.g. Men's / Women's / Kid's
 * haircut) from a listing's `metadata.servicesCatalog`. Returns the matched
 * variant with a validated basePrice (rupees) + its OWN add-ons, or null when
 * the listing has no catalog (legacy/single-price rows) — callers then fall
 * back to the flat `listing.price` + listing-level `metadata.addOns`.
 *
 * Single source of truth shared by the hold path (createHold's
 * computeHoldSubtotalPaise) AND the assistant's get_booking_price_preview, so
 * the previewed price and the actual charge resolve the SAME variant.
 *
 * Tolerant id matching (mirrors matchRoomType): the assistant routinely passes
 * a slug or display name ("mens-haircut", "Men's Haircut") or even an invented
 * UUID instead of the real serviceCatalog id ("svc-mpnhouso-0"). We match by
 * exact id, then by normalised name, then — for a single-variant listing — the
 * sole entry. Returns null when a selectedId was given but matched NOTHING on a
 * MULTI-variant listing (caller must then ask which one — never silently fall
 * back to listing.price, which charged the cheapest variant for any request).
 * When no id is supplied at all, returns the FIRST variant (legacy default; the
 * assistant path guards against this so it only bites single-variant/modal).
 */
export function resolveServiceCatalogGroup(
  metadata: Record<string, unknown> | null | undefined,
  selectedId: string | null | undefined,
): { id: string; name: string; basePrice: number; addOns: Array<{ id: string; label: string; price: number }> } | null {
  const catalog = metadata && Array.isArray((metadata as Record<string, unknown>).servicesCatalog)
    ? ((metadata as Record<string, unknown>).servicesCatalog as unknown[])
    : [];
  if (catalog.length === 0) return null;
  const norm = (s: unknown) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  let match: Record<string, unknown> | undefined;
  if (selectedId) {
    const want = norm(selectedId);
    match = catalog.find((g) => g && typeof g === 'object' && (g as Record<string, unknown>).id === selectedId) as Record<string, unknown> | undefined;
    if (!match && want) {
      match = catalog.find((g) => {
        const n = norm((g as Record<string, unknown>)?.name ?? '');
        return n.length > 0 && (n === want || n.includes(want) || want.includes(n));
      }) as Record<string, unknown> | undefined;
    }
    // Unmatched on a multi-variant listing → null (caller asks which one).
    // Single-variant listing has nothing to disambiguate → use the sole entry.
    if (!match) match = catalog.length === 1 ? (catalog[0] as Record<string, unknown>) : undefined;
  } else {
    match = catalog[0] as Record<string, unknown> | undefined;
  }
  if (!match || typeof match !== 'object') return null;
  const basePrice = Number(match.basePrice);
  if (!Number.isFinite(basePrice) || basePrice <= 0) return null;
  return {
    id: typeof match.id === 'string' ? match.id : '',
    name: typeof match.name === 'string' ? match.name : '',
    basePrice,
    addOns: Array.isArray(match.addOns) ? (match.addOns as Array<{ id: string; label: string; price: number }>) : [],
  };
}

/** Transport prebook: per-km × distance (rupees → paise). */
export function subtotalForTransportPrebookPaise(input: {
  perKmRupees: number | string | null | undefined;
  estimatedKm: number | null | undefined;
}): number {
  const perKm = Number(input.perKmRupees ?? 0);
  const km = Number(input.estimatedKm ?? 0);
  const sub = (Number.isFinite(perKm) ? perKm : 0) * (Number.isFinite(km) ? km : 0);
  return Math.max(0, Math.round(sub * 100));
}

/** Transport quote: provider-quoted price in paise. */
export function subtotalForTransportQuotePaise(input: {
  providerQuotePaise: number | string | null | undefined;
}): number {
  const v = Number(input.providerQuotePaise ?? 0);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/** Transport hourly rental: `pricePerHour × durationHours` (rupees → paise).
 *
 *  Returns 0 when either input is missing/invalid — the caller
 *  (`computeHoldSubtotalPaise`) is responsible for upgrading 0 into a
 *  ValidationError so a misconfigured listing can't produce a "free" booking.
 */
export function subtotalForTransportHourlyPaise(input: {
  pricePerHourRupees: number | string | null | undefined;
  durationHours: number | null | undefined;
}): number {
  const rate = Number(input.pricePerHourRupees ?? 0);
  const hours = Number(input.durationHours ?? 0);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return Math.max(0, Math.round(rate * hours * 100));
}

/** Transport day rental: `pricePerDay × days` (rupees → paise).
 *
 *  Phase 6A callers pass `days = 1` (matches current frontend UX); the multi-
 *  day path is wired here so a Phase 6B+ change is a single-line update at
 *  the call site. Returns 0 when either input is missing/invalid.
 */
export function subtotalForTransportDayPaise(input: {
  pricePerDayRupees: number | string | null | undefined;
  days: number | null | undefined;
}): number {
  const rate = Number(input.pricePerDayRupees ?? 0);
  const days = Number(input.days ?? 0);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.max(0, Math.round(rate * days * 100));
}

/** Transport tour package: lookup by id against the listing's
 *  `metadata.packageOptions[]`, return the matched entry's `price` in paise.
 *
 *  Case-sensitive id match, plus a positional fallback: rows saved WITHOUT an
 *  id (AI-onboarded listings' packageOptions carry no id field) are addressable
 *  by the canonical synthesized id "pkg-<index>" — the exact id every reader
 *  (get_listing_details, matchPackageId, the web/mobile adapters) hands out
 *  for them. A row that has its own real id is never positionally re-mapped.
 *
 *  Returns 0 when the options array is empty, missing, or no entry matches —
 *  the caller upgrades 0 into a ValidationError so a stale frontend cache
 *  can't silently book at ₹0.
 */
export function subtotalForTransportPackagePaise(input: {
  packageOptions: unknown;
  packageId: string | null | undefined;
}): number {
  if (!Array.isArray(input.packageOptions)) return 0;
  if (typeof input.packageId !== 'string' || !input.packageId.trim()) return 0;
  const targetId = input.packageId;
  let match: Record<string, unknown> | undefined;
  for (const raw of input.packageOptions) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (entry.id !== targetId) continue;
    match = entry;
    break;
  }
  if (!match) {
    const positional = /^pkg-(\d+)$/.exec(targetId);
    const raw = positional ? input.packageOptions[Number(positional[1])] : undefined;
    if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).id !== 'string') {
      match = raw as Record<string, unknown>;
    }
  }
  if (!match) return 0;
  const price = Number(match.price ?? 0);
  if (!Number.isFinite(price) || price <= 0) return 0;
  return Math.max(0, Math.round(price * 100));
}
