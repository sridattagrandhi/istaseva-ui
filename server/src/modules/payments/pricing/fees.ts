/**
 * Centralized fee math.
 *
 * Why server-side: the breakdown the customer sees on the invoice + the
 * amount we'd refund on cancellation must come from the same source of
 * truth. Computing it on the frontend means a different version of the
 * UI can disagree with the database; computing it on the server when the
 * payment row is inserted locks it in.
 *
 * Tax rate by category mirrors classifyGst() in
 * server/src/modules/bookings/services/pricing-breakdown.ts so a customer
 * paying ₹X sees the same GST rate on the booking page and on the invoice.
 */

/**
 * Platform fee. A FLAT per-booking charge (was 10% of the discounted
 * subtotal) — applied once regardless of nights/days/category. The flat
 * value must stay in sync with the client mirrors in src/lib/pricing.ts
 * and src/lib/stay-pricing.ts.
 */
export const PLATFORM_FEE_RUPEES = 3;
export const PLATFORM_FEE_PAISE = PLATFORM_FEE_RUPEES * 100;

/**
 * A resolved platform-fee shape from the admin fee_rules table:
 *   fee = clamp(round(discountedSubtotal × percentBps / 10000) + fixedPaise,
 *               minFeePaise, maxFeePaise)
 * The legacy flat fee is just { percentBps: 0, fixedPaise: 300 }. Resolution
 * (which rule wins) lives in fee-rules.service.ts; this file only owns the
 * math so applyFees stays pure and testable.
 */
export interface PlatformFeeSpec {
  percentBps: number;
  fixedPaise: number;
  minFeePaise?: number | null;
  maxFeePaise?: number | null;
  /** fee_rules.id that produced this spec; null for the legacy fallback. */
  ruleId?: string | null;
}

/** Fallback spec — identical to the pre-panel flat ₹3 fee. Used whenever
 *  rule resolution is unavailable (DB error, no listing context) so a fee
 *  panel outage can never block bookings. */
export const LEGACY_PLATFORM_FEE_SPEC: PlatformFeeSpec = {
  percentBps: 0,
  fixedPaise: PLATFORM_FEE_PAISE,
  ruleId: null,
};

export function computePlatformFeePaise(
  discountedSubtotalPaise: number,
  spec: PlatformFeeSpec,
): number {
  const subtotal = Math.max(0, Math.round(discountedSubtotalPaise || 0));
  const bps = Math.min(10000, Math.max(0, Math.round(spec.percentBps || 0)));
  const fixed = Math.max(0, Math.round(spec.fixedPaise || 0));
  let fee = Math.round((subtotal * bps) / 10000) + fixed;
  if (spec.minFeePaise != null && Number.isFinite(spec.minFeePaise)) {
    fee = Math.max(fee, Math.max(0, Math.round(spec.minFeePaise)));
  }
  if (spec.maxFeePaise != null && Number.isFinite(spec.maxFeePaise)) {
    fee = Math.min(fee, Math.max(0, Math.round(spec.maxFeePaise)));
  }
  return Math.max(0, fee);
}

/**
 * Maps a raw booking/listing category to the fee panel's vertical. Mirrors
 * the category regexes in gstRateFor below — if a category is transport for
 * GST it must be transport for fees, or the panel's "transport" rules would
 * silently miss some transport bookings.
 */
export type FeeVertical = 'stays' | 'services' | 'transport';
export function feeVerticalFor(category: string | undefined | null): FeeVertical {
  const cat = String(category || '').toLowerCase();
  if (/^(auto|cab|van|bike|tempo|driver-)/.test(cat) || cat === 'driver-quote') return 'transport';
  if (/(hotel|homestay|lodge|stay|farm|heritage|sathram)/.test(cat)) return 'stays';
  return 'services';
}

/** Trip-protection / insurance premium rate, applied to the agreed price the
 *  guest is about to pay. Clamped to a floor (so we don't sell ₹0 policies)
 *  and a ceiling (so a luxury stay's premium stays sane). MUST stay in sync
 *  between the actual order creation (paymentsService.createOrder) and any
 *  preview/quote the assistant or BookingModal shows.
 */
/**
 * Flat trip-protection premium. We used to compute this as 2% of the agreed
 * price (clamped to ₹2–₹49), but the percentage path was creating big
 * preview-vs-charged drift on small-ticket services — the ₹2 floor always
 * kicked in but the frontend's coupon-aware breakdown was previewing 7%
 * of base, which produced a different (smaller) number. Going flat means
 * the same ₹2 appears in the modal, the invoice, the order, and Razorpay.
 *
 * INSURANCE_RATE / *_MIN_RUPEES / *_MAX_RUPEES are kept exported (= flat
 * value, no range) so existing test imports and call sites stay valid.
 */
export const INSURANCE_FLAT_RUPEES = 2;
export const INSURANCE_RATE = 0;
export const INSURANCE_MIN_RUPEES = INSURANCE_FLAT_RUPEES;
export const INSURANCE_MAX_RUPEES = INSURANCE_FLAT_RUPEES;

/**
 * Trip-protection premium (in rupees). Now a flat fee regardless of the
 * agreed price. Argument retained for API stability — old callers pass
 * the agreed price; we ignore it.
 */
export function insurancePremiumRupees(_agreedRupees: number): number {
  return INSURANCE_FLAT_RUPEES;
}

/**
 * Default GST rate for a category. Stays >₹7500/night get 18% — caller
 * should pass `nightlyPaise` for stays. Transport gets 5% (passenger HSN
 * 9964). Everything else falls back to 18% support-services rate.
 */
export function gstRateFor(category: string | undefined | null, nightlyPaise?: number | null): number {
  const cat = String(category || '').toLowerCase();
  const isTransport = /^(auto|cab|van|bike|tempo|driver-)/.test(cat) || cat === 'driver-quote';
  if (isTransport) return 0.05;

  // Must cover every STAY_CATEGORIES entry (listings.service.ts) — 'sathram'
  // has no stay-substring, so listing it explicitly keeps mobile/assistant
  // bookings (raw category) on the same 12% rate as web ('stay:sathram') and
  // as the invoice's classifyGst.
  const isStay = /(hotel|homestay|lodge|stay|farm|heritage|sathram)/.test(cat);
  if (isStay) {
    if (nightlyPaise != null && nightlyPaise > 750_000) return 0.18;
    return 0.12;
  }
  return 0.18;
}

export interface FeeBreakdown {
  /** Host's portion — what the listing's nightly/service rate adds up to. */
  subtotalPaise: number;
  /** IstaSeva's commission. Always retained on guest-initiated cancellations. */
  platformFeePaise: number;
  /** GST on (subtotal + platform fee), rate per category. */
  taxesPaise: number;
  /** Insurance premium, if the guest opted in. Tracked separately so we can
   *  refund/void it under its own rule. */
  insurancePremiumPaise: number;
  /** Sum of all four above. Equals what the customer paid. */
  totalPaise: number;
  /** GST rate that was applied (0.05 / 0.12 / 0.18). */
  gstRate: number;
}

/**
 * Inverse of "subtotal × (1 + fee + tax) + insurance = total".
 *
 * We can't store the subtotal directly at order time because the only
 * authoritative number we receive from upstream (createOrder) is the
 * grand total the booking agreed on. Reverse-engineer the breakdown
 * from total and the known rates:
 *
 *   nonInsurance = total - insurance
 *   preTax       = round(nonInsurance / (1 + gst))   // = subtotal + flat fee
 *   platformFee  = flat PLATFORM_FEE_PAISE (clamped to preTax)
 *   subtotal     = preTax - platformFee
 *   taxes        = nonInsurance - subtotal - platformFee
 *
 * Tax is computed as the residual to absorb rounding error so the four
 * parts sum exactly to total. (If we computed taxes independently the
 * sum could be off by ±1 paise, which makes refund accounting messy.)
 */
export function deriveFeeBreakdown(params: {
  totalPaise: number;
  insurancePremiumPaise: number;
  category?: string | null;
  nightlyPaise?: number | null;
}): FeeBreakdown {
  const insurance = Math.max(0, Math.round(params.insurancePremiumPaise || 0));
  const total = Math.max(0, Math.round(params.totalPaise || 0));
  const nonInsurance = Math.max(0, total - insurance);

  const gstRate = gstRateFor(params.category ?? null, params.nightlyPaise ?? null);
  // Flat platform fee. Forward math taxes (subtotal + fee), so
  //   nonInsurance = (subtotal + fee) × (1 + gstRate).
  // Recover (subtotal + fee) first, then peel the flat fee off the front.
  const preTaxPaise = Math.round(nonInsurance / (1 + gstRate));
  const platformFeePaise = Math.min(PLATFORM_FEE_PAISE, Math.max(0, preTaxPaise));
  const subtotalPaise = Math.max(0, preTaxPaise - platformFeePaise);
  const taxesPaise = Math.max(0, nonInsurance - subtotalPaise - platformFeePaise);

  return {
    subtotalPaise,
    platformFeePaise,
    taxesPaise,
    insurancePremiumPaise: insurance,
    totalPaise: subtotalPaise + platformFeePaise + taxesPaise + insurance,
    gstRate,
  };
}
