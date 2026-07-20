// design/DesignContext.tsx — client-side state shared across the redesigned screens
// (wishlist set + bookings list). Wishlist is auth-aware: hydrated from the backend
// and persisted on toggle when signed in; local-only (mock seed) for guests.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Booking } from "./types";
import { useAuth } from "@/contexts/AuthContext";
import { isApiId } from "./api/listings";
import { fetchWishlistIds, addWishlist, removeWishlist, WishType } from "./api/wishlist";

type DesignState = {
  wish: Set<string>;
  toggleWish: (id: string, type?: WishType) => void;
  /** Mirror a save the SERVER already persisted (e.g. the assistant's
   *  toggle_wishlist tool) — updates the local set without re-calling the API. */
  applyWish: (id: string, saved: boolean) => void;
  bookings: Booking[];
  addBooking: (b: Booking) => void;
};

const Ctx = createContext<DesignState | null>(null);

export function DesignProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  // Wishlist hydrates from the backend when signed in; empty otherwise (no mock).
  const [wish, setWish] = useState<Set<string>>(new Set());
  // Real bookings come from the backend; this only holds this session's new ones.
  const [bookings, setBookings] = useState<Booking[]>([]);
  const wishRef = useRef(wish);
  wishRef.current = wish;

  // Hydrate from the backend on sign-in; clear on sign-out (no mock seed).
  useEffect(() => {
    if (user) fetchWishlistIds().then(setWish).catch(() => {});
    else setWish(new Set());
  }, [user]);

  const toggleWish = useCallback((id: string, type?: WishType) => {
    const had = wishRef.current.has(id);
    setWish((w) => { const n = new Set(w); had ? n.delete(id) : n.add(id); return n; });
    if (user && type && isApiId(id)) {
      (had ? removeWishlist(id, type) : addWishlist(id, type)).catch(() => {
        // revert on failure
        setWish((w) => { const n = new Set(w); had ? n.add(id) : n.delete(id); return n; });
      });
    }
  }, [user]);

  const applyWish = useCallback((id: string, saved: boolean) => {
    setWish((w) => { const n = new Set(w); saved ? n.add(id) : n.delete(id); return n; });
  }, []);

  const addBooking = useCallback((b: Booking) => setBookings((p) => [b, ...p]), []);

  const value = useMemo(() => ({ wish, toggleWish, applyWish, bookings, addBooking }), [wish, toggleWish, applyWish, bookings, addBooking]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDesign() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDesign must be used within DesignProvider");
  return v;
}
