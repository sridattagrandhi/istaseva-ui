/**
 * Coupons domain service — host CRUD + guest-facing preview.
 *
 * Validation is always authoritative on the server; the `validate` method
 * here is a preview (the booking-hold endpoint re-runs consumption under
 * a DB transaction so there's no double-spend risk).
 */
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { ServiceResult, UUID } from "@/types/domain";

export type CouponDiscountType = "percent" | "fixed";
/** Listing-category scope. NULL = legacy host-wide coupon (pre-migration). */
export type CouponCategory = "stay" | "service" | "transport";

export interface Coupon {
  id: UUID;
  hostUserId: string;
  listingId: UUID | null;
  category: CouponCategory | null;
  code: string;
  discountType: CouponDiscountType;
  discountValue: number;
  maxUses: number | null;
  usesCount: number;
  /** Total discount given across redemptions, in paise (list endpoint only). */
  redeemedPaise?: number;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CouponQuote {
  couponId: UUID;
  code: string;
  discountType: CouponDiscountType;
  discountValue: number;
  discountAmount: number;
  discountedPrice: number;
}

export interface CreateCouponPayload {
  code: string;
  listingId?: UUID | null;
  /** Set when the dashboard's "Applies to" picker is the catch-all
   *  ("All your stays" / "All your services" / "All your transports").
   *  The server still re-derives category from the listing when listingId
   *  is given — passing it here is purely for the listing-less case. */
  category?: CouponCategory | null;
  discountType: CouponDiscountType;
  discountValue: number;
  maxUses?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
}

export class CouponsService {
  /**
   * @param category Optional scope. Pass "stay" / "service" / "transport" to
   *   show only that dashboard's own coupons. Legacy category-NULL coupons
   *   still surface in every scope so they're never orphaned. Omit for the
   *   unfiltered list (e.g. admin / debugging).
   */
  async listMine(category?: "stay" | "service" | "transport"): Promise<ServiceResult<Coupon[]>> {
    const qs = category ? `?category=${encodeURIComponent(category)}` : "";
    const res = await apiRequest<{ success: boolean; data: Coupon[] }>(`/api/coupons${qs}`, {
      headers: getJsonHeaders(false),
    });
    if (!res.success || !res.data?.data) return { success: false, error: res.error };
    return { success: true, data: res.data.data };
  }

  async create(payload: CreateCouponPayload): Promise<ServiceResult<Coupon>> {
    const res = await apiRequest<{ success: boolean; data: Coupon }>("/api/coupons", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.success || !res.data?.data) return { success: false, error: res.error };
    return { success: true, data: res.data.data };
  }

  async remove(id: UUID): Promise<ServiceResult<Coupon>> {
    const res = await apiRequest<{ success: boolean; data: Coupon }>(`/api/coupons/${id}`, {
      method: "DELETE",
      headers: getJsonHeaders(false),
    });
    if (!res.success || !res.data?.data) return { success: false, error: res.error };
    return { success: true, data: res.data.data };
  }

  async setActive(id: UUID, isActive: boolean): Promise<ServiceResult<Coupon>> {
    const res = await apiRequest<{ success: boolean; data: Coupon }>(`/api/coupons/${id}`, {
      method: "PATCH",
      headers: getJsonHeaders(),
      body: JSON.stringify({ isActive }),
    });
    if (!res.success || !res.data?.data) return { success: false, error: res.error };
    return { success: true, data: res.data.data };
  }

  async validate(params: { code: string; listingId: UUID; basePrice: number }): Promise<ServiceResult<CouponQuote>> {
    const qs = new URLSearchParams({
      code: params.code,
      listingId: params.listingId,
      basePrice: String(params.basePrice),
    }).toString();
    const res = await apiRequest<{ success: boolean; data: CouponQuote }>(`/api/coupons/validate?${qs}`, {
      headers: getJsonHeaders(false),
    });
    if (!res.success || !res.data?.data) return { success: false, error: res.error };
    return { success: true, data: res.data.data };
  }
}

let _instance: CouponsService | null = null;
export function getCouponsService(): CouponsService {
  if (!_instance) _instance = new CouponsService();
  return _instance;
}
