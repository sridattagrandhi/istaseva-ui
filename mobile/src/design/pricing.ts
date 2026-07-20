/**
 * Mobile pricing PREVIEW mirror — kept in lockstep with the backend's
 * `applyFees` (server/src/modules/payments/pricing/booking-price.ts) and the
 * web mirror (src/lib/pricing.ts) so the breakdown shown on the booking
 * Review screen matches what the server will actually charge.
 *
 * Source of truth is the BACKEND, not this file. The server recomputes the
 * full breakdown on every createHold + createOrder, persists it, and validates
 * any client-supplied claim against it. What we render here is a preview only.
 *
 * PARITY RULE: pass the SAME `category` string here that the booking write
 * path sends to the server as `serviceCategory`, so the GST rate the guest
 * previews equals the GST rate the server charges. BookingScreen derives one
 * `bookingCategory` and uses it for both.
 *
 * If you change a constant/formula here, change it in server fees.ts AND
 * src/lib/pricing.ts in the same PR (root CLAUDE.md "pricing parity" invariant).
 */

/** Flat per-booking platform fee. Mirrors PLATFORM_FEE_RUPEES on the server.
 *  Used as the FALLBACK when the server-resolved fee spec isn't available. */
export const PLATFORM_FEE_RUPEES = 3;

/**
 * Admin fee-rules: the server resolves WHICH rule prices a listing
 * (listing > city > tier > state > global); clients fetch the resolved spec
 * from GET /api/listings/:id/fee-quote and apply it locally with this
 * mirror of the server's computePlatformFeePaise (fees.ts):
 *
 *   fee = clamp(round(discountedSubtotal × percentBps / 10000) + fixedPaise,
 *               minFeePaise, maxFeePaise)
 *
 * Mirrors src/lib/pricing.ts on web — change all three together.
 */
export interface PlatformFeeSpec {
  percentBps: number;
  fixedPaise: number;
  minFeePaise?: number | null;
  maxFeePaise?: number | null;
  ruleId?: string | null;
}

export const LEGACY_PLATFORM_FEE_SPEC: PlatformFeeSpec = {
  percentBps: 0,
  fixedPaise: PLATFORM_FEE_RUPEES * 100,
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
 * Flat trip-protection / insurance premium. Mirrors `insurancePremiumRupees`
 * on the server — a flat ₹2 added AFTER tax, never taxed, never a percentage.
 */
export const INSURANCE_FLAT_RUPEES = 2;

/** Argument kept for API stability; the ₹2 fee is flat regardless of cart size. */
export function insurancePremiumRupees(_agreedRupees: number): number {
  return INSURANCE_FLAT_RUPEES;
}

/**
 * GST rate per booking category. Mirrors gstRateFor() on the server. Stays
 * default to 12% but jump to 18% above ₹7,500/night; transport is 5%
 * (passenger HSN 9964); everything else falls back to 18%.
 */
export function gstRateFor(category: string | undefined | null, nightlyPaise?: number | null): number {
  const cat = String(category || "").toLowerCase();
  const isTransport = /^(auto|cab|van|bike|tempo|driver-)/.test(cat) || cat === "driver-quote";
  if (isTransport) return 0.05;

  const isStay = /(hotel|homestay|lodge|stay|farm|heritage|sathram)/.test(cat);
  if (isStay) {
    if (nightlyPaise != null && nightlyPaise > 750_000) return 0.18;
    return 0.12;
  }
  return 0.18;
}

export interface FeeBreakdown {
  /** Host's portion in rupees, after any coupon discount. */
  subtotal: number;
  /** Platform fee in rupees — flat PLATFORM_FEE_RUPEES. */
  platformFee: number;
  /** GST in rupees = round((discountedSubtotal + platformFee) × gstRate). */
  taxes: number;
  /** Rupee coupon discount applied to subtotal (0 when none). */
  discount: number;
  /** Insurance premium passthrough (rupees), added after tax. */
  insurance: number;
  /** Net amount the customer pays. */
  total: number;
  /** GST rate used (0.05 / 0.12 / 0.18). */
  gstRate: number;
}

/**
 * Compute the customer-facing breakdown from a host subtotal in rupees:
 *
 *   discountedSubtotal = max(0, subtotal − discount)
 *   platformFee        = flat PLATFORM_FEE_RUPEES
 *   taxes              = round((discountedSubtotal + platformFee) × gstRate)
 *   total              = discountedSubtotal + platformFee + taxes + insurance
 *
 * Discount applies to subtotal only — not to platform fee, GST, or insurance —
 * matching how the backend resolves coupon discounts at order time.
 */
export function computeBookingFees(params: {
  subtotal: number;
  category?: string | null;
  nightlyPaise?: number | null;
  discount?: number;
  insurance?: number;
  /** Server-resolved fee spec (useFeeSpec hook). Omitted → legacy flat fee. */
  feeSpec?: PlatformFeeSpec | null;
}): FeeBreakdown {
  // Paise-exact mirror of the server, which computes in integer paise and
  // rounds GST to the nearest PAISA (not rupee). Rounding to whole rupees
  // here made the preview drift from the charge (₹108 shown, ₹108.15 paid).
  const to2 = (n: number) => Math.round(n * 100) / 100;
  const subtotal = Math.max(0, to2(params.subtotal || 0));
  const discount = Math.max(0, to2(params.discount || 0));
  const insurance = Math.max(0, to2(params.insurance || 0));
  const discountedSubtotal = Math.max(0, to2(subtotal - discount));

  const gstRate = gstRateFor(params.category ?? null, params.nightlyPaise ?? null);
  const platformFee = computePlatformFeePaise(
    Math.round(discountedSubtotal * 100),
    params.feeSpec ?? LEGACY_PLATFORM_FEE_SPEC,
  ) / 100;
  const taxes = to2((discountedSubtotal + platformFee) * gstRate);
  const total = to2(discountedSubtotal + platformFee + taxes + insurance);

  return { subtotal: discountedSubtotal, platformFee, taxes, discount, insurance, total, gstRate };
}

/** Customer-facing INR formatter — mirrors the server's formatINR. */
export function formatINR(rupees: number | null | undefined): string {
  const n = Number(rupees);
  if (!Number.isFinite(n)) return "₹0";
  const negative = n < 0;
  const abs = Math.abs(n);
  const hasPaise = Math.round(abs * 100) % 100 !== 0;
  const formatted = abs.toLocaleString("en-IN", {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `${negative ? "-" : ""}₹${formatted}`;
}
