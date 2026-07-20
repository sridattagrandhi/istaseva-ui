import { useCallback, useEffect, useState } from "react";
import {
  type RecentSearch,
  type SearchCategory,
  clearRecentSearches,
  loadRecentSearches,
  recordRecentSearch,
  removeRecentSearch,
} from "@/lib/recent-searches";

export type { RecentSearch, SearchCategory } from "@/lib/recent-searches";

/**
 * Per-user (per-device) list of the last few searches for one marketplace
 * category (stays / services / transport), backed by localStorage. `record`
 * upserts a snapshot (dedup + move-to-front, cap 3); `remove`/`clear` manage
 * the list. Reloads when the signed-in user changes so each identity sees its
 * own recents.
 */
export function useRecentSearches(category: SearchCategory, userId?: string) {
  const [recents, setRecents] = useState<RecentSearch[]>(() => loadRecentSearches(category, userId));

  useEffect(() => {
    setRecents(loadRecentSearches(category, userId));
  }, [category, userId]);

  const record = useCallback(
    (snapshot: Omit<RecentSearch, "id" | "createdAt" | "category">) => {
      setRecents(recordRecentSearch(category, userId, snapshot, new Date().toISOString()));
    },
    [category, userId],
  );

  const remove = useCallback(
    (id: string) => setRecents(removeRecentSearch(category, userId, id)),
    [category, userId],
  );

  const clear = useCallback(() => setRecents(clearRecentSearches(category, userId)), [category, userId]);

  return { recents, record, remove, clear };
}
