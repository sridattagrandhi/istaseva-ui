// Recent marketplace searches — client-only UI state persisted to localStorage.
//
// This is deliberately SEPARATE from the search_events / DynamoDB logging:
// that path is aggregate analytics, this is a per-device, per-user list of the
// last few searches a person ran so we can offer one-tap recall. Mirrors the
// SSR-guarded, quota-tolerant pattern in src/lib/onboarding-draft.ts.
//
// Each marketplace tab (stays / services / transport) keeps its OWN list of
// MAX_RECENTS entries under its own storage key — searching transport never
// evicts a stays recent. The "stays" key predates the category split, so
// existing users' stay recents survive unchanged.

export type SearchCategory = "stays" | "services" | "transport";

const STORAGE_PREFIX = "istaseva:recent-searches:";
const MAX_RECENTS = 3;

/** A recalled search snapshot — the "primary search" only (place + dates +
 *  guests), not the full filter set. `search` mirrors what the input shows;
 *  when `place` is set it equals `place.description` so the page's
 *  picked-place invalidation effect doesn't drop the geo on restore.
 *  Services/transport searches are text-only today, so they persist with
 *  `place: null`, an empty date range, and `minGuests: 1`. */
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
 *  deliberately NOT on dates/guests. This way refining the same search (adding
 *  dates, bumping guests) updates one evolving entry to the latest values
 *  instead of filling all three slots with variations of the same place. */
export function recentSearchKey(s: Pick<RecentSearch, "search" | "place">): string {
  return s.place
    ? `geo:${s.place.lat.toFixed(3)},${s.place.lng.toFixed(3)}`
    : `q:${s.search.trim().toLowerCase()}`;
}

export function loadRecentSearches(category: SearchCategory, userId: string | undefined | null): RecentSearch[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(keyFor(category, userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: only keep well-shaped entries so a schema bump or hand-edited
    // value can't crash the render. Entries written before the category split
    // lack `category` — backfill it from the list they were stored under.
    return parsed
      .filter((e): e is RecentSearch =>
        e && typeof e.id === "string" && typeof e.search === "string" && e.dateRange && typeof e.minGuests === "number")
      .map((e) => (e.category ? e : { ...e, category }))
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function writeRecentSearches(category: SearchCategory, userId: string | undefined | null, list: RecentSearch[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(keyFor(category, userId), JSON.stringify(list.slice(0, MAX_RECENTS)));
  } catch {
    // quota / private mode — ignore
  }
}

/** Upsert a snapshot: dedup by canonical key (move-to-front), cap to 3.
 *  Returns the new list so callers can update state in one step. */
export function recordRecentSearch(
  category: SearchCategory,
  userId: string | undefined | null,
  snapshot: Omit<RecentSearch, "id" | "createdAt" | "category">,
  nowIso: string,
): RecentSearch[] {
  const id = recentSearchKey(snapshot);
  // Evict the exact-key match AND any free-text entry in a prefix relation
  // with the new one. The debounced capture can fire mid-typing ("Ayur" …
  // pause … "Ayurveda"), and exact-key dedup alone would keep each partial as
  // its own chip — treat those as one evolving search and keep only the newest.
  const q = snapshot.place ? null : snapshot.search.trim().toLowerCase();
  const existing = loadRecentSearches(category, userId).filter((e) => {
    if (e.id === id) return false;
    if (q && !e.place) {
      const prev = e.search.trim().toLowerCase();
      if (prev.startsWith(q) || q.startsWith(prev)) return false;
    }
    return true;
  });
  const next: RecentSearch[] = [{ ...snapshot, id, createdAt: nowIso, category }, ...existing].slice(0, MAX_RECENTS);
  writeRecentSearches(category, userId, next);
  return next;
}

export function removeRecentSearch(category: SearchCategory, userId: string | undefined | null, id: string): RecentSearch[] {
  const next = loadRecentSearches(category, userId).filter((e) => e.id !== id);
  writeRecentSearches(category, userId, next);
  return next;
}

export function clearRecentSearches(category: SearchCategory, userId: string | undefined | null): RecentSearch[] {
  writeRecentSearches(category, userId, []);
  return [];
}
