/**
 * @deprecated for booking tax invoices.
 *
 * The legacy client-rendered HTML invoice did not include the platform fee,
 * GST split, vendor / platform GSTIN, or cancellation policy that India tax
 * law expects on a booking invoice. All booking-invoice downloads now go
 * through the server-rendered PDF endpoint:
 *
 *     GET /api/bookings/:id/invoice.pdf
 *
 * Use `downloadBookingTaxInvoice(bookingId)` from `@/lib/booking-invoice`
 * for any booking-related invoice download. This module is kept only as a
 * loud failure point so a future regression that imports the old API stops
 * the build / fails fast at runtime instead of silently producing a
 * non-compliant receipt.
 */

import type { Booking } from "@/types/domain";

const DEPRECATION_MESSAGE =
  "downloadBookingInvoice is deprecated for booking tax invoices. " +
  "Use downloadBookingTaxInvoice from '@/lib/booking-invoice' instead — " +
  "it fetches the GST-compliant PDF from GET /api/bookings/:id/invoice.pdf.";

export function downloadBookingInvoice(_booking: Booking, _opts?: { guestName?: string; guestEmail?: string }): never {
  // Fail loudly so a stray re-import surfaces in dev / CI rather than
  // silently producing a missing-platform-fee receipt in prod.
  throw new Error(DEPRECATION_MESSAGE);
}
