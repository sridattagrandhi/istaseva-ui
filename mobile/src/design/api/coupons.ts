// design/api/coupons.ts — server-authoritative coupon validation.
// The booking write path sends `couponCode` and the server recomputes the
// discount transactionally; this preview call returns the SAME server math so
// the Review-screen breakdown matches the charge.
import { api } from "@/lib/api";

export interface CouponQuote {
  code: string;
  /** Rupees off the subtotal (server-computed). */
  discountAmount: number;
  /** Subtotal after discount, rupees (floored at ₹1 by the server). */
  discountedPrice: number;
}

/**
 * Validate a coupon against a real listing + base price. Throws with a
 * user-safe message when the code is invalid/expired/not-applicable.
 * Requires auth + a real listing UUID (mock/slug ids have no backend coupon).
 */
export async function validateCoupon(params: {
  code: string;
  listingId: string;
  basePrice: number;
}): Promise<CouponQuote> {
  const res = await api.get("/api/coupons/validate", {
    params: { code: params.code.trim(), listingId: params.listingId, basePrice: params.basePrice },
  });
  const d = res.data?.data ?? res.data;
  return {
    code: d.code ?? params.code.trim().toUpperCase(),
    discountAmount: Number(d.discountAmount ?? 0),
    discountedPrice: Number(d.discountedPrice ?? params.basePrice),
  };
}
