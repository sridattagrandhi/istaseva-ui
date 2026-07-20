// Human-facing booking / payment reference (support lookup code).
//
// Mirrors the DB's STORED generated columns `bookings.booking_reference` /
// `payments.payment_reference` (server migration 20260718010000) and the web
// helper `src/lib/reference.ts`: the first 16 hex chars of the row's UUID,
// uppercased. Keep the three in sync.
export function displayRef(id: string | number | null | undefined): string {
  if (id == null || id === "") return "";
  return String(id).replace(/-/g, "").slice(0, 16).toUpperCase();
}
