/**
 * Wishlist domain service — wraps /api/wishlist.
 *
 * Kept intentionally tiny because the state lives in SavedContext; this file
 * is just the network edge. Callers get typed success/error results and
 * never deal with fetch directly.
 */
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { ServiceResult } from "@/types/domain";

export type WishlistType = "stay" | "service" | "transport";
export interface WishlistBuckets {
  stay: string[];
  service: string[];
  transport: string[];
}

export class WishlistService {
  async list(): Promise<ServiceResult<WishlistBuckets>> {
    const res = await apiRequest<{ success: boolean; data: WishlistBuckets }>("/api/wishlist");
    if (!res.success || !res.data?.data) return { success: false, error: res.error || "Unable to load saved items" };
    return { success: true, data: res.data.data };
  }

  async add(listingId: string, listingType: WishlistType): Promise<ServiceResult<void>> {
    const res = await apiRequest<{ success: boolean }>("/api/wishlist", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({ listingId, listingType }),
    });
    return res.success ? { success: true } : { success: false, error: res.error };
  }

  async remove(listingId: string, listingType: WishlistType): Promise<ServiceResult<void>> {
    const res = await apiRequest<{ success: boolean }>(`/api/wishlist/${listingType}/${listingId}`, {
      method: "DELETE",
      headers: getJsonHeaders(),
    });
    return res.success ? { success: true } : { success: false, error: res.error };
  }
}

let _instance: WishlistService | null = null;
export function getWishlistService(): WishlistService {
  if (!_instance) _instance = new WishlistService();
  return _instance;
}
