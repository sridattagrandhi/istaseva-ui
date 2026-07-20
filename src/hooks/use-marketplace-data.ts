import { keepPreviousData, useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getListingService } from "@/domains";
import { apiRequest } from "@/lib/api-client";
import { bookingKindOf } from "@/lib/booking-kind";
import { getBookingService } from "@/domains/bookings/booking.service";
import { useAuth } from "@/contexts/AuthContext";
import {
  inferListingType,
  mapBookingToGuestServiceBooking,
  mapBookingToGuestStayBooking,
  mapListingRowToMarketplaceService,
  mapListingRowToMarketplaceStay,
  mapListingRowToMarketplaceTransport,
  mapListingToService,
  mapListingToStay,
  mapListingToTransport,
} from "@/lib/marketplace-adapters";

type ListingKind = "stay" | "service" | "transport";

function mapCollection(kind: ListingKind, rows: any[]) {
  // Defensive client-side filter: server filtering by type can leak rows when
  // metadata.listingType is missing (e.g. legacy listings). inferListingType
  // applies the same vehicle_name / category heuristics the rest of the app
  // uses, so we only show rows that genuinely belong in this tab.
  const filtered = rows.filter((row) => inferListingType(row) === kind);
  if (kind === "stay") return filtered.map(mapListingToStay);
  if (kind === "transport") return filtered.map(mapListingToTransport);
  return filtered.map(mapListingToService);
}

export function useMarketplaceListings(kind: ListingKind, options?: { limit?: number }) {
  const listingService = getListingService();

  const query = useQuery({
    queryKey: ["marketplace-listings", kind, options?.limit ?? null],
    retry: 2,
    // 30s — short enough that a provider who just created a listing sees it
    // on the customer-facing tab within a refresh, long enough to avoid
    // refetching on every browse-tab interaction. The previous 5-min window
    // made fresh listings appear "missing" until cache expiry.
    staleTime: 30 * 1000,
    refetchOnMount: true,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const result = await listingService.listPublic({ type: kind, limit: options?.limit });
      if (!result.success || !result.data) throw new Error(result.error || `Failed to load ${kind} listings`);
      return mapCollection(kind, result.data);
    },
  });

  return {
    ...query,
    data: query.data ?? [],
  };
}

export function useInfiniteMarketplaceListings(kind: ListingKind, options?: { pageSize?: number; availableWithinHours?: number }) {
  const listingService = getListingService();
  const pageSize = options?.pageSize ?? 24;
  const availableWithinHours = options?.availableWithinHours;

  const query = useInfiniteQuery({
    queryKey: ["marketplace-listings-infinite", kind, pageSize, availableWithinHours ?? null],
    retry: 2,
    staleTime: 5 * 60 * 1000,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const result = await listingService.listPublicPage({ type: kind, limit: pageSize, cursor: pageParam, availableWithinHours });
      if (!result.success || !result.data) throw new Error(result.error || `Failed to load ${kind} listings`);
      return result.data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const data = useMemo(() => {
    if (!query.data) return [];
    const rows = query.data.pages.flatMap((p) => p.data);
    return mapCollection(kind, rows);
  }, [query.data, kind]);

  return { ...query, data };
}

export function useMarketplaceListingDetail(id: string | undefined, fallbackKind?: ListingKind) {
  const listingService = getListingService();

  const query = useQuery({
    queryKey: ["marketplace-listing", id],
    enabled: Boolean(id),
    retry: 2,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const result = await listingService.getRawById(String(id));
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load listing");
      return result.data;
    },
  });
  const inferredKind = query.data ? inferListingType(query.data) : fallbackKind;
  const mapped = query.data
    ? inferredKind === "stay"
      ? mapListingToStay(query.data)
      : inferredKind === "transport"
        ? mapListingToTransport(query.data)
        : mapListingToService(query.data)
    : null;

  return {
    ...query,
    data: mapped,
    rawData: query.data,
    inferredKind,
  };
}

/**
 * Stay listings mapped to the redesigned `MarketplaceStay` contract (rupee
 * pricing, photo fallbacks, paise→rupees room conversion). Defensively filters
 * out rows whose listing_type is not "stay" so the explore page never shows
 * a transport or service row with stay treatment.
 */
export function useMarketplaceStays(options?: { limit?: number }) {
  const listingService = getListingService();
  const query = useQuery({
    queryKey: ["marketplace-stays", options?.limit ?? null],
    retry: 2,
    staleTime: 30 * 1000,
    refetchOnMount: true,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const result = await listingService.listPublic({ type: "stay", limit: options?.limit });
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load stays");
      return result.data
        .filter((row) => inferListingType(row) === "stay")
        .map(mapListingRowToMarketplaceStay);
    },
  });
  return { ...query, data: query.data ?? [] };
}

/**
 * Single-listing detail mapped to MarketplaceStay. Returns `data: null` when
 * the backend has no row for the id, so the caller can render a not-found
 * detail page (vs. an error toast).
 */
export function useMarketplaceStay(id: string | undefined) {
  const listingService = getListingService();
  const query = useQuery({
    queryKey: ["marketplace-stay", id],
    enabled: Boolean(id),
    retry: 2,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const result = await listingService.getRawById(String(id));
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load stay");
      return result.data;
    },
  });
  const row = query.data;
  const mapped = row && inferListingType(row) === "stay" ? mapListingRowToMarketplaceStay(row) : null;
  return { ...query, data: mapped };
}

/**
 * Paginated stay listings. Wraps the cursor-based `listPublicPage` endpoint
 * with React Query's infinite-query machinery so the redesigned StaysPage
 * can show a "Load more" button without holding the full catalog in memory.
 * Returns a flat mapped array plus the standard fetchNextPage/hasNextPage
 * controls. Mirror `useInfiniteMarketplaceServices/Transport` below.
 */
export function useInfiniteMarketplaceStays(options?: { pageSize?: number; from?: string; to?: string }) {
  const listingService = getListingService();
  const pageSize = options?.pageSize ?? 24;
  // Only treat a complete, positive-length range as an active filter — a lone
  // check-in shouldn't refetch or narrow the list.
  const from = options?.from && options?.to && options.to > options.from ? options.from : undefined;
  const to = from ? options?.to : undefined;
  const query = useInfiniteQuery({
    // Dates are part of the key so React Query refetches (and the cursor
    // resets) whenever the requested range changes.
    queryKey: ["marketplace-stays-infinite", pageSize, from ?? null, to ?? null],
    retry: 2,
    staleTime: 30 * 1000,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const result = await listingService.listPublicPage({ type: "stay", limit: pageSize, cursor: pageParam, from, to });
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load stays");
      return result.data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const data = useMemo(() => {
    if (!query.data) return [];
    return query.data.pages
      .flatMap((p) => p.data)
      .filter((row) => inferListingType(row) === "stay")
      .map(mapListingRowToMarketplaceStay);
  }, [query.data]);
  return { ...query, data };
}

export function useInfiniteMarketplaceServices(options?: { pageSize?: number; from?: string; to?: string }) {
  const listingService = getListingService();
  const pageSize = options?.pageSize ?? 24;
  // A single picked day arrives as a one-day range (from = day, to = day+1) so
  // it flows through the same backend param as stays; the server applies the
  // slot-level availability filter for services. Ignore an incomplete range.
  const from = options?.from && options?.to && options.to > options.from ? options.from : undefined;
  const to = from ? options?.to : undefined;
  const query = useInfiniteQuery({
    queryKey: ["marketplace-services-infinite", pageSize, from ?? null, to ?? null],
    retry: 2,
    staleTime: 30 * 1000,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const result = await listingService.listPublicPage({ type: "service", limit: pageSize, cursor: pageParam, from, to });
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load services");
      return result.data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const data = useMemo(() => {
    if (!query.data) return [];
    return query.data.pages
      .flatMap((p) => p.data)
      .filter((row) => inferListingType(row) === "service")
      .map(mapListingRowToMarketplaceService);
  }, [query.data]);
  return { ...query, data };
}

export function useInfiniteMarketplaceTransport(options?: { pageSize?: number; from?: string; to?: string }) {
  const listingService = getListingService();
  const pageSize = options?.pageSize ?? 24;
  // Single picked day → one-day range (see useInfiniteMarketplaceServices).
  const from = options?.from && options?.to && options.to > options.from ? options.from : undefined;
  const to = from ? options?.to : undefined;
  const query = useInfiniteQuery({
    queryKey: ["marketplace-transport-infinite", pageSize, from ?? null, to ?? null],
    retry: 2,
    staleTime: 30 * 1000,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const result = await listingService.listPublicPage({ type: "transport", limit: pageSize, cursor: pageParam, from, to });
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load transport");
      return result.data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const data = useMemo(() => {
    if (!query.data) return [];
    return query.data.pages
      .flatMap((p) => p.data)
      .filter((row) => inferListingType(row) === "transport")
      .map(mapListingRowToMarketplaceTransport);
  }, [query.data]);
  return { ...query, data };
}

/**
 * Service listings mapped to the redesigned `MarketplaceService` contract.
 * Mirrors `useMarketplaceStays` but for the services tab. Defensively filters
 * out rows whose listing_type is not "service" so the page never shows a
 * stay/transport row with service treatment.
 */
export function useMarketplaceServices(options?: { limit?: number }) {
  const listingService = getListingService();
  const query = useQuery({
    queryKey: ["marketplace-services", options?.limit ?? null],
    retry: 2,
    staleTime: 30 * 1000,
    refetchOnMount: true,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const result = await listingService.listPublic({ type: "service", limit: options?.limit });
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load services");
      return result.data
        .filter((row) => inferListingType(row) === "service")
        .map(mapListingRowToMarketplaceService);
    },
  });
  return { ...query, data: query.data ?? [] };
}

/**
 * Single service listing mapped to MarketplaceService. Returns `data: null`
 * when the backend has no matching row (or it's a stay/transport), so the
 * caller can render a not-found page.
 */
export function useMarketplaceService(id: string | undefined) {
  const listingService = getListingService();
  const query = useQuery({
    queryKey: ["marketplace-service", id],
    enabled: Boolean(id),
    retry: 2,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const result = await listingService.getRawById(String(id));
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load service");
      return result.data;
    },
  });
  const row = query.data;
  const mapped = row && inferListingType(row) === "service"
    ? mapListingRowToMarketplaceService(row)
    : null;
  return { ...query, data: mapped };
}

/**
 * Transport listings mapped to the redesigned `MarketplaceTransport` contract.
 * Mirrors `useMarketplaceStays` but for the transport tab. Defensively filters
 * to listing_type === "transport".
 */
export function useMarketplaceTransport(options?: { limit?: number }) {
  const listingService = getListingService();
  const query = useQuery({
    queryKey: ["marketplace-transport", options?.limit ?? null],
    retry: 2,
    staleTime: 30 * 1000,
    refetchOnMount: true,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const result = await listingService.listPublic({ type: "transport", limit: options?.limit });
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load transport");
      return result.data
        .filter((row) => inferListingType(row) === "transport")
        .map(mapListingRowToMarketplaceTransport);
    },
  });
  return { ...query, data: query.data ?? [] };
}

/**
 * Single transport listing mapped to MarketplaceTransport. Returns `data: null`
 * when the backend has no matching row (or it's not a transport listing).
 * Named `useMarketplaceTransportListing` to avoid colliding with the plural
 * `useMarketplaceTransport` (which is a list hook).
 */
export function useMarketplaceTransportListing(id: string | undefined) {
  const listingService = getListingService();
  const query = useQuery({
    queryKey: ["marketplace-transport-listing", id],
    enabled: Boolean(id),
    retry: 2,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const result = await listingService.getRawById(String(id));
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load transport");
      return result.data;
    },
  });
  const row = query.data;
  const mapped = row && inferListingType(row) === "transport"
    ? mapListingRowToMarketplaceTransport(row)
    : null;
  return { ...query, data: mapped };
}

/**
 * Resolves the guest's saved (wishlisted) listing IDs to full card models by
 * fetching each listing directly. The Saved tab previously resolved saved IDs
 * against the first page of the public feeds (limit 100 — also the server's
 * hard MAX_LIMIT), so any save that had drifted past position 100 in its
 * type's newest-first feed silently vanished from the dashboard while the
 * card's heart still showed filled.
 *
 * Per-ID fetches share the ["marketplace-listing", id] cache (same key +
 * queryFn shape as useMarketplaceListingDetail), so a listing already viewed
 * via its detail page resolves instantly. A stale id — deleted or banned
 * listing — fails its own query and is filtered out, preserving the old
 * "stale saves don't inflate the count" behavior.
 */
export function useSavedListings(saved: { stay: string[]; service: string[]; transport: string[] }) {
  const listingService = getListingService();
  const ids = useMemo(
    () => [...new Set([...saved.stay, ...saved.service, ...saved.transport].map(String))],
    [saved.stay, saved.service, saved.transport],
  );
  const queries = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["marketplace-listing", id],
      retry: 2,
      staleTime: 5 * 60 * 1000,
      queryFn: async () => {
        const result = await listingService.getRawById(id);
        if (!result.success || !result.data) throw new Error(result.error || "Failed to load listing");
        return result.data;
      },
    })),
  });

  const rows = new Map<string, any>();
  queries.forEach((q, i) => { if (q.data) rows.set(ids[i], q.data); });
  // Keep each bucket in saved order; drop unresolved ids and rows whose
  // actual listing type disagrees with the bucket they were saved under
  // (mirrors the defensive inferListingType filters on the feed hooks).
  const pick = (bucket: string[], kind: ListingKind) =>
    bucket.flatMap((id) => {
      const row = rows.get(String(id));
      return row && inferListingType(row) === kind ? [row] : [];
    });

  return {
    stays: pick(saved.stay, "stay").map(mapListingToStay),
    services: pick(saved.service, "service").map(mapListingRowToMarketplaceService),
    transports: pick(saved.transport, "transport").map(mapListingRowToMarketplaceTransport),
    isLoading: queries.some((q) => q.isLoading),
  };
}

export function useUserBookings() {
  const bookingService = getBookingService();
  // Guard against firing before the auth token is available. Without this,
  // the first render on the dashboard can hit /api/bookings before Firebase
  // has finished initializing, the request goes out with no Authorization
  // header, and we cache a 401 for the whole session. Keying on user.id also
  // means the query automatically refetches after login / account switch.
  const { user, loading: authLoading } = useAuth();

  const query = useQuery({
    queryKey: ["bookings", user?.id ?? null],
    enabled: !authLoading && Boolean(user?.id),
    retry: 2,
    // Tighter stale window + window-focus + tab-active polling so a status
    // change made on the host/provider side surfaces on the guest dashboard
    // within ~30s without requiring a manual refresh. Real-time websockets
    // would be ideal, but the polling is robust to transient WS failures.
    staleTime: 15 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: 30 * 1000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const result = await bookingService.getUserBookings();
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load bookings");
      return result.data;
    },
  });

  return {
    ...query,
    data: query.data ?? [],
    // bookingKindOf handles both category formats ("stay:hotel" and bare
    // "hotel") — a plain includes("stay") missed mobile-created hotel/lodge/
    // heritage/sathram bookings and mis-bucketed them as services.
    guestStayBookings: query.data?.filter((booking) => bookingKindOf(booking.serviceCategory) === "stay").map(mapBookingToGuestStayBooking) ?? [],
    guestServiceBookings: query.data?.filter((booking) => bookingKindOf(booking.serviceCategory) !== "stay").map(mapBookingToGuestServiceBooking) ?? [],
  };
}

/** Pulls the live set of categories + subcategories that show up on
 *  published listings of a given type. Used by the marketplace filter
 *  dialog to populate chip lists from real data — so a host who saves
 *  a "drone-pilot" service shows up under filter chips the next time a
 *  customer opens services filters.
 *
 *  Cached for 5 minutes — taxonomies change rarely and a stale chip list
 *  is cheaper than hammering the DB. */
export function useListingTaxonomy(kind: ListingKind) {
  return useQuery({
    queryKey: ["listing-taxonomy", kind],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      // The server wraps the payload as `{ data: { categories, subcategories,
      // type } }`. `apiRequest` itself returns `{ success, data }` where
      // `data` is the parsed server body — so the actual taxonomy is at
      // `result.data.data`. The previous version returned `result.data` and
      // dropped one level, leaving consumers with `{ data: {...} }` and
      // empty chip lists on every call.
      const empty = { categories: [] as string[], subcategories: [] as string[], type: kind };
      try {
        const result = await apiRequest<{ data: { categories: string[]; subcategories: string[]; type: ListingKind } }>(
          `/api/listings/taxonomy?type=${encodeURIComponent(kind)}`,
        );
        if (!result?.success) return empty;
        const inner = (result.data as any)?.data ?? result.data;
        if (!inner || typeof inner !== "object") return empty;
        return {
          categories: Array.isArray(inner.categories) ? inner.categories.filter((c: any) => typeof c === "string" && c) : [],
          subcategories: Array.isArray(inner.subcategories) ? inner.subcategories.filter((c: any) => typeof c === "string" && c) : [],
          type: kind,
        };
      } catch {
        return empty;
      }
    },
  });
}
