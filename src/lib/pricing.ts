/**
 * Frontend pricing PREVIEW constants — kept in lockstep with the backend's
 * `applyFees` (server/src/modules/payments/pricing/booking-price.ts) so the
 * preview shown on the booking modal closely matches what the server will
 * actually charge.
 *
 * Source of truth is the backend, not this file. The server recomputes the
 * full breakdown (subtotal, platform fee, GST, coupon, total) on every
 * createHold + createOrder, persists it to the payments row, and validates
 * any client-supplied claim against it. Anything we render here is a
 * preview only — a small rounding drift is expected; the success screen
 * and the invoice always display the server-returned amount.
 */

/**
 * Platform fee — a FLAT per-booking charge (was 10% of subtotal). Mirrors
 * the backend's PLATFORM_FEE_RUPEES / PLATFORM_FEE_PAISE in
 * server/src/modules/payments/pricing/fees.ts.
 */
export const PLATFORM_FEE_RUPEES = 3;

/**
 * Admin fee-rules: the server resolves WHICH rule prices a listing
 * (listing > city > tier > state > global) and the client fetches the
 * resolved spec once per listing from GET /api/listings/:id/fee-quote.
 * This mirror of the server's computePlatformFeePaise (fees.ts) applies
 * the spec locally so the preview updates with the subtotal without a
 * round-trip per keystroke:
 *
 *   fee = clamp(round(discountedSubtotal × percentBps / 10000) + fixedPaise,
 *               minFeePaise, maxFeePaise)
 *
 * When the fetch fails (offline, old server) callers fall back to
 * LEGACY_PLATFORM_FEE_SPEC — the same fallback the server itself uses when
 * rule resolution fails, so both sides degrade to the same number.
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

/** Rupee convenience over computePlatformFeePaise for modals that do their
 *  breakdown math in rupees. */
export function platformFeeRupees(
  discountedSubtotalRupees: number,
  spec: PlatformFeeSpec | null | undefined,
): number {
  return (
    computePlatformFeePaise(
      Math.round((discountedSubtotalRupees || 0) * 100),
      spec ?? LEGACY_PLATFORM_FEE_SPEC,
    ) / 100
  );
}

/**
 * Trip-protection / insurance premium. Mirrors the backend's
 * `insurancePremiumRupees` (server/src/modules/payments/pricing/fees.ts).
 * Now a flat ₹2 — the percentage-of-price path was creating preview-vs-
 * charged drift because the backend's ₹2 floor was always winning on
 * small-ticket services while the frontend was previewing a different
 * percentage of base. Going flat keeps the modal, invoice, order, and
 * Razorpay numbers identical.
 */
export const INSURANCE_FLAT_RUPEES = 2;
export const INSURANCE_RATE = 0;
export const INSURANCE_MIN_RUPEES = INSURANCE_FLAT_RUPEES;
export const INSURANCE_MAX_RUPEES = INSURANCE_FLAT_RUPEES;

// Argument kept for API stability — call sites pass the agreed price; we
// ignore it. The ₹2 fee is the same regardless of cart size.
export function insurancePremiumRupees(_agreedRupees: number): number {
  return INSURANCE_FLAT_RUPEES;
}

/**
 * GST rate per booking category. Mirrors gstRateFor() on the server. Stays
 * default to 12% but jump to 18% when the nightly rate is above ₹7,500;
 * transport is 5% (passenger HSN 9964); everything else falls back to 18%.
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

export interface FrontendFeeBreakdown {
  /** Host's portion in rupees, paise-exact (2 decimals). */
  subtotal: number;
  /** Platform fee in rupees — from the resolved fee spec when one is
   *  passed, else the legacy flat PLATFORM_FEE_RUPEES. */
  platformFee: number;
  /** GST in rupees, computed from (subtotal + platformFee) × gstRate. */
  taxes: number;
  /** Optional rupee discount applied to subtotal (host coupon). */
  discount: number;
  /** Insurance premium passthrough (rupees). */
  insurance: number;
  /** Net amount the customer pays. */
  total: number;
  /** GST rate used (0.05 / 0.12 / 0.18). */
  gstRate: number;
}

/**
 * Compute the customer-facing breakdown from a host subtotal in rupees +
 * optional flags. Math:
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
  /** Server-resolved fee spec (use-fee-spec hook). Omitted → legacy flat fee. */
  feeSpec?: PlatformFeeSpec | null;
}): FrontendFeeBreakdown {
  // Paise-exact mirror of the server, which computes in integer paise and
  // rounds GST to the nearest PAISA (not rupee). Rounding to whole rupees
  // here made the preview drift from the charge (₹108 shown, ₹108.15 paid).
  const to2 = (n: number) => Math.round(n * 100) / 100;
  const subtotal = Math.max(0, to2(params.subtotal || 0));
  const discount = Math.max(0, to2(params.discount || 0));
  const insurance = Math.max(0, to2(params.insurance || 0));
  const discountedSubtotal = Math.max(0, to2(subtotal - discount));

  const gstRate = gstRateFor(params.category ?? null, params.nightlyPaise ?? null);
  const platformFee = platformFeeRupees(discountedSubtotal, params.feeSpec);
  const taxes = to2((discountedSubtotal + platformFee) * gstRate);
  const total = to2(discountedSubtotal + platformFee + taxes + insurance);

  return {
    subtotal: discountedSubtotal,
    platformFee,
    taxes,
    discount,
    insurance,
    total,
    gstRate,
  };
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
