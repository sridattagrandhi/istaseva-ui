// Lightweight sessionStorage-backed draft persistence for the booking modal.
//
// Problem this solves: when a guest types an address (or any other field),
// closes the booking modal, and navigates away — coming back to the same
// listing remounts the modal with empty state. We persist the form snapshot
// keyed by (kind, listingId) so the user doesn't lose their input. Drafts
// are intentionally session-scoped (not localStorage) so they evaporate
// when the tab closes.

import { useCallback, useEffect, useRef, useState } from "react";

const KEY_PREFIX = "booking-draft:v1:";

function keyFor(kind: string, listingId: string | number | undefined): string | null {
  if (!listingId && listingId !== 0) return null;
  return `${KEY_PREFIX}${kind}:${String(listingId)}`;
}

function readDraft<T extends Record<string, unknown>>(storageKey: string): Partial<T> | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Partial<T>;
    return null;
  } catch {
    return null;
  }
}

function writeDraft(storageKey: string, value: Record<string, unknown>): void {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    /* quota / privacy mode — silently ignore */
  }
}

/** Remove a saved draft. Call on successful booking confirm so the next
 *  booking starts clean. */
export function clearBookingDraft(kind: string, listingId: string | number | undefined): void {
  try {
    if (typeof window === "undefined") return;
    const key = keyFor(kind, listingId);
    if (key) window.sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * Pair with each useState in the booking body. Reads the draft synchronously
 * on first render (so values restore before paint) and writes back whenever
 * the value changes — debounced via the existing render cycle (sessionStorage
 * writes are cheap; no debounce needed for a handful of fields).
 *
 * Usage:
 *   const draft = useBookingDraft("service", service.id);
 *   const [address, setAddress] = draft.useField("address", "");
 */
export function useBookingDraft<T extends Record<string, unknown>>(
  kind: string,
  listingId: string | number | undefined,
) {
  const storageKey = keyFor(kind, listingId);
  // Cache the initial draft so multiple useField calls see the same snapshot
  // without re-parsing JSON for each one.
  const draftRef = useRef<Partial<T> | null>(null);
  if (draftRef.current === null && storageKey) {
    draftRef.current = readDraft<T>(storageKey);
  }

  // Buffer pending writes so multiple useField updates in the same tick
  // collapse to one sessionStorage write.
  const pendingRef = useRef<Record<string, unknown>>({});
  if (Object.keys(pendingRef.current).length === 0 && draftRef.current) {
    pendingRef.current = { ...draftRef.current };
  }

  const flush = useCallback(() => {
    if (!storageKey) return;
    writeDraft(storageKey, pendingRef.current);
  }, [storageKey]);

  function useField<V>(name: keyof T & string, initial: V): [V, (next: V) => void] {
    const initialValue = (() => {
      const saved = draftRef.current?.[name];
      // Type-coerce: we trust the saved shape matches the call site since
      // it's the same component tree writing both ends. Strings, numbers,
      // booleans round-trip cleanly through JSON; complex shapes can be
      // restored as-is.
      if (saved !== undefined && saved !== null) return saved as V;
      return initial;
    })();
    const [value, setValue] = useState<V>(initialValue);

    const set = useCallback((next: V) => {
      setValue(next);
      pendingRef.current[name] = next as unknown;
      flush();
    }, [name]);

    return [value, set];
  }

  // Surface a manual clear so the caller can wipe the draft post-confirm
  // without importing clearBookingDraft separately.
  const clear = useCallback(() => {
    pendingRef.current = {};
    draftRef.current = null;
    if (storageKey) {
      try {
        if (typeof window !== "undefined") window.sessionStorage.removeItem(storageKey);
      } catch { /* ignore */ }
    }
  }, [storageKey]);

  // Defensive cleanup: ensure pending writes hit storage even if the
  // component unmounts mid-tick.
  useEffect(() => {
    return () => { flush(); };
  }, [flush]);

  return { useField, clear };
}
