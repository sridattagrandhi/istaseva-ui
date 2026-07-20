// Pure shaping for the in-chat "Call" gate — kept out of the (heavy) bookings
// service so it can be unit-tested in isolation.

export type CallRelationshipRow = { peer_role: string; peer_phone: string | null };
export type CallRelationship = { hasActiveBooking: boolean; phone: string | null; roles: string[] };

/**
 * Collapse the per-booking relationship rows into the client payload: an active
 * booking exists iff any row came back; `roles` is the de-duped set of the
 * peer's roles relative to the caller; `phone` is the first non-empty number.
 */
export function shapeCallRelationship(rows: CallRelationshipRow[]): CallRelationship {
  if (!rows || rows.length === 0) {
    return { hasActiveBooking: false, phone: null, roles: [] };
  }
  const roles = Array.from(new Set(rows.map((r) => r.peer_role).filter(Boolean)));
  const phone = rows.map((r) => r.peer_phone).find((p) => typeof p === 'string' && p.trim().length > 0) ?? null;
  return { hasActiveBooking: true, phone, roles };
}
