/**
 * Shared tolerant matchers for room types and transport packages.
 *
 * The model routinely passes a slug or display name ("deluxe-room",
 * "Deluxe Suite") instead of the real UUID / canonical id when it references
 * a room or package. Every tool that takes a `roomTypeId` / `transportPackageId`
 * must resolve it the same forgiving way — exact id, then normalised name,
 * then the sole option — or it silently fails with "that room doesn't exist".
 * Centralising the logic here keeps prepare_booking, the pricing preview, and
 * the availability tools consistent.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Loose-normalise for tolerant name matching: "Deluxe Room" ≈ "deluxe-room" ≈ "deluxeroom". */
export function normLoose(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Resolve a room the customer picked against the listing's ACTUAL rooms,
 * tolerating a slug/name instead of the real UUID. Matches by exact id, then
 * by normalised name (exact / contains either direction), then — when the
 * listing has exactly ONE room — that sole room (a single-room listing has
 * nothing to disambiguate, so a fake/invented id still resolves correctly).
 * Returns null only for a MULTI-room listing where nothing matched (caller
 * should then ask "which room?").
 */
export function matchRoomType(
  provided: string,
  rooms: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (rooms.length === 0) return null;
  const byId = rooms.find((r) => String(r.id) === provided);
  if (byId) return byId;
  const t = normLoose(provided);
  if (t) {
    const byName = rooms.find((r) => {
      const n = normLoose(String(r.name ?? ''));
      return n.length > 0 && (n === t || n.includes(t) || t.includes(n));
    });
    if (byName) return byName;
  }
  // Single-room listing — unambiguous, so resolve even an unrecognised ref.
  if (rooms.length === 1) return rooms[0];
  return null;
}

/**
 * Resolve a transport package id against the listing's actual packageOptions,
 * tolerating a slug/label instead of the real id. Returns the canonical id
 * (matching computeHoldSubtotalPaise's `p.id ?? pkg-${i}` convention) or null.
 */
export function matchPackageId(provided: string, opts: Array<Record<string, unknown>>): string | null {
  if (opts.length === 0) return null;
  const idOf = (p: Record<string, unknown>, i: number) => (typeof p.id === 'string' ? p.id : `pkg-${i}`);
  const byId = opts.findIndex((p, i) => idOf(p, i) === provided);
  if (byId !== -1) return idOf(opts[byId], byId);
  const t = normLoose(provided);
  if (t) {
    const byLabel = opts.findIndex((p) => {
      const label = normLoose(String(p.label ?? p.name ?? ''));
      return label.length > 0 && (label === t || label.includes(t) || t.includes(label));
    });
    if (byLabel !== -1) return idOf(opts[byLabel], byLabel);
  }
  // Single-package listing — unambiguous, so resolve even an unrecognised ref
  // (the model often guesses "pkg-0" when the real id is "pkg-1", or invents
  // a slug). With more than one package we still reject (price varies).
  if (opts.length === 1) return idOf(opts[0], 0);
  return null;
}
