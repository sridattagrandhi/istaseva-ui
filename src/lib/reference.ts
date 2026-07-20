// Human-facing booking / payment reference (support lookup code).
//
// Mirrors the DB's STORED generated columns `bookings.booking_reference` /
// `payments.payment_reference` (migration 20260718010000): the first 16 hex
// chars of the row's UUID, uppercased. Deriving it client-side from the UUID
// the API already returns keeps every surface consistent with what support
// finds by exact-match on the DB column — do not change one without the other.
export function displayRef(id: string | number | null | undefined): string {
  if (id == null || id === "") return "";
  return String(id).replace(/-/g, "").slice(0, 16).toUpperCase();
}
