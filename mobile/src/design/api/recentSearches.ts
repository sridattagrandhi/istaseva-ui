// design/api/recentSearches.ts — recent marketplace searches, per-device UI state.
//
// Mobile port of the web `src/lib/recent-searches.ts`. SEPARATE from the
// search_events analytics path (see searchEvents.ts): that is aggregate logging,
// this is a per-device, per-user list of the last few searches a person ran so
// we can offer one-tap recall. Backed by AsyncStorage, following the
// best-effort, prefix-keyed pattern in api/onboardingDraft.ts. Storage is async,
// so the read/write helpers return Promises and the hook loads in an effect.
//
// Each marketplace segment (stays / services / transport) keeps its OWN list of
// MAX_RECENTS entries under its own storage key — searching transport never
// evicts a stays recent. The "stays" key predates the category split, so
// existing users' stay recents survive unchanged.
import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type SearchCategory = "stays" | "services" | "transport";

const STORAGE_PREFIX = "istaseva:recent-searches:";
const MAX_RECENTS = 3;

/** A recalled search snapshot — the "primary search" only (place + dates +
 *  guests), not the full filter set. `search` mirrors what the input shows;
 *  when `place` is set it equals `place.description` so restoring the place
 *  reads consistently. Services/transport searches carry no dates/guests, so
 *  they persist with an empty date range and `minGuests: 1`. */
export type RecentSearch = {
  id: string;
  createdAt: string;
  category: SearchCategory;
  search: string;
  place: {
    lat: number;
    lng: number;
    locality: string | null;
    district: string | null;
    state: string | null;
    description: string;
  } | null;
  dateRange: { start: string | null; end: string | null };
  minGuests: number;
};

function keyFor(category: SearchCategory, userId: string | undefined | null): string {
  return `${STORAGE_PREFIX}${category}:v1:${userId || "anon"}`;
}

/** Canonical identity of a search, used to dedup. Keyed on the BASE only — the
 *  picked place (rounded lat/lng) or the normalized free-text query — and
 *  deliberately NOT on dates/guests. Refining the same search (adding dates,
 *  bumping guests) updates one evolving entry to the latest values instead of
 *  filling all three slots with variations of the same place. */
export function recentSearchKey(s: Pick<RecentSearch, "search" | "place">): string {
  return s.place
    ? `geo:${s.place.lat.toFixed(3)},${s.place.lng.toFixed(3)}`
    : `q:${s.search.trim().toLowerCase()}`;
}

export async function loadRecentSearches(
  category: SearchCategory,
  userId: string | undefined | null,
): Promise<RecentSearch[]> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(category, userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: only keep well-shaped entries so a schema bump or hand-edited
    // value can't crash the render. A recent must also be ANCHORED to a place or
    // a typed query — dates/guests are refinements, never a search on their own.
    // This also purges where-less entries persisted by older logic (e.g. a bare
    // "24–26 Jun" chip) on the next load. Entries written before the category
    // split lack `category` — backfill it from the list they were stored under.
    return parsed
      .filter((e): e is RecentSearch =>
        e && typeof e.id === "string" && typeof e.search === "string" && e.dateRange && typeof e.minGuests === "number"
        && (!!e.place || e.search.trim().length > 0))
      .map((e) => (e.category ? e : { ...e, category }))
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

async function writeRecentSearches(
  category: SearchCategory,
  userId: string | undefined | null,
  list: RecentSearch[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(keyFor(category, userId), JSON.stringify(list.slice(0, MAX_RECENTS)));
  } catch {
    // quota / storage failure — best-effort, never blocks the search flow.
  }
}

/** Upsert a snapshot: dedup by canonical key (move-to-front), cap to 3.
 *  Returns the new list so callers can update state in one step. */
export async function recordRecentSearch(
  category: SearchCategory,
  userId: string | undefined | null,
  snapshot: Omit<RecentSearch, "id" | "createdAt" | "category">,
  nowIso: string,
): Promise<RecentSearch[]> {
  // A recent must be anchored to a place or a typed query — never dates/guests
  // alone. Guard here too so no code path can persist a where-less chip.
  if (!snapshot.place && snapshot.search.trim().length === 0) {
    return loadRecentSearches(category, userId);
  }
  const id = recentSearchKey(snapshot);
  // Evict the exact-key match AND any free-text entry in a prefix relation
  // with the new one. The debounced capture can fire mid-typing ("Ayur" …
  // pause … "Ayurveda"), and exact-key dedup alone would keep each partial as
  // its own chip — treat those as one evolving search and keep only the newest.
  const q = snapshot.place ? null : snapshot.search.trim().toLowerCase();
  const existing = (await loadRecentSearches(category, userId)).filter((e) => {
    if (e.id === id) return false;
    if (q && !e.place) {
      const prev = e.search.trim().toLowerCase();
      if (prev.startsWith(q) || q.startsWith(prev)) return false;
    }
    return true;
  });
  const next: RecentSearch[] = [{ ...snapshot, id, createdAt: nowIso, category }, ...existing].slice(0, MAX_RECENTS);
  await writeRecentSearches(category, userId, next);
  return next;
}

export async function removeRecentSearch(
  category: SearchCategory,
  userId: string | undefined | null,
  id: string,
): Promise<RecentSearch[]> {
  const next = (await loadRecentSearches(category, userId)).filter((e) => e.id !== id);
  await writeRecentSearches(category, userId, next);
  return next;
}

export async function clearRecentSearches(
  category: SearchCategory,
  userId: string | undefined | null,
): Promise<RecentSearch[]> {
  await writeRecentSearches(category, userId, []);
  return [];
}

/**
 * Per-user (per-device) list of the last few searches for one marketplace
 * segment (stays / services / transport). `record` upserts a snapshot (dedup +
 * move-to-front, cap 3); `remove`/`clear` manage the list. Reloads when the
 * signed-in user or the segment changes so each identity/segment sees its own
 * recents. Loads asynchronously, so `recents` is empty for the first frame.
 */
export function useRecentSearches(category: SearchCategory, userId?: string) {
  const [recents, setRecents] = useState<RecentSearch[]>([]);

  useEffect(() => {
    let alive = true;
    void loadRecentSearches(category, userId).then((list) => { if (alive) setRecents(list); });
    return () => { alive = false; };
  }, [category, userId]);

  const record = useCallback(
    (snapshot: Omit<RecentSearch, "id" | "createdAt" | "category">) => {
      void recordRecentSearch(category, userId, snapshot, new Date().toISOString()).then(setRecents);
    },
    [category, userId],
  );

  const remove = useCallback(
    (id: string) => { void removeRecentSearch(category, userId, id).then(setRecents); },
    [category, userId],
  );

  const clear = useCallback(() => { void clearRecentSearches(category, userId).then(setRecents); }, [category, userId]);

  return { recents, record, remove, clear };
}
