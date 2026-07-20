// design/api/wishlist.ts — saved listings (read + add/remove). UUID listings only.
import { api } from "@/lib/api";

export type WishType = "stay" | "service" | "transport";

export type WishlistBuckets = { stay: string[]; service: string[]; transport: string[] };

const coerceIds = (arr: unknown): string[] =>
  (Array.isArray(arr) ? arr : [])
    .map((x: any) => (typeof x === "string" ? x : x?.listing_id || x?.listingId || x?.id))
    .filter(Boolean);

/** GET /api/wishlist → the typed buckets the server keeps. The Wishlist tab
 *  needs the TYPE per id to fetch each listing directly (`fetchListing(id,
 *  kind)`) — the flat Set below is fine for hearts but discards it. */
export async function fetchWishlistBuckets(): Promise<WishlistBuckets> {
  const res = await api.get("/api/wishlist");
  const d = res.data?.data ?? res.data ?? {};
  return { stay: coerceIds(d.stay), service: coerceIds(d.service), transport: coerceIds(d.transport) };
}

/** GET /api/wishlist → { data: { stay:[ids], service:[ids], transport:[ids] } } → flat Set. */
export async function fetchWishlistIds(): Promise<Set<string>> {
  const b = await fetchWishlistBuckets();
  return new Set([...b.stay, ...b.service, ...b.transport]);
}

export async function addWishlist(listingId: string, listingType: WishType) {
  await api.post("/api/wishlist", { listingId, listingType });
}
export async function removeWishlist(listingId: string, listingType: WishType) {
  await api.delete(`/api/wishlist/${listingType}/${listingId}`);
}
