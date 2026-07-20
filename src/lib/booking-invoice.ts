/**
 * Booking tax-invoice download.
 *
 * The single approved path for getting a booking's GST-compliant PDF
 * invoice — both Guest and Host/Provider dashboards funnel through this.
 * It hits the server-rendered `GET /api/bookings/:id/invoice.pdf` so every
 * downloaded receipt has the same fee breakdown, GSTINs, cancellation
 * policy, and payment details that the booking-confirmation email shows.
 *
 * Why not the legacy `src/lib/invoice.ts`: that file produces a print-only
 * HTML preview that lacks the platform-fee line, GST split, and provider
 * GSTIN. It's now deprecated for booking invoices.
 */
import { downloadAuthenticatedFile } from "@/lib/api-client";

export async function downloadBookingTaxInvoice(bookingId: string): Promise<void> {
  if (!bookingId) throw new Error("Missing booking id");
  const filename = `invoice-${bookingId.replace(/-/g, "").slice(0, 16).toUpperCase()}.pdf`;
  await downloadAuthenticatedFile(
    `/api/bookings/${encodeURIComponent(bookingId)}/invoice.pdf`,
    filename,
  );
}
