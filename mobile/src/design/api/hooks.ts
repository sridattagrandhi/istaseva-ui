// design/api/hooks.ts — react-query hooks for the listings read path, with mock fallback.
// Fallback policy (dev bridge): use backend data per-segment when present; fall back to
// the bundled mock for any segment the backend has no rows for (or when offline/errored),
// so the app stays demo-rich while real data flows where it exists.
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { Stay, Service, Transport } from "../types";
import { fetchCatalog, fetchFeeSpec, fetchListing, isApiId, Catalog } from "./listings";
import { fetchWishlistBuckets } from "./wishlist";
import { LEGACY_PLATFORM_FEE_SPEC, PlatformFeeSpec } from "../pricing";
import { fetchMyListings, MyListing, fetchCoupons, fetchEarnings, EarningsData, fetchInsights, InsightsCategory, InsightsData } from "./dash";
import { fetchBookings, mapGuestBooking, mapDashBooking } from "./bookings";
import { useAuth } from "@/contexts/AuthContext";
import { DashCoupon } from "../screens/dash/dashData";
import { Booking, Review } from "../types";
import { fetchListingReviews } from "./reviews";
import { fetchNotifications } from "./notifications";

/** Dashboard role → marketplace vertical. Exported so earnings surfaces can
 *  scope the /me/earnings query to the dashboard they sit on. */
export const ROLE_TYPE: Record<string, string> = { host: "stay", provider: "service", transport: "transport" };

/**
 * Server-resolved platform-fee spec for a listing (admin fee rules:
 * listing > city > tier > state > global). Falls back to the legacy flat
 * ₹3 spec for mock ids or on any error — the same fallback the server
 * itself uses, so preview and charge degrade to the same number.
 */
export function useFeeSpec(listingId?: string | null): PlatformFeeSpec {
  const enabled = !!listingId && isApiId(String(listingId));
  const q = useQuery({
    queryKey: ["fee-spec", listingId],
    queryFn: () => fetchFeeSpec(String(listingId)),
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return q.data ?? LEGACY_PLATFORM_FEE_SPEC;
}

/** The signed-in user's own listings for the active dashboard role. */
export function useMyListings(role: string) {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ["my-listings"], queryFn: fetchMyListings, enabled: !!user, staleTime: 30_000, retry: 1 });
  const type = ROLE_TYPE[role];
  const listings: MyListing[] = (q.data || []).filter((l) => l.listingType === type);
  return { listings, loading: q.isLoading, fromBackend: !!q.data, refetch: q.refetch };
}

/** The signed-in user's own bookings (guest Bookings tab). */
export function useGuestBookings() {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ["my-bookings", "user"], queryFn: () => fetchBookings("user"), enabled: !!user, staleTime: 20_000, retry: 1 });
  return { bookings: (q.data || []).map(mapGuestBooking) as Booking[], fromBackend: !!q.data, refetch: q.refetch };
}

/** Bookings received on the signed-in user's listings (dashboard).
 *  Scoped to the ACTIVE role's listing type so a stay booking never shows in
 *  the provider/transport dashboard (and vice versa) — same per-role isolation
 *  as useMyListings. Omit `role` to get every received booking. */
export function useProviderBookings(role?: string) {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ["my-bookings", "provider"], queryFn: () => fetchBookings("provider"), enabled: !!user, staleTime: 20_000, retry: 1 });
  const type = role ? ROLE_TYPE[role] : null;
  const bookings = (q.data || []).map(mapDashBooking).filter((b) => !type || b.kind === type);
  return { bookings, fromBackend: !!q.data, refetch: q.refetch };
}

/** The signed-in user's coupons. */
export function useCoupons() {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ["my-coupons"], queryFn: fetchCoupons, enabled: !!user, staleTime: 30_000, retry: 1 });
  return { coupons: (q.data || []) as DashCoupon[], fromBackend: !!q.data, refetch: q.refetch };
}

/** The signed-in provider's earnings/ratings over a window, optionally scoped
 *  to one marketplace vertical (`type`) and/or one listing. */
export function useEarnings(params: { range?: string; from?: string; to?: string; listingId?: string; type?: string }, opts?: { enabled?: boolean }) {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ["earnings", params.range ?? null, params.from ?? null, params.to ?? null, params.listingId ?? null, params.type ?? null],
    queryFn: () => fetchEarnings(params),
    enabled: !!user && (opts?.enabled ?? true), staleTime: 60_000, retry: 1,
  });
  return { earnings: q.data as EarningsData | undefined, fromBackend: !!q.data, refetch: q.refetch };
}

/** Partner-scoped Insights (bookings, cancellations, funnel, search demand). */
export function useInsights(category: InsightsCategory, days: number) {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ["partner-insights", category, days],
    queryFn: () => fetchInsights(category, days),
    enabled: !!user, staleTime: 60_000, retry: 1,
  });
  return { insights: q.data as InsightsData | undefined, loading: q.isLoading, error: q.isError, refetch: q.refetch };
}

/** Unread in-app notification count — drives the dashboard bell badge. Shares
 *  the ["notifications"] cache; light poll cadence (30s stale). */
export function useUnreadNotifications() {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ["notifications"], queryFn: fetchNotifications, enabled: !!user, staleTime: 30_000, retry: 1 });
  const unread = (q.data || []).filter((n) => !n.read).length;
  return { unread, fromBackend: !!q.data, refetch: q.refetch };
}

/** Real guest reviews for a listing (real UUID ids only); empty for mock rows. */
export function useListingReviews(id?: string) {
  const enabled = !!id && isApiId(id);
  const q = useQuery({ queryKey: ["reviews", id], queryFn: () => fetchListingReviews(id!), enabled, staleTime: 60_000, retry: 1 });
  return { reviews: (q.data || []) as Review[], fromBackend: !!q.data };
}

/** Real reviews aggregated across the signed-in provider's listings for a role
 *  (no provider-level endpoint exists, so we fan out over /reviews/listing/:id). */
export function useProviderReviews(role: string) {
  const { user } = useAuth();
  const type = ROLE_TYPE[role];
  const listingsQ = useQuery({ queryKey: ["my-listings"], queryFn: fetchMyListings, enabled: !!user, staleTime: 30_000, retry: 1 });
  const mine = (listingsQ.data || []).filter((l) => l.listingType === type);
  const ids = mine.map((l) => l.apiId);
  const q = useQuery({
    queryKey: ["provider-reviews", role, ids.join(",")],
    queryFn: async () => {
      const groups = await Promise.all(
        mine.map(async (l) => {
          try { return (await fetchListingReviews(l.apiId)).map((r) => ({ ...r, listing: l.name })); }
          catch { return []; }
        }),
      );
      return groups.flat();
    },
    enabled: !!user && ids.length > 0,
    staleTime: 60_000,
    retry: 1,
  });
  const list = (q.data || []) as (Review & { listing: string })[];
  const count = list.length;
  const rating = count ? Math.round((list.reduce((a, r) => a + (r.rating || 0), 0) / count) * 10) / 10 : 0;
  // Signed in → real answer (even when empty: a provider with no reviews shows an
  // empty state, never mock). Only signed-out falls back to the demo path.
  return { list, rating, count, fromBackend: !!user, refetch: q.refetch };
}

/**
 * Saved listings resolved by fetching each saved ID directly. The Wishlist
 * tab previously filtered the shared catalog (GET /api/listings?limit=60) by
 * the saved-id Set, so any save outside the newest-60 feed silently vanished
 * while its heart stayed filled — the same bug the web dashboard had with
 * its limit-100 feeds. Per-ID fetches share the ["listing", id] cache with
 * useListingDetail; a stale id (deleted listing) fails its own query and is
 * dropped, so the count stays honest.
 */
export function useWishlistListings() {
  const { user } = useAuth();
  const bucketsQ = useQuery({
    queryKey: ["wishlist-buckets"],
    queryFn: fetchWishlistBuckets,
    enabled: !!user,
    staleTime: 20_000,
    retry: 1,
  });
  const b = bucketsQ.data ?? { stay: [], service: [], transport: [] };
  const entries: Array<{ id: string; kind: "stay" | "service" | "transport" }> = [
    ...b.stay.map((id) => ({ id, kind: "stay" as const })),
    ...b.service.map((id) => ({ id, kind: "service" as const })),
    ...b.transport.map((id) => ({ id, kind: "transport" as const })),
  ];
  const queries = useQueries({
    queries: entries.map((e) => ({
      queryKey: ["listing", e.id],
      queryFn: () => fetchListing(e.id, e.kind),
      staleTime: 60_000,
      retry: 1,
    })),
  });
  const stays: Stay[] = [];
  const services: Service[] = [];
  const transport: Transport[] = [];
  queries.forEach((q, i) => {
    if (!q.data) return;
    const kind = entries[i].kind;
    if (kind === "stay") stays.push(q.data as Stay);
    else if (kind === "service") services.push(q.data as Service);
    else transport.push(q.data as Transport);
  });
  return {
    stays, services, transport,
    loading: bucketsQ.isLoading || queries.some((q) => q.isLoading),
    refetch: bucketsQ.refetch,
  };
}

export function useCatalog(opts?: { serviceRange?: { start: string | null; end: string | null } | null; transportRange?: { start: string | null; end: string | null } | null }) {
  // Per-segment date-window filters (services/transport). A change refetches
  // the whole catalog; keepPreviousData holds the last lists so the grid
  // doesn't flash empty while the dated query lands.
  const serviceRange = opts?.serviceRange ?? null;
  const transportRange = opts?.transportRange ?? null;
  const q = useQuery({
    queryKey: ["catalog", serviceRange?.start ?? null, serviceRange?.end ?? null, transportRange?.start ?? null, transportRange?.end ?? null],
    queryFn: () => fetchCatalog({ serviceRange, transportRange }),
    staleTime: 60_000,
    retry: 1,
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  // Real data only — no mock fallback. Screens render loading/empty/error
  // states from these flags. (Backend must be seeded for the catalog to fill.)
  return {
    stays: d?.stays ?? [],
    services: d?.services ?? [],
    transport: d?.transport ?? [],
    loading: q.isLoading,
    error: q.isError,
    fromBackend: !!d,
  };
}

/**
 * Detail lookup: backend by id when it's a real UUID, else the bundled mock row
 * (still used by demo-only ids like tour packages → "t1"). For real ids, exposes
 * `loading` and `notFound` so screens can show proper states instead of flashing
 * a wrong mock row while the real listing loads.
 */
export function useListingDetail<T extends Stay | Service | Transport>(
  id: string,
  kind: "stay" | "service" | "transport",
  fallback: T,
): { item: T; loading: boolean; notFound: boolean } {
  const enabled = isApiId(id);
  const q = useQuery({
    queryKey: ["listing", id],
    queryFn: () => fetchListing(id, kind),
    enabled,
    staleTime: 60_000,
    retry: 1,
  });
  if (!enabled) return { item: fallback, loading: false, notFound: false };
  return { item: (q.data as T) ?? fallback, loading: q.isLoading, notFound: !q.isLoading && !q.data };
}
