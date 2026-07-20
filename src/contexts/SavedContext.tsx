import React, { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { getWishlistService, WishlistType } from "@/domains/wishlist/wishlist.service";
import { getAnalyticsEventsService } from "@/domains/analytics/events.service";

/**
 * Wishlist / saved listings.
 *
 * Storage strategy:
 *   - Signed in  → /api/wishlist (server is the source of truth, cross-device).
 *   - Signed out → nothing is saved (the heart prompts sign-in instead).
 *   - localStorage is ONLY a per-user hydration cache so the Saved tab paints
 *     instantly on reload before the server round-trip returns. Keys are
 *     scoped by user id — a shared device must never show (or worse, upload)
 *     one account's saves under another. The old un-scoped keys and the
 *     "push localStorage to the server on login" migration did exactly that
 *     and are gone; the legacy keys get deleted on mount.
 *
 * Callers (ListingCard's heart button, Guest Dashboard Saved tab, etc.) only
 * see synchronous `toggle*` / `is*Saved` helpers — async network sync happens
 * opportunistically in the background. Optimistic update, revert on error.
 */
interface SavedContextType {
  savedStays: string[];
  savedServices: string[];
  savedTransport: string[];
  toggleSaveStay: (id: string) => void;
  toggleSaveService: (id: string) => void;
  toggleSaveTransport: (id: string) => void;
  isStaySaved: (id: string) => boolean;
  isServiceSaved: (id: string) => boolean;
  isTransportSaved: (id: string) => boolean;
  /** Reflect a save/unsave that ALREADY happened server-side (e.g. the AI
   *  assistant's toggle_wishlist tool). Updates local state only — no second
   *  network write — so hearts and the Saved tab stay in sync without a
   *  double-toggle or a full re-hydration. */
  applyServerSave: (type: WishlistType, id: string, saved: boolean) => void;
}

const SavedContext = createContext<SavedContextType | undefined>(undefined);

const STAYS_KEY = "istaseva:saved:stays:v1";
const SERVICES_KEY = "istaseva:saved:services:v1";
const TRANSPORT_KEY = "istaseva:saved:transport:v1";

// Per-user cache key. The bare v1 keys above are the legacy un-scoped
// variants — kept only so we can delete them (they leaked saves across
// accounts on shared devices).
const keyFor = (base: string, uid: string) => `${base}:${uid}`;

function readList(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

function writeList(key: string, ids: string[]) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, JSON.stringify(ids)); } catch { /* quota / private mode — ignore */ }
}

export const SavedProvider = ({ children }: { children: ReactNode }) => {
  const { isAuthenticated, user } = useAuth();
  const uid = isAuthenticated ? user?.id ?? null : null;
  const [savedStays, setSavedStays] = useState<string[]>([]);
  const [savedServices, setSavedServices] = useState<string[]>([]);
  const [savedTransport, setSavedTransport] = useState<string[]>([]);

  // Whose saves the in-memory state currently belongs to. Null while
  // switching users (or signed out) so the persistence effects below never
  // write one account's list into another account's cache key.
  const cacheUid = useRef<string | null>(null);

  // One-time: delete the legacy un-scoped cache keys. They pre-date per-user
  // scoping and are the reason saves bled across accounts on shared devices.
  useEffect(() => {
    [STAYS_KEY, SERVICES_KEY, TRANSPORT_KEY].forEach((k) => {
      try { window.localStorage.removeItem(k); } catch { /* private mode — ignore */ }
    });
  }, []);

  // Mirror state into this user's cache for instant hydration on next load.
  useEffect(() => { if (cacheUid.current) writeList(keyFor(STAYS_KEY, cacheUid.current), savedStays); }, [savedStays]);
  useEffect(() => { if (cacheUid.current) writeList(keyFor(SERVICES_KEY, cacheUid.current), savedServices); }, [savedServices]);
  useEffect(() => { if (cacheUid.current) writeList(keyFor(TRANSPORT_KEY, cacheUid.current), savedTransport); }, [savedTransport]);

  // On login (or user switch): hydrate from that user's own cache for an
  // instant paint, then refresh from the server as source of truth. On
  // logout: clear in-memory state; the per-user cache stays on disk for the
  // next time that same account signs in.
  useEffect(() => {
    cacheUid.current = null;
    if (!uid) {
      setSavedStays([]);
      setSavedServices([]);
      setSavedTransport([]);
      return;
    }
    setSavedStays(readList(keyFor(STAYS_KEY, uid)));
    setSavedServices(readList(keyFor(SERVICES_KEY, uid)));
    setSavedTransport(readList(keyFor(TRANSPORT_KEY, uid)));
    cacheUid.current = uid;

    (async () => {
      const fetched = await getWishlistService().list();
      // Bail if the user changed while the request was in flight.
      if (cacheUid.current !== uid) return;
      if (fetched.success && fetched.data) {
        setSavedStays(fetched.data.stay);
        setSavedServices(fetched.data.service);
        setSavedTransport(fetched.data.transport);
      }
    })().catch(() => { /* offline / 5xx — fall back to cached state */ });
  }, [uid]);

  // Generic toggle: optimistic update + best-effort server sync when authed.
  const makeToggle = useCallback((
    type: WishlistType,
    ids: string[],
    setIds: React.Dispatch<React.SetStateAction<string[]>>,
  ) => (id: string) => {
    // Auth gate: anonymous users used to be able to "save" into localStorage,
    // which made the heart flip to filled even though nothing persisted
    // server-side. The hosts saw it as a confusing dead-end. Now we prompt
    // for sign-in instead and short-circuit before mutating state.
    if (!isAuthenticated) {
      toast("Sign in to save listings", {
        description: "We'll keep your favorites synced across devices.",
        action: {
          label: "Sign in",
          onClick: () => { window.location.href = "/login"; },
        },
      });
      return;
    }
    const isCurrentlySaved = ids.includes(id);
    setIds((prev) => isCurrentlySaved ? prev.filter((s) => s !== id) : [...prev, id]);
    getAnalyticsEventsService().track(isCurrentlySaved ? "wishlist_remove" : "wishlist_add", { listingId: String(id), listingType: type, source: "wishlist" });
    const svc = getWishlistService();
    const op = isCurrentlySaved ? svc.remove(id, type) : svc.add(id, type);
    op.then((res) => {
      if (!res.success) {
        // Revert on failure so the UI stays honest.
        setIds((prev) => isCurrentlySaved ? [...prev, id] : prev.filter((s) => s !== id));
      }
    }).catch(() => {
      setIds((prev) => isCurrentlySaved ? [...prev, id] : prev.filter((s) => s !== id));
    });
  }, [isAuthenticated]);

  const toggleSaveStay = useCallback((id: string) => makeToggle("stay", savedStays, setSavedStays)(id), [makeToggle, savedStays]);
  const toggleSaveService = useCallback((id: string) => makeToggle("service", savedServices, setSavedServices)(id), [makeToggle, savedServices]);
  const toggleSaveTransport = useCallback((id: string) => makeToggle("transport", savedTransport, setSavedTransport)(id), [makeToggle, savedTransport]);

  // Anonymous users never appear as having saved anything — even if the old
  // localStorage cache from a previous (now-removed) anon-save mode is
  // present. Pair this with the auth gate inside makeToggle so anon users
  // see a clean "Sign in to save" prompt instead of mismatched filled
  // hearts.
  const isStaySaved = (id: string) => isAuthenticated && savedStays.includes(id);
  const isServiceSaved = (id: string) => isAuthenticated && savedServices.includes(id);
  const isTransportSaved = (id: string) => isAuthenticated && savedTransport.includes(id);

  const applyServerSave = useCallback((type: WishlistType, id: string, saved: boolean) => {
    const setIds =
      type === "stay" ? setSavedStays : type === "service" ? setSavedServices : setSavedTransport;
    setIds((prev) =>
      saved ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((s) => s !== id),
    );
  }, []);

  return (
    <SavedContext.Provider value={{
      savedStays, savedServices, savedTransport,
      toggleSaveStay, toggleSaveService, toggleSaveTransport,
      isStaySaved, isServiceSaved, isTransportSaved,
      applyServerSave,
    }}>
      {children}
    </SavedContext.Provider>
  );
};

export const useSaved = () => {
  const context = useContext(SavedContext);
  if (!context) throw new Error("useSaved must be used within SavedProvider");
  return context;
};
