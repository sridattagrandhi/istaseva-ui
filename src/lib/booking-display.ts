/**
 * Single source of truth for "who the user booked from" UI labels.
 *
 * Why this exists: a stay booking's `providerName` is the provider_profile's
 * display_name — an operational concept (who manages the listing / receives
 * payouts), not what the customer recognises. We've shipped staging with a
 * single seed provider "Super Cleanings" linked to a hotel listing; without
 * stay-aware display logic, that label leaks into the booking card, the
 * details modal, AND the GST invoice. The customer's mental model of who
 * they booked is the property (Trident Hotels), not the back-office entity.
 *
 * For services and transport the provider IS the seller — "AC Doctor" is
 * who you hired, not the abstract category. So those keep showing the
 * provider name.
 *
 * Every place that surfaces "who you booked from" should go through one of
 * these helpers so we never have to patch a new component in isolation.
 */
import type { Booking } from "@/types/domain";

type BookingShape = Pick<Booking, "serviceCategory" | "listingName" | "providerName">;

/** True if the booking is a stay (hotel, homestay, etc.). */
export function isStayBooking(b: Pick<Booking, "serviceCategory">): boolean {
  const s = (b.serviceCategory || "").toLowerCase();
  return s.startsWith("stay") || s.includes("hotel") || s.includes("homestay");
}

/** True if the booking is a transport ride (driver, auto, cab, etc.). The
 *  `service_category` for transport rows starts with the vehicle type
 *  (driver-hourly, driver-day, auto, cab, van, bike, tempo) or the legacy
 *  `driver-quote` value. Aligned with `isTransport` in
 *  server/src/modules/payments/pricing/fees.ts so backend + frontend agree
 *  on what counts as transport. */
export function isTransportBooking(b: Pick<Booking, "serviceCategory">): boolean {
  const s = (b.serviceCategory || "").toLowerCase();
  return /^(auto|cab|van|bike|tempo|driver-)/.test(s) || s === "driver-quote";
}

/**
 * The label to use above the seller name in details views ("Property" for
 * stays, "Provider" for services/transport). Falls back to "Provider" if
 * the category is missing — same as the prior default.
 */
export function getBookingSellerLabel(b: Pick<Booking, "serviceCategory">): "Property" | "Provider" {
  return isStayBooking(b) ? "Property" : "Provider";
}

/**
 * The seller name to display on receipts, modals, etc. For stays this is
 * the listing name (the property the customer paid). For services/transport
 * this is the provider's display name.
 */
export function getBookingSellerName(b: BookingShape): string | null {
  if (isStayBooking(b)) {
    return b.listingName || b.providerName || null;
  }
  return b.providerName || b.listingName || null;
}

/**
 * Should the booking card show a "by <provider>" byline beneath the title?
 *
 * - For stays: NO. The card already shows the property name; "by Super
 *   Cleanings" only confuses. The seller is the property.
 * - For transport: NO. The listing title IS the driver/vehicle the
 *   customer hired ("Sridatta" / "Hyderabad Premium Cabs"). Surfacing
 *   the provider_profile's display_name beneath it leaks unrelated
 *   branding — a host who also runs a salon shows up as
 *   "by Truefitt & Hill" under a Driver Hourly booking, which is
 *   actively misleading.
 * - For services: YES, when the provider's name is different from the
 *   listing title (otherwise it's redundant). E.g. "AC Repair · by
 *   AC Doctor" is meaningful; the service category isn't a seller name
 *   on its own.
 */
export function shouldShowProviderByline(b: BookingShape): boolean {
  if (!b.providerName) return false;
  if (isStayBooking(b)) return false;
  if (isTransportBooking(b)) return false;
  if (b.providerName === b.listingName) return false;
  return true;
}
