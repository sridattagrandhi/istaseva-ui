import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";

// Global "Search everything" data hook. Fans one debounced query out to:
//  - GET /api/search — Postgres full-text over listing name / description /
//    category / area / city / state / address (the endpoint the AI
//    assistant's search_listings tool already uses; first UI consumer).
//  - POST /api/geocode/autocomplete (regions) — city / town / area
//    predictions, same proxy the stays "Where" picker uses.
// Both endpoints are anonymous-safe, so the palette works logged-out.

export interface GlobalSearchListing {
  id: string;
  name: string;
  listingType: "stay" | "service" | "transport";
  category: string | null;
  area: string | null;
  city: string | null;
  state: string | null;
}

export interface GlobalSearchPlace {
  id: string; // Google place_id (empty for Nominatim fallback rows)
  description: string;
  mainText: string;
  secondaryText: string;
}

interface RawListingRow {
  id: string;
  name?: string | null;
  title?: string | null;
  listing_type?: string | null;
  category?: string | null;
  area?: string | null;
  city?: string | null;
  state?: string | null;
}

const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 250;

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

async function fetchListings(q: string): Promise<GlobalSearchListing[]> {
  const res = await apiRequest<{ listings?: RawListingRow[] }>(
    `/api/search?q=${encodeURIComponent(q)}&limit=8`,
  );
  if (!res.success || !res.data?.listings) return [];
  return res.data.listings
    .filter((row): row is RawListingRow & { id: string } => !!row?.id)
    .map((row) => ({
      id: String(row.id),
      name: row.name || row.title || "",
      listingType: (row.listing_type === "service" || row.listing_type === "transport"
        ? row.listing_type
        : "stay") as GlobalSearchListing["listingType"],
      category: row.category ?? null,
      area: row.area ?? null,
      city: row.city ?? null,
      state: row.state ?? null,
    }))
    .filter((l) => l.name);
}

async function fetchPlaces(q: string): Promise<GlobalSearchPlace[]> {
  const res = await apiRequest<{ suggestions?: GlobalSearchPlace[] }>(
    "/api/geocode/autocomplete",
    {
      method: "POST",
      headers: getJsonHeaders(),
      // regions mode → settlements (city / town / area) only, matching what
      // the marketplace location filters understand.
      body: JSON.stringify({ input: q, mode: "regions" }),
    },
  );
  if (!res.success || !res.data?.suggestions) return [];
  return res.data.suggestions.slice(0, 5);
}

export function useGlobalSearch(query: string, enabled: boolean) {
  const q = useDebounced(query.trim(), DEBOUNCE_MS);
  const active = enabled && q.length >= MIN_QUERY_LEN;

  const listingsQuery = useQuery({
    queryKey: ["global-search", "listings", q],
    queryFn: () => fetchListings(q),
    enabled: active,
    staleTime: 30_000,
  });

  const placesQuery = useQuery({
    queryKey: ["global-search", "places", q],
    queryFn: () => fetchPlaces(q),
    enabled: active,
    staleTime: 30_000,
  });

  return {
    /** The debounced query the current results correspond to. */
    debouncedQuery: q,
    active,
    listings: listingsQuery.data ?? [],
    places: placesQuery.data ?? [],
    loading: active && (listingsQuery.isLoading || placesQuery.isLoading),
  };
}
