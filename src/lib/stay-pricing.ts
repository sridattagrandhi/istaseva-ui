/**
 * Frontend stay-pricing preview math.
 *
 * Mirror of the backend's `resolveNightlyStayPaiseList` + `subtotalForStayPaise`
 * + `applyFees` (see server/src/modules/payments/pricing/booking-price.ts).
 * Doing the math in paise on the client keeps the preview total within the
 * ±₹2 drift tolerance the backend enforces in createHold.
 *
 * Two-step math, in order:
 *   1. For each night, RESOLVE the LIST paise — room/listing override beats
 *      the base nightly. Overrides are list prices, not post-discount.
 *   2. Apply the host discount factor uniformly to every night (including
 *      override nights) BEFORE summing, so per-night rounding matches the
 *      server byte-for-byte. Applying the discount only to base nights —
 *      which an earlier version of this file did — drifted the preview off
 *      the server total whenever any override was in play, which then made
 *      createHold's ±₹2 check reject the booking.
 *
 * Insurance/protection is intentionally NOT folded into the booking subtotal;
 * the server adds it at payment time (createOrder), and the preview shows it
 * only as an opt-in addon, NOT in the `agreedPrice` we POST.
 */

import {
  computePlatformFeePaise,
  LEGACY_PLATFORM_FEE_SPEC,
  type PlatformFeeSpec,
} from './pricing';

const STAY_LUXURY_GST_THRESHOLD_PAISE = 750_000; // > ₹7,500/night ⇒ 18%

export function gstRateForStay(nightlyPaise: number): number {
  return nightlyPaise > STAY_LUXURY_GST_THRESHOLD_PAISE ? 0.18 : 0.12;
}

export interface StayNightLineItem {
  date: string;
  /** Post-discount paise actually paid for this night. */
  paise: number;
  /** Pre-discount LIST paise — either the override or the base. */
  listPaise: number;
  /** True when this night used a host availability override. */
  custom: boolean;
}

export interface StayBreakdown {
  nightlyPaise: number;
  subtotalPaise: number;
  discountPaise: number;
  discountedSubtotalPaise: number;
  platformFeePaise: number;
  taxesPaise: number;
  totalPaise: number;
  gstRate: number;
  nightLineItems: StayNightLineItem[];
}

export function computeStayBreakdownPaise(input: {
  nightlyRateRupees: number;
  nights: number;
  hostDiscountPercent?: number;
  couponRupeesOff?: number;
  /** ISO checkIn (YYYY-MM-DD) — required to expand line items. When omitted
   *  the breakdown still totals correctly but `nightLineItems` is empty. */
  checkIn?: string | null;
  /** Optional per-date override price in paise (host availability override).
   *  When a date has an entry, that paise value REPLACES the base nightly
   *  for that night. The host discount factor still applies on top, matching
   *  backend `subtotalForStayPaise`. */
  nightlyPaiseByDate?: Map<string, number> | null;
  /** Number of physical rooms booked of the chosen room type. Multiplies
   *  the per-night line items + subtotal by this value before fees/GST,
   *  mirroring the backend (server multiplies `subtotalForStayPaise` by
   *  `numberOfRooms` in computeHoldSubtotalPaise). Defaults to 1. */
  roomCount?: number;
  /** Server-resolved fee spec (use-fee-spec hook). Omitted → legacy flat fee. */
  feeSpec?: PlatformFeeSpec | null;
}): StayBreakdown {
  const nightlyPaise = Math.round(Math.max(0, input.nightlyRateRupees) * 100);
  const discountPct = Math.max(0, Math.min(90, input.hostDiscountPercent ?? 0));
  const factor = 1 - discountPct / 100;
  const overrides = input.nightlyPaiseByDate;
  const lineItems: StayNightLineItem[] = [];
  let subtotal = 0;
  const totalNights = Math.max(0, Math.round(input.nights));
  const roomCount = Math.max(1, Math.round(Number(input.roomCount) || 1));
  if (input.checkIn && totalNights > 0) {
    const cur = new Date(`${input.checkIn}T00:00:00Z`);
    for (let i = 0; i < totalNights; i += 1) {
      const iso = cur.toISOString().slice(0, 10);
      const overrideP = overrides?.get(iso);
      const listPaise = overrideP != null && overrideP >= 0 ? overrideP : nightlyPaise;
      // Per-night row reflects what the guest is being charged for that
      // night across ALL booked rooms — multiply BEFORE rounding so the
      // sum matches what the backend computes (server does
      // `subtotalForStayPaise(perRoom) * roomCount`, also pre-rounding).
      const paise = Math.max(0, Math.round(listPaise * factor)) * roomCount;
      lineItems.push({ date: iso, paise, listPaise, custom: overrideP != null });
      subtotal += paise;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  } else {
    const baseDiscountedNightly = Math.max(0, Math.round(nightlyPaise * factor)) * roomCount;
    for (let i = 0; i < totalNights; i += 1) {
      subtotal += baseDiscountedNightly;
    }
  }
  const discountPaise = Math.max(0, Math.min(subtotal, Math.round((input.couponRupeesOff ?? 0) * 100)));
  const discounted = Math.max(1, subtotal - discountPaise);
  const gstRate = gstRateForStay(nightlyPaise);
  const platformFee = computePlatformFeePaise(
    discounted,
    input.feeSpec ?? LEGACY_PLATFORM_FEE_SPEC,
  );
  const taxes = Math.round((discounted + platformFee) * gstRate);
  const total = discounted + platformFee + taxes;
  return {
    nightlyPaise,
    subtotalPaise: subtotal,
    discountPaise,
    discountedSubtotalPaise: discounted,
    platformFeePaise: platformFee,
    taxesPaise: taxes,
    totalPaise: total,
    gstRate,
    nightLineItems: lineItems,
  };
}

/**
 * Build the label for the collapsed "rate × nights" row in the price
 * breakdown. When the host runs a discount, the row needs to show the
 * effective (charged) per-night rate — otherwise the label reads ₹X but the
 * row amount is computed at ₹X × (1 − discount), and a reader can't reconcile
 * them. We tack on a concise "· P% off (was ₹Y)" suffix in the same comma-
 * separated style used by custom-night rows, so the visual stays familiar.
 *
 * Returns just the row label; the row's `amount` should come from the
 * canonical pricing helper (computeStayBreakdownPaise) and is NOT touched
 * here — this is a display-only concern.
 */
export function formatNightlyRowLabel(input: {
  baseNightlyRupees: number;
  nights: number;
  hostDiscountPercent?: number | null;
  /** Render-rupees formatter — pass the same `rupee()` the modal uses so the
   *  digit grouping/symbol matches the rest of the breakdown. */
  formatRupees: (n: number) => string;
}): string {
  const base = Math.max(0, Math.round(input.baseNightlyRupees));
  const nights = Math.max(0, Math.round(input.nights));
  const pct = Math.max(0, Math.min(90, Math.round(input.hostDiscountPercent ?? 0)));
  const nightWord = nights === 1 ? 'night' : 'nights';
  if (pct <= 0 || base <= 0) {
    return `${input.formatRupees(base)} × ${nights} ${nightWord}`;
  }
  // Match the same per-night rounding `computeStayBreakdownPaise` uses on
  // base nights (paise-precise, then divided down for display) so the label
  // can't disagree with the row amount by ₹1 due to integer rounding.
  const effectivePaise = Math.max(0, Math.round(base * 100 * (1 - pct / 100)));
  const effective = Math.round(effectivePaise / 100);
  return `${input.formatRupees(effective)} × ${nights} ${nightWord} · ${pct}% off (was ${input.formatRupees(base)})`;
}

/**
 * Fold the raw availability rows into a per-date paise map, mirroring the
 * precedence rules backend `check_availability` and `resolveNightlyStayPaiseList`
 * enforce:
 *
 *   - Listing-level (room_type_id IS NULL) blocks are GLOBAL: every room is
 *     unavailable on that date. A room-specific price/non-block row does NOT
 *     unblock it — the host took the whole property offline.
 *   - Listing-level price overrides apply when no room override exists.
 *   - Room-specific blocks add an additional block (only matters when the
 *     listing-level row was a price override, not a block).
 *   - Room-specific price overrides shadow the listing-level price ONLY on
 *     dates that aren't listing-blocked.
 *
 * Pass `selectedRoomTypeId` when a room is chosen; pass `null` for the
 * listing-default view (which only sees listing-level rows).
 */
export function foldAvailabilityOverrides(
  rows: Array<{ roomTypeId: string | null; date: string; blocked: boolean; pricePaise: number | null }>,
  selectedRoomTypeId: string | null,
): { blockedSet: Set<string>; priceByDate: Map<string, number> } {
  const blocked = new Set<string>();
  const price = new Map<string, number>();
  // Listing-level first. Track which dates were blocked at the listing scope
  // so room-specific rows can't accidentally unblock them.
  const listingBlocked = new Set<string>();
  for (const row of rows) {
    if (row.roomTypeId != null) continue;
    if (row.blocked) {
      blocked.add(row.date);
      listingBlocked.add(row.date);
    } else if (row.pricePaise != null) {
      price.set(row.date, row.pricePaise);
    }
  }
  // Room-specific shadows the price layer; never undoes a listing-level block.
  if (selectedRoomTypeId) {
    for (const row of rows) {
      if (row.roomTypeId !== selectedRoomTypeId) continue;
      if (row.blocked) {
        // A room-specific block always adds — and clears any price override
        // that won't be reachable anyway.
        blocked.add(row.date);
        price.delete(row.date);
        continue;
      }
      if (listingBlocked.has(row.date)) {
        // The property is offline for this date; a room-level price/non-block
        // row can't make it bookable. Don't clear the block, don't set a price.
        continue;
      }
      if (row.pricePaise != null) price.set(row.date, row.pricePaise);
    }
  }
  return { blockedSet: blocked, priceByDate: price };
}
