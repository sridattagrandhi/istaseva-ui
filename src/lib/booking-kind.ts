/**
 * Classify a booking row's `serviceCategory` into its marketplace vertical.
 *
 * The category string has TWO formats in the DB, written by different clients:
 *   - web booking modal:  "stay:hotel", "stay:homestay", … (stay:-prefixed)
 *   - mobile + assistant: "hotel", "homestay", … (bare property type)
 * Transport is "driver-hourly/day/package" (+ legacy "driver-cab" etc.);
 * services are their own category slugs ("plumber", "mehendi", …).
 *
 * The dashboards MUST all use this one classifier: HostDashboard previously
 * required the "stay:" prefix, so every mobile-created stay booking leaked
 * into the Provider dashboard as a "service" (inflating its counts) while
 * vanishing from the Host dashboard.
 *
 * Mirrors mobile's `kindOf` in mobile/src/design/api/bookings.ts — keep the
 * two rule-identical (mobile and web share no code).
 */
const STAY_TYPES = ["homestay", "hotel", "lodge", "village-stay", "farm-stay", "heritage", "sathram"];

export function bookingKindOf(category: string | null | undefined): "stay" | "service" | "transport" {
  const c = (category || "").toLowerCase();
  if (c.startsWith("driver") || c.includes("cab") || c.includes("auto") || c.includes("van")) return "transport";
  if (c.startsWith("stay") || STAY_TYPES.some((s) => c.includes(s))) return "stay";
  return "service";
}
