import PDFDocument from 'pdfkit';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../common/errors/app-error.js';
import { bookingsRepository } from '../repositories/bookings.repository.js';
import { dbQuery } from '../../../common/repositories/database.js';
import { config } from '../../../common/config/index.js';
import { computePricingBreakdown, formatRupees as rupees, formatINR } from './pricing-breakdown.js';
import { computeInvoiceLines, type BookingCategory } from './invoice-pricing.js';
import { describeCancellationPolicy } from './cancellation-policy.js';

/** Human-facing booking reference — mirrors the DB's generated
 *  `bookings.booking_reference` column (migration 20260718010000) and the
 *  web/mobile `displayRef` helpers: first 16 hex chars of the UUID, upper. */
const bookingReference = (id: unknown): string => String(id).replace(/-/g, '').slice(0, 16).toUpperCase();

/**
 * Renders a GST-compliant invoice PDF for a paid/completed booking.
 * Layout is intentionally simple: provider header (with GSTIN if present),
 * customer line, single line item derived from the booking, then a tax break-up
 * (CGST 9% + SGST 9% on the taxable value) and total.
 *
 * GST treatment: the booking's agreed_price_paise is treated as the gross
 * (tax-inclusive) amount the customer paid; we back out the taxable value so
 * the totals always reconcile to what was charged.
 */
export class InvoiceService {
  async render(bookingId: string, userId: string): Promise<{ pdf: Buffer; filename: string }> {
    const result = await bookingsRepository.getAccessibleBookingById(bookingId, userId);
    const booking = result.rows[0] as Record<string, any> | undefined;
    if (!booking) throw new NotFoundError('Booking', bookingId);

    if (String(booking.user_id) !== String(userId)) {
      throw new ForbiddenError('Invoices can only be downloaded by the booking customer.');
    }

    // The invoice is owed whenever a completed payment exists for this
    // booking — regardless of where the booking sits in its lifecycle
    // (cancelled bookings still have valid invoices for the paid period;
    // 'pending' is a stale-read window during the post-confirm race when
    // the SES worker fires before the confirm commit has propagated).
    const status = String(booking.status || '');
    if (status !== 'completed' && status !== 'confirmed' && status !== 'in_progress'
        && status !== 'pending' && status !== 'cancelled') {
      throw new ValidationError('Invoice is only available for paid/completed bookings.');
    }
    // Require a completed payment — that's the real "paid" signal.
    const paidCheck = await dbQuery<{ id: string }>(
      `SELECT id FROM payments WHERE booking_id = $1 AND status = 'completed' LIMIT 1`,
      [String(booking.id)],
    );
    if (!paidCheck.rows[0]) {
      throw new ValidationError('Invoice is only available for paid bookings.');
    }

    // Some environments haven't received the provider_profiles.metadata
    // column yet — fall back to a metadata-less query so the invoice still
    // renders (just without a GSTIN line).
    let providerRow: Record<string, any> | undefined;
    if (booking.provider_id) {
      try {
        providerRow = (await dbQuery<Record<string, any>>(
          'SELECT display_name, metadata FROM provider_profiles WHERE id = $1 LIMIT 1',
          [String(booking.provider_id)],
        )).rows[0];
      } catch {
        providerRow = (await dbQuery<Record<string, any>>(
          'SELECT display_name FROM provider_profiles WHERE id = $1 LIMIT 1',
          [String(booking.provider_id)],
        )).rows[0];
      }
    }
    const gstin = providerRow?.metadata?.gstin ? String(providerRow.metadata.gstin) : null;

    // Pull the listing to apply category-aware GST rules (stays vs transport
    // vs services). Tolerate older schemas that don't yet expose listing_type.
    let listingRow: Record<string, any> | undefined;
    let listingName: string | null = null;
    if (booking.listing_id) {
      try {
        listingRow = (await dbQuery<Record<string, any>>(
          `SELECT name, category, listing_type, price_per_night, property_type,
                  location, city, state, country, metadata,
                  COALESCE(cancellation_policy, 'flexible') AS cancellation_policy
             FROM listings WHERE id = $1 LIMIT 1`,
          [String(booking.listing_id)],
        )).rows[0];
      } catch {
        listingRow = (await dbQuery<Record<string, any>>(
          'SELECT name, category, price_per_night, property_type FROM listings WHERE id = $1 LIMIT 1',
          [String(booking.listing_id)],
        )).rows[0];
      }
      listingName = listingRow?.name ? String(listingRow.name) : null;
    }

    // Room type — for stays the customer expects to see "Deluxe Twin" etc.
    let roomTypeName: string | null = null;
    if (booking.room_type_id) {
      try {
        const r = await dbQuery<Record<string, any>>(
          'SELECT name FROM listing_room_types WHERE id = $1 LIMIT 1',
          [String(booking.room_type_id)],
        );
        roomTypeName = r.rows[0]?.name ? String(r.rows[0].name) : null;
      } catch { /* table may be missing on legacy schemas */ }
    }

    // Check-out date + guest name + guest count come from booking.notes JSON
    // (set by BookingModal). Parse defensively.
    let checkOutDate: string | null = null;
    let guestNameFromNotes: string | null = null;
    let guestCountFromNotes: number | null = null;
    try {
      const parsed = booking.notes ? JSON.parse(String(booking.notes)) : null;
      if (parsed?.checkOut) checkOutDate = String(parsed.checkOut).slice(0, 10);
      if (parsed?.guestName && parsed.guestName !== 'User') guestNameFromNotes = String(parsed.guestName);
      const g = Number(parsed?.guests ?? parsed?.guestCount ?? parsed?.adults);
      if (Number.isFinite(g) && g > 0) guestCountFromNotes = g;
    } catch { /* free-text notes */ }
    const checkInDate = booking.scheduled_date ? String(booking.scheduled_date).slice(0, 10) : null;
    const bookedOnLabel = booking.created_at
      ? new Date(booking.created_at).toLocaleString('en-IN', {
          day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
        })
      : null;
    const guestNameSnapshot = typeof booking.guest_name_snapshot === 'string' && booking.guest_name_snapshot.trim()
      ? String(booking.guest_name_snapshot).trim()
      : null;
    const guestCount = booking.guest_count != null && Number.isFinite(Number(booking.guest_count))
      ? Number(booking.guest_count)
      : guestCountFromNotes;
    const roomTypeSnapshot = typeof booking.room_type_name_snapshot === 'string' && booking.room_type_name_snapshot.trim()
      ? String(booking.room_type_name_snapshot).trim()
      : null;
    // Number of physical rooms billed on this booking. Defaults to 1 for
    // legacy rows pre-dating the room_count column.
    const roomCount = booking.room_count != null && Number.isFinite(Number(booking.room_count))
      ? Math.max(1, Math.round(Number(booking.room_count)))
      : 1;
    const nights = (() => {
      if (!checkInDate || !checkOutDate) return null;
      const ms = new Date(`${checkOutDate}T00:00:00`).getTime() - new Date(`${checkInDate}T00:00:00`).getTime();
      const n = Math.round(ms / (1000 * 60 * 60 * 24));
      return n > 0 ? n : null;
    })();
    const guestName = guestNameSnapshot || booking.guest_name || guestNameFromNotes || 'Guest';
    const hotelAddress = listingRow
      ? [listingRow.location, listingRow.city, listingRow.state]
          .filter((p) => typeof p === 'string' && p.trim().length > 0)
          .join(', ')
      : '';
    const cancellationPolicy = (listingRow?.cancellation_policy as 'flexible' | 'moderate' | 'strict') || 'flexible';

    // Seller name on the invoice.
    //
    // For STAYS, the customer paid the hotel/homestay — "Trident Hotels" is
    // the seller they recognise. The provider_profile underneath is an
    // operational concept (who manages the listing / receives payouts) and
    // often has a label that has nothing to do with the actual property
    // (we've seen "Super Cleanings" attached to a hotel in staging seed
    // data). Showing that label as the seller is confusing at best and
    // wrong on a tax invoice. So for stays, prefer the listing's own name.
    //
    // For SERVICES and TRANSPORT, the provider IS the seller — "AC Doctor"
    // is who you booked, not the abstract category. Keep the existing
    // behaviour there.
    const isStay = String(listingRow?.listing_type || '').toLowerCase() === 'stay'
      || /^(hotel|homestay|stay)/i.test(String(booking.service_category || ''));
    const isTransport = !isStay
      && (String(listingRow?.listing_type || '').toLowerCase() === 'transport'
        || /^driver-/i.test(String(booking.service_category || '')));
    const isService = !isStay && !isTransport;
    // FROM/Provider name on the invoice: prefer the specific LISTING's
    // name over the provider profile's display_name. A single provider
    // account can host multiple listings (e.g. "Truefitt & Hill" +
    // "Smart Cuts") — the provider_profiles.display_name field is
    // shared across them and gets overwritten on every listing create,
    // so falling back to it FIRST would mis-bill an older listing
    // under the newest one's name. The listing name is the contextual,
    // immutable identity for the row being invoiced.
    const providerName = isStay
      ? (listingName || booking.listing_name || booking.provider_name || providerRow?.display_name || 'Listing')
      : (listingName || booking.listing_name || booking.provider_name || providerRow?.display_name || 'Provider');

    // Transport details parsed out of booking.notes JSON (set by TransportBooking.tsx).
    // Service details follow the same convention. Both are best-effort —
    // missing fields render with a graceful "—" placeholder in their cells.
    let routeDetails: {
      pickup?: string;
      drop?: string;
      vehicleType?: string;
      estimatedKm?: number;
      passengers?: number;
      selectedSlots?: string[];
      mode?: string;
      durationHours?: number;
      days?: number;
      packageId?: string;
      packageName?: string;
    } = {};
    let serviceDetails: {
      location?: string;
      duration?: string;
      addOns?: Array<{ label: string; price: number }>;
      /** Selected services-catalog group name (e.g. "Women's Haircut") when
       *  the listing has multiple bookable services and the customer picked
       *  one at checkout. Surfaces on the invoice line item + base-charge row
       *  so it's clear which service was billed rather than just the salon's
       *  business name. Empty/undefined for legacy listings without a catalog. */
      serviceName?: string;
    } = {};
    try {
      const parsed = booking.notes ? JSON.parse(String(booking.notes)) : null;
      if (parsed && typeof parsed === 'object') {
        if (isTransport) {
          routeDetails = {
            pickup: typeof parsed.pickup === 'string' ? parsed.pickup : undefined,
            drop: typeof parsed.drop === 'string' ? parsed.drop : undefined,
            vehicleType: typeof parsed.vehicleType === 'string' ? parsed.vehicleType : undefined,
            estimatedKm: typeof parsed.estimatedKm === 'number' ? parsed.estimatedKm : undefined,
            passengers: typeof parsed.passengers === 'number' && parsed.passengers > 0 ? parsed.passengers : undefined,
            selectedSlots: Array.isArray(parsed.selectedSlots)
              ? parsed.selectedSlots.filter((s: unknown): s is string => typeof s === 'string')
              : undefined,
            mode: typeof parsed.mode === 'string'
              ? parsed.mode
              : (typeof parsed.transportMode === 'string' ? parsed.transportMode : undefined),
            durationHours: typeof parsed.durationHours === 'number' && parsed.durationHours > 0
              ? parsed.durationHours
              : undefined,
            days: typeof parsed.days === 'number' && parsed.days > 0 ? Math.round(parsed.days) : undefined,
            packageId: typeof parsed.packageId === 'string' ? parsed.packageId : undefined,
          };
        }
        if (isService) {
          const hoursRaw = typeof parsed.hours === 'number' ? parsed.hours
            : (typeof parsed.serviceHours === 'number' ? parsed.serviceHours : undefined);
          const rawAddOns: unknown[] = Array.isArray(parsed.addOns) ? parsed.addOns : [];
          const addOns = rawAddOns.length > 0
            ? rawAddOns
                .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
                .map((a: Record<string, unknown>) => ({
                  label: typeof a.label === 'string' ? a.label : '',
                  price: Number(a.price ?? 0),
                }))
                .filter((a: { label: string; price: number }) => a.label.length > 0 && Number.isFinite(a.price) && a.price >= 0)
            : undefined;
          // Selected services-catalog group name persisted by the booking
          // modal (multi-group listings only). Trimmed + emptied → undefined
          // so the downstream check stays a simple truthy test.
          const rawServiceName = typeof parsed.selectedServiceName === 'string'
            ? parsed.selectedServiceName.trim()
            : '';
          serviceDetails = {
            location: typeof parsed.location === 'string'
              ? parsed.location
              : (typeof parsed.address === 'string'
                  ? parsed.address
                  : (typeof parsed.serviceAddress === 'string' ? parsed.serviceAddress : undefined)),
            duration: typeof parsed.duration === 'string'
              ? parsed.duration
              : (typeof hoursRaw === 'number' && hoursRaw > 0
                  ? `${hoursRaw} hour${hoursRaw === 1 ? '' : 's'}`
                  : undefined),
            addOns: addOns && addOns.length > 0 ? addOns : undefined,
            serviceName: rawServiceName.length > 0 ? rawServiceName : undefined,
          };
        }
      }
    } catch { /* notes may be free text */ }

    // Resolve the tour-package display name from listing metadata so the
    // invoice shows the human label, not the raw id. Best-effort.
    if (isTransport && routeDetails.packageId && listingRow?.metadata) {
      try {
        const meta = listingRow.metadata as Record<string, unknown>;
        const opts = Array.isArray(meta?.packageOptions) ? meta.packageOptions as Array<Record<string, unknown>> : [];
        const match = opts.find((p, i) => {
          const id = typeof p.id === 'string' ? p.id : `pkg-${i}`;
          return id === routeDetails.packageId;
        });
        const name = match && typeof match.name === 'string' ? match.name.trim() : '';
        if (name) routeDetails.packageName = name;
      } catch { /* leave packageName undefined */ }
    }

    const breakdown = computePricingBreakdown(booking, listingRow, gstin);
    const { gst, interState, customerStateCode, grossPaise, taxablePaise, cgstPaise, sgstPaise, igstPaise } = breakdown;

    // Best-effort payment lookup — surfaces the provider order id, payment id
    // and method on the invoice. Tolerate schema gaps; the invoice still
    // renders if the payments row is missing.
    let paymentRow: Record<string, any> | undefined;
    try {
      paymentRow = (await dbQuery<Record<string, any>>(
        // The "paid at" timestamp is `completed_at` on the payments table —
        // there's no `paid_at` column. The previous version referenced one
        // and the query threw, leaving paymentRow=undefined and the invoice
        // silently falling back to the legacy (no platform-fee) totals path.
        `SELECT id, provider_ref AS provider_order_id, provider_payment_id, method,
                completed_at AS paid_at, amount_paise, status,
                subtotal_paise, platform_fee_paise, taxes_paise, insurance_premium_paise, discount_paise,
                metadata
           FROM payments
          WHERE booking_id = $1 AND status = 'completed'
          ORDER BY completed_at DESC NULLS LAST, created_at DESC
          LIMIT 1`,
        [String(booking.id)],
      )).rows[0];
    } catch {
      paymentRow = undefined;
    }

    // Insurance was introduced after the original payment schema, so older
    // successful payments may have the premium in metadata or the
    // insurance_policies row even when payments.insurance_premium_paise is
    // null. Resolve it once here and feed the renderer a single canonical
    // paise value so the invoice total rows match what the customer paid.
    const insurancePremiumPaiseForInvoice = await (async () => {
      const columnValue = Number(paymentRow?.insurance_premium_paise);
      if (Number.isFinite(columnValue) && columnValue > 0) return Math.round(columnValue);

      const meta = paymentRow?.metadata && typeof paymentRow.metadata === 'object'
        ? paymentRow.metadata as Record<string, any>
        : null;
      const metadataPaise = Number(
        meta?.insurancePremiumPaise
        ?? meta?.feeBreakdown?.insurancePremiumPaise
        ?? 0,
      );
      if (Number.isFinite(metadataPaise) && metadataPaise > 0) return Math.round(metadataPaise);

      const metadataRupees = Number(meta?.insurancePremium ?? 0);
      if (Number.isFinite(metadataRupees) && metadataRupees > 0) {
        return Math.round(metadataRupees * 100);
      }

      try {
        const r = await dbQuery<Record<string, any>>(
          `SELECT premium_amount
             FROM insurance_policies
            WHERE booking_id = $1
            ORDER BY created_at DESC
            LIMIT 1`,
          [String(booking.id)],
        );
        const premiumRupees = Number(r.rows[0]?.premium_amount ?? 0);
        return Number.isFinite(premiumRupees) && premiumRupees > 0
          ? Math.round(premiumRupees * 100)
          : 0;
      } catch {
        return 0;
      }
    })();

    // Single source of truth for the fare math used by BOTH the line-item
    // table and the totals block.
    //
    // Preferred source: completed payments row. Some bookings were created
    // after the booking-breakdown migration but before the payment-breakdown
    // migration, so their payment row has amount/method but NULL fee columns.
    // In that case, use the booking's persisted forward breakdown before
    // falling back to the old inverse-derived taxable subtotal path.
    const invoicePaymentRow = (() => {
      const paymentHasBreakdown = paymentRow
        && paymentRow.subtotal_paise != null
        && paymentRow.platform_fee_paise != null;
      if (paymentHasBreakdown) {
        return {
          ...paymentRow,
          insurance_premium_paise: insurancePremiumPaiseForInvoice,
        };
      }

      const bookingHasBreakdown = booking.subtotal_paise != null
        && booking.platform_fee_paise != null
        && booking.taxes_paise != null;
      if (!bookingHasBreakdown) return paymentRow ?? null;

      const paymentAmount = paymentRow?.amount_paise != null
        ? paymentRow.amount_paise
        : booking.agreed_price_paise;
      return {
        ...(paymentRow ?? {}),
        amount_paise: paymentAmount,
        subtotal_paise: booking.subtotal_paise,
        platform_fee_paise: booking.platform_fee_paise,
        taxes_paise: booking.taxes_paise,
        discount_paise: booking.discount_paise ?? 0,
        insurance_premium_paise: insurancePremiumPaiseForInvoice,
      };
    })();

    // Stored breakdown wins; the legacy tax-inclusive split derived from
    // `agreed_price_paise` is only used when neither payment nor booking rows
    // have the explicit breakdown columns.
    const invoiceCategory: BookingCategory = isStay ? 'stay' : isTransport ? 'transport' : 'service';
    // Cast — invoicePaymentRow is loosely typed because the
    // schema query is dynamic; computeInvoiceLines normalises the shape.
    const lines = computeInvoiceLines((invoicePaymentRow ?? null) as any, breakdown, invoiceCategory);
    const useStoredBreakdown = lines.source === 'stored';
    const lineTaxablePaise = lines.lineTaxablePaise;
    const cgstDisplay = lines.cgstPaise;
    const sgstDisplay = lines.sgstPaise;
    const igstDisplay = lines.igstPaise;

    const pdf = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c as Buffer));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Layout constants. PDFKit uses points (72/inch). A4 = 595 x 842 pt.
      const PAGE_W = 595;
      const MARGIN = 50;
      const RIGHT = PAGE_W - MARGIN;
      const BRAND = '#4f46e5';      // indigo-600 — matches the email header
      const BRAND_DARK = '#3730a3'; // indigo-800
      const INK = '#111827';        // gray-900
      const MUTED = '#6b7280';      // gray-500
      const LINE = '#e5e7eb';       // gray-200
      const PANEL_BG = '#f9fafb';   // gray-50

      const invoiceNumber = `INV-${String(booking.id).slice(0, 8).toUpperCase()}`;
      const issueDate = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      // Line-item / service-panel header. When a services-catalog group was
      // selected at checkout, append it as "{Business} — {Service Name}" so
      // the invoice shows both the business and the specific service billed
      // (a salon listing with men's/women's/kids haircuts otherwise reads
      // identically across the three bookings). Falls through to the legacy
      // listing-name path for stays, transport, and pre-catalog services.
      const baseDescription = booking.listing_name
        || (booking.service_category ? String(booking.service_category).replace(/-/g, ' ') : 'Service')
        || 'Service';
      const description = isService && serviceDetails.serviceName
        ? `${baseDescription} — ${serviceDetails.serviceName}`
        : baseDescription;

      // ───────── Header band ─────────
      doc.rect(0, 0, PAGE_W, 110).fill(BRAND);

      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22)
        .text('IstaSeva', MARGIN, 34, { width: 300 });
      doc.font('Helvetica').fontSize(10).fillColor('rgba(255,255,255,0.85)' as any)
        .text("India's trusted services marketplace", MARGIN, 62);

      doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff')
        .text('TAX INVOICE', MARGIN, 30, { width: RIGHT - MARGIN, align: 'right' });
      doc.font('Helvetica').fontSize(10).fillColor('#ffffff')
        .text(`Invoice No.  ${invoiceNumber}`, MARGIN, 62, { width: RIGHT - MARGIN, align: 'right' })
        .text(`Issue Date    ${issueDate}`, MARGIN, 78, { width: RIGHT - MARGIN, align: 'right' });

      // ───────── "Booking Confirmed" status pill (MMT-style) ─────────
      doc.save();
      const pillW = 138;
      const pillX = MARGIN;
      const pillY = 122;
      doc.roundedRect(pillX, pillY, pillW, 22, 11).fill('#dcfce7');
      doc.fillColor('#166534').font('Helvetica-Bold').fontSize(10)
        .text('✓  Booking Confirmed', pillX + 12, pillY + 6, { width: pillW - 24 });
      doc.restore();

      // ───────── Parties (From / Bill To) ─────────
      const partyTop = 156;
      const colW = (RIGHT - MARGIN - 20) / 2;
      const drawParty = (x: number, label: string, lines: Array<string | null | undefined>) => {
        doc.roundedRect(x, partyTop, colW, 100, 4).fillAndStroke(PANEL_BG, LINE);
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9)
          .text(label.toUpperCase(), x + 14, partyTop + 12, { characterSpacing: 1 });
        doc.fillColor(INK).font('Helvetica').fontSize(10);
        let yy = partyTop + 30;
        for (const line of lines) {
          if (!line) continue;
          doc.text(line, x + 14, yy, { width: colW - 28 });
          yy = doc.y + 2;
        }
      };

      drawParty(MARGIN, 'From', [
        providerName,
        gstin ? `GSTIN: ${gstin}` : null,
        'Listed via IstaSeva (istaseva.com)',
      ]);
      drawParty(MARGIN + colW + 20, 'Bill To', [
        guestName,
        booking.address ? String(booking.address) : null,
        booking.metadata?.customer_gstin ? `GSTIN: ${booking.metadata.customer_gstin}` : null,
      ]);

      // ───────── Booking Details panel (MMT-style) ─────────
      // For stays we render a richer two-column block (hotel/address + dates +
      // room + guests). For services/transport we collapse to a 3-cell strip
      // since none of the stay-specific fields apply.
      const stripY = partyTop + 115;
      let tableTop: number;

      if (isStay) {
        const panelH = 140;
        doc.roundedRect(MARGIN, stripY, RIGHT - MARGIN, panelH, 6).fillAndStroke('#ffffff', LINE);
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9)
          .text('BOOKING DETAILS', MARGIN + 14, stripY + 12, { characterSpacing: 1 });

        const rowLabel = (label: string, value: string, x: number, y: number, w: number) => {
          doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
            .text(label.toUpperCase(), x, y, { width: w, characterSpacing: 0.5 });
          doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
            .text(value, x, y + 11, { width: w, ellipsis: true });
        };

        const colLeft = MARGIN + 14;
        const colRight = MARGIN + (RIGHT - MARGIN) / 2 + 8;
        const colWLeft = (RIGHT - MARGIN) / 2 - 22;
        const colWRight = (RIGHT - MARGIN) / 2 - 22;

        rowLabel('Hotel', providerName, colLeft, stripY + 30, colWLeft);
        if (hotelAddress) {
          doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
            .text(hotelAddress, colLeft, stripY + 56, { width: colWLeft });
        }
        const checkInLabel = checkInDate
          ? `${checkInDate}  ·  03:00 PM`
          : '—';
        const checkOutLabel = checkOutDate
          ? `${checkOutDate}  ·  12:00 PM`
          : '—';
        rowLabel('Check-In', checkInLabel, colRight, stripY + 30, colWRight);
        rowLabel('Check-Out', checkOutLabel, colRight, stripY + 60, colWRight);

        const bottomY = stripY + 92;
        const cellW = (RIGHT - MARGIN - 28) / 4;
        rowLabel('Booking Ref', bookingReference(booking.id), colLeft, bottomY, cellW);
        rowLabel('Duration', nights ? `${nights} Night${nights === 1 ? '' : 's'}` : '—', colLeft + cellW, bottomY, cellW);
        rowLabel('Guests', guestCount ? String(guestCount) : '—', colLeft + cellW * 2, bottomY, cellW);
        // Append "× N" to the room type label when the guest booked
        // multiple rooms of the same type (e.g. "Non-AC × 3"). Single-room
        // bookings keep the bare label unchanged.
        const roomTypeLabel = (() => {
          const base = roomTypeSnapshot || roomTypeName || '—';
          return roomCount > 1 ? `${base} × ${roomCount}` : base;
        })();
        rowLabel('Room Type', roomTypeLabel, colLeft + cellW * 3, bottomY, cellW);
        if (bookedOnLabel) {
          doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
            .text(`Booked On: ${bookedOnLabel}`, colLeft, stripY + 126, { width: colWLeft + colWRight });
        }

        tableTop = stripY + panelH + 22;
      } else if (isTransport) {
        // ───────── Transport panel ─────────
        // Two-column block: provider/vehicle on the left, pickup/drop/scheduled
        // on the right. Bottom row mirrors stays — Booking Ref, Distance,
        // Vehicle, Passenger so the panel feels consistent across categories.
        const panelH = 140;
        doc.roundedRect(MARGIN, stripY, RIGHT - MARGIN, panelH, 6).fillAndStroke('#ffffff', LINE);
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9)
          .text('TRIP DETAILS', MARGIN + 14, stripY + 12, { characterSpacing: 1 });

        const rowLabel = (label: string, value: string, x: number, y: number, w: number) => {
          doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
            .text(label.toUpperCase(), x, y, { width: w, characterSpacing: 0.5 });
          doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
            .text(value, x, y + 11, { width: w, ellipsis: true });
        };

        const colLeft = MARGIN + 14;
        const colRight = MARGIN + (RIGHT - MARGIN) / 2 + 8;
        const colWLeft = (RIGHT - MARGIN) / 2 - 22;
        const colWRight = (RIGHT - MARGIN) / 2 - 22;

        rowLabel('Provider', providerName, colLeft, stripY + 30, colWLeft);
        rowLabel('Vehicle', routeDetails.vehicleType || '—', colLeft, stripY + 60, colWLeft);

        rowLabel('Pickup', routeDetails.pickup || '—', colRight, stripY + 30, colWRight);
        rowLabel('Drop', routeDetails.drop || '—', colRight, stripY + 60, colWRight);

        const bottomY = stripY + 92;
        const cellW = (RIGHT - MARGIN - 28) / 4;
        rowLabel('Booking Ref', bookingReference(booking.id), colLeft, bottomY, cellW);
        // Multi-day rentals: format as "May 27 – May 29 (3 days)" so the
        // invoice matches the booking-confirmation email's date range. Same-day
        // rentals (end_date null OR = scheduled_date) keep the original
        // "YYYY-MM-DD" cell unchanged. end_date is stored EXCLUSIVE (matches
        // stay convention) — subtract one day for the inclusive last-rental-day.
        const pickupDateLabel = (() => {
          const startStr = booking.scheduled_date ? String(booking.scheduled_date).slice(0, 10) : '';
          if (!startStr) return '—';
          const endRaw = (booking as { end_date?: string | Date | null }).end_date;
          const endStr = endRaw ? (endRaw instanceof Date ? endRaw.toISOString().slice(0, 10) : String(endRaw).slice(0, 10)) : '';
          if (!endStr || endStr <= startStr) return startStr;
          const lastDay = new Date(`${endStr}T00:00:00Z`);
          lastDay.setUTCDate(lastDay.getUTCDate() - 1);
          const lastStr = lastDay.toISOString().slice(0, 10);
          const days = Math.round((new Date(`${endStr}T00:00:00Z`).getTime() - new Date(`${startStr}T00:00:00Z`).getTime()) / 86400000);
          return `${startStr} – ${lastStr} (${days} day${days === 1 ? '' : 's'})`;
        })();
        rowLabel('Pickup Date', pickupDateLabel, colLeft + cellW, bottomY, cellW);
        // Passengers is more useful than Distance for hourly/day/package
        // bookings; fall back to Distance for legacy bookings where the
        // customer never picked a headcount.
        if (routeDetails.passengers && routeDetails.passengers > 0) {
          rowLabel('Passengers', `${routeDetails.passengers}`, colLeft + cellW * 2, bottomY, cellW);
        } else {
          rowLabel('Distance', routeDetails.estimatedKm ? `~${routeDetails.estimatedKm} km` : '—', colLeft + cellW * 2, bottomY, cellW);
        }
        rowLabel('Passenger', String(guestName || '—'), colLeft + cellW * 3, bottomY, cellW);
        if (bookedOnLabel) {
          doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
            .text(`Booked On: ${bookedOnLabel}`, colLeft, stripY + 126, { width: colWLeft + colWRight });
        }
        // Slots picked from the day strip — rendered as a single
        // free-text line below the booking panel so we don't need to
        // restructure the grid. Mode-specific extras (booking time slot,
        // hours, days, package) follow on the same caption strip so an
        // hourly booking shows "Booking time: 14:00 – 17:00 · Hours: 3"
        // and a package booking shows the package name.
        let extraPanelHeight = 0;
        const transportCaption: string[] = [];
        const startStr = booking.start_time ? String(booking.start_time).slice(0, 5) : '';
        const endStr = booking.end_time ? String(booking.end_time).slice(0, 5) : '';
        if (startStr || endStr) {
          transportCaption.push(`Booking time: ${startStr || '—'}${endStr ? ' – ' + endStr : ''}`);
        }
        if (typeof routeDetails.durationHours === 'number' && routeDetails.durationHours > 0) {
          transportCaption.push(`Hours: ${routeDetails.durationHours}`);
        }
        if (typeof routeDetails.days === 'number' && routeDetails.days > 0) {
          transportCaption.push(`Days: ${routeDetails.days}`);
        }
        if (routeDetails.packageName || routeDetails.packageId) {
          transportCaption.push(`Package: ${routeDetails.packageName || routeDetails.packageId}`);
        }
        if (transportCaption.length > 0) {
          doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
            .text(transportCaption.join('  ·  '), colLeft, stripY + panelH + 6, { width: RIGHT - MARGIN - 28 });
          extraPanelHeight += 18;
        }
        if (Array.isArray(routeDetails.selectedSlots) && routeDetails.selectedSlots.length > 0) {
          doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
            .text(
              `Slots booked: ${routeDetails.selectedSlots.slice().sort().join(', ')}`,
              colLeft,
              stripY + panelH + 6 + extraPanelHeight,
              { width: RIGHT - MARGIN - 28 },
            );
          extraPanelHeight += 18;
        }

        tableTop = stripY + panelH + 22 + extraPanelHeight;
      } else if (isService) {
        // ───────── Service panel ─────────
        // Service name + provider on the left, scheduled date + location on
        // the right. Bottom row: Booking Ref, Quantity, Duration, Customer.
        const panelH = 140;
        doc.roundedRect(MARGIN, stripY, RIGHT - MARGIN, panelH, 6).fillAndStroke('#ffffff', LINE);
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9)
          .text('SERVICE DETAILS', MARGIN + 14, stripY + 12, { characterSpacing: 1 });

        const rowLabel = (label: string, value: string, x: number, y: number, w: number) => {
          doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
            .text(label.toUpperCase(), x, y, { width: w, characterSpacing: 0.5 });
          doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
            .text(value, x, y + 11, { width: w, ellipsis: true });
        };

        const colLeft = MARGIN + 14;
        const colRight = MARGIN + (RIGHT - MARGIN) / 2 + 8;
        const colWLeft = (RIGHT - MARGIN) / 2 - 22;
        const colWRight = (RIGHT - MARGIN) / 2 - 22;

        rowLabel('Service', description, colLeft, stripY + 30, colWLeft);
        rowLabel('Provider', providerName, colLeft, stripY + 60, colWLeft);

        // Include both start and end times so the service provider sees
        // the exact window booked, not just the opening time.
        const sStart = booking.start_time ? String(booking.start_time).slice(0, 5) : '';
        const sEnd = booking.end_time ? String(booking.end_time).slice(0, 5) : '';
        const sWindow = sStart && sEnd
          ? `  ·  ${sStart} – ${sEnd}`
          : (sStart ? `  ·  ${sStart}` : '');
        const scheduledLabel = booking.scheduled_date
          ? `${String(booking.scheduled_date).slice(0, 10)}${sWindow}`
          : '—';
        rowLabel('Scheduled', scheduledLabel, colRight, stripY + 30, colWRight);
        rowLabel('Location', serviceDetails.location || '—', colRight, stripY + 60, colWRight);

        const bottomY = stripY + 92;
        const cellW = (RIGHT - MARGIN - 28) / 4;
        rowLabel('Booking Ref', bookingReference(booking.id), colLeft, bottomY, cellW);
        rowLabel('Duration', serviceDetails.duration || '—', colLeft + cellW, bottomY, cellW);
        rowLabel('Place of Supply', interState ? `Inter-state${customerStateCode ? ' (' + customerStateCode + ')' : ''}` : 'Intra-state', colLeft + cellW * 2, bottomY, cellW);
        rowLabel('Customer', String(guestName || '—'), colLeft + cellW * 3, bottomY, cellW);
        if (bookedOnLabel) {
          doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
            .text(`Booked On: ${bookedOnLabel}`, colLeft, stripY + 126, { width: colWLeft + colWRight });
        }

        tableTop = stripY + panelH + 22;
      } else {
        // Fallback compact strip for any category that didn't match — keeps
        // the layout coherent rather than collapsing the page.
        doc.roundedRect(MARGIN, stripY, RIGHT - MARGIN, 36, 4).fillAndStroke('#ffffff', LINE);
        const cellW = (RIGHT - MARGIN) / 4;
        const drawCell = (i: number, label: string, value: string) => {
          const cx = MARGIN + i * cellW + 14;
          doc.fillColor(MUTED).font('Helvetica').fontSize(8)
            .text(label.toUpperCase(), cx, stripY + 6, { characterSpacing: 0.8 });
          doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
            .text(value, cx, stripY + 18, { width: cellW - 14, ellipsis: true });
        };
        drawCell(0, 'Booking Ref', bookingReference(booking.id));
        drawCell(1, 'Service Date', String(booking.scheduled_date || '').slice(0, 10) || '—');
        drawCell(2, 'Place of Supply', interState ? `Inter-state (${customerStateCode || '—'})` : 'Intra-state');
        drawCell(3, 'Status', String(booking.status || '').toUpperCase() || 'CONFIRMED');
        tableTop = stripY + 60;
      }

      // ───────── Line-items table ─────────
      // Columns are right-aligned for RATE and AMOUNT with a visible gap
      // between them, so long INR amounts (₹1,117.86) don't bleed into the
      // next column. Earlier layout overlapped because RATE was left-aligned
      // in a 109-pt window flush against AMOUNT.
      const colDesc = MARGIN + 12;             // 62 — DESCRIPTION left edge
      const colHsn = 300;                       // SAC left edge
      const colQty = 350;                       // QTY left edge
      const colRate = 380;                      // RATE column left edge (right-aligned)
      const colRateW = 80;                      //   width
      const colAmtX = 470;                      // AMOUNT column left edge (right-aligned)
      const colAmtW = RIGHT - 12 - colAmtX;     //   width

      doc.rect(MARGIN, tableTop, RIGHT - MARGIN, 26).fill(BRAND_DARK);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
      doc.text('DESCRIPTION', colDesc, tableTop + 9, { width: colHsn - colDesc - 8 });
      doc.text('SAC', colHsn, tableTop + 9, { width: colQty - colHsn - 4 });
      doc.text('QTY', colQty, tableTop + 9, { width: colRate - colQty - 4 });
      doc.text('RATE', colRate, tableTop + 9, { width: colRateW, align: 'right' });
      doc.text('AMOUNT', colAmtX, tableTop + 9, { width: colAmtW, align: 'right' });

      // Line-item table — single descriptive row showing the booked service.
      // The explicit fee / discount / GST / insurance breakdown lives in the
      // totals block below (per spec, and matching the confirmation email),
      // so we deliberately don't surface the platform fee a second time here.
      // Amount = base subtotal (stay/service/fare), which is the customer's
      // primary charge. Legacy bookings fall back to the inverse-derived
      // taxable value since stored subtotal isn't available.
      const hostLinePaise = lines.source === 'stored' ? lines.subtotalPaise : lines.lineTaxablePaise;
      // Stays with multi-room bookings (e.g. 3 Non-AC rooms × 2 nights)
      // surface the room count in the QTY column and a per-room RATE so
      // the line item reads "₹X × 3 = ₹3X" — matching what the guest
      // selected on the booking modal. Services / transport keep QTY=1.
      const isStayRow = isStay && roomCount > 1;
      const qtyText = isStayRow ? String(roomCount) : '1';
      const rateLinePaise = isStayRow ? Math.round(hostLinePaise / roomCount) : hostLinePaise;

      const rowY = tableTop + 38;
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(11)
        .text(String(description), colDesc, rowY, { width: colHsn - colDesc - 8 });
      const addOnsSummary = serviceDetails.addOns && serviceDetails.addOns.length > 0
        ? ` · includes ${serviceDetails.addOns.map((a) => `+ ${a.label}`).join(', ')}`
        : '';
      const subLabel = isStayRow
        ? `${gst.label}${nights ? ` — ${nights} night${nights === 1 ? '' : 's'} × ${roomCount} room${roomCount === 1 ? '' : 's'}` : ` — ${roomCount} room${roomCount === 1 ? '' : 's'}`}`
        : `${gst.label}${addOnsSummary}`;
      doc.font('Helvetica').fontSize(9).fillColor(MUTED)
        .text(subLabel, colDesc, doc.y + 2, { width: colHsn - colDesc - 8 });
      doc.fillColor(INK).font('Helvetica').fontSize(10);
      doc.text(gst.hsn, colHsn, rowY, { width: colQty - colHsn - 4 });
      doc.text(qtyText, colQty, rowY, { width: colRate - colQty - 4 });
      doc.text(rupees(rateLinePaise), colRate, rowY, { width: colRateW, align: 'right' });
      doc.text(rupees(hostLinePaise), colAmtX, rowY, { width: colAmtW, align: 'right' });

      const tableBottom = Math.max(doc.y, rowY + 32) + 10;
      doc.moveTo(MARGIN, tableBottom).lineTo(RIGHT, tableBottom).strokeColor(LINE).lineWidth(1).stroke();

      // ───────── Totals ─────────
      const totalsRight = RIGHT - 12;
      const totalsLeft = 340;
      const halfRatePct = (gst.rate / 2 * 100).toFixed(gst.rate === 0.05 ? 1 : 0);
      const fullRatePct = (gst.rate * 100).toFixed(gst.rate === 0.05 ? 0 : 0);
      let ty = tableBottom + 14;
      const totalsRow = (label: string, value: string, opts?: { bold?: boolean; muted?: boolean; size?: number }) => {
        doc.font(opts?.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts?.size ?? 10)
          .fillColor(opts?.muted ? MUTED : INK);
        doc.text(label, totalsLeft, ty);
        doc.text(value, MARGIN, ty, { width: totalsRight - MARGIN, align: 'right' });
        ty += (opts?.size ?? 10) + 8;
      };
      // Totals use the SAME `lines` object that drove the line-item table so
      // the math reconciles exactly to `amount_paise`. The helper guarantees
      // CGST + SGST = taxes (rounding absorbed into SGST), and that the parts
      // sum to the grand total whether we're on the stored or legacy path.
      if (lines.source === 'stored') {
        // Explicit per-row breakdown — same shape as the confirmation email's
        // Fare Summary. Each component the customer was charged for has its
        // own line so nothing is hidden inside an aggregated "Subtotal".
        // Reconciliation: subtotal − discount + platformFee + taxes + insurance == total.
        const discountedBase = Math.max(0, lines.subtotalPaise - lines.discountPaise);
        const platformPct = discountedBase > 0
          ? Math.round((lines.platformFeePaise * 100) / discountedBase)
          : 0;
        // For services that have add-ons snapshotted in notes, split the base
        // row so the customer sees what they paid for: "Service charge ₹X"
        // followed by one row per "+ Add-on ₹Y". The sum reconciles to
        // `lines.subtotalPaise` exactly.
        const isServiceWithAddOns = invoiceCategory === 'service'
          && Array.isArray(serviceDetails.addOns)
          && serviceDetails.addOns.length > 0;
        if (isServiceWithAddOns) {
          const addOnPaiseTotal = serviceDetails.addOns!.reduce((sum, a) => sum + Math.round((a.price || 0) * 100), 0);
          const basePaise = Math.max(0, lines.subtotalPaise - addOnPaiseTotal);
          // Prefer the selected services-catalog group name so the row reads
          // "Women's Haircut ₹1200" instead of the generic "Service charge".
          // Falls back to the generic label for legacy listings.
          const baseRowLabel = serviceDetails.serviceName || 'Service charge';
          totalsRow(baseRowLabel, formatINR(basePaise), { muted: true });
          for (const a of serviceDetails.addOns!) {
            totalsRow(`+ ${a.label}`, formatINR(Math.round((a.price || 0) * 100)), { muted: true });
          }
        } else {
          // No add-ons: still prefer the selected services-catalog group
          // name over the generic baseLabel ("Service charge") when present,
          // so a single-service booking like "Women's Haircut ₹1200" reads
          // the same as in the modal's fare summary.
          const baseRowLabel = invoiceCategory === 'service' && serviceDetails.serviceName
            ? serviceDetails.serviceName
            : lines.baseLabel;
          totalsRow(baseRowLabel, formatINR(lines.subtotalPaise), { muted: true });
        }
        if (lines.platformFeePaise > 0) {
          totalsRow(
            platformPct > 0 ? `Platform Fee (${platformPct}%)` : 'Platform Fee',
            formatINR(lines.platformFeePaise),
            { muted: true },
          );
        }
        if (lines.discountPaise > 0) {
          // Surface the row as "Coupon discount" so the customer can tell
          // it's a coupon credit (not a host markdown). The coupon code
          // itself is on the booking row but we don't surface it here —
          // the post-payment modal + email already echo the code.
          totalsRow('Coupon discount', `- ${formatINR(lines.discountPaise)}`, { muted: true });
        }
        if (interState) {
          totalsRow(`IGST @ ${fullRatePct}%`, formatINR(lines.igstPaise), { muted: true });
        } else {
          totalsRow(`CGST @ ${halfRatePct}%`, formatINR(lines.cgstPaise), { muted: true });
          totalsRow(`SGST @ ${halfRatePct}%`, formatINR(lines.sgstPaise), { muted: true });
        }
        if (lines.insurancePaise > 0) totalsRow('Insurance Premium', formatINR(lines.insurancePaise), { muted: true });
      } else {
        totalsRow('Subtotal (taxable value)', formatINR(lines.subtotalPaise), { muted: true });
        if (interState) {
          totalsRow(`IGST @ ${fullRatePct}%`, formatINR(lines.igstPaise), { muted: true });
        } else {
          totalsRow(`CGST @ ${halfRatePct}%`, formatINR(lines.cgstPaise), { muted: true });
          totalsRow(`SGST @ ${halfRatePct}%`, formatINR(lines.sgstPaise), { muted: true });
        }
      }
      ty += 4;
      doc.moveTo(totalsLeft, ty).lineTo(totalsRight, ty).strokeColor(LINE).stroke();
      ty += 10;

      // Grand total band — `lines.totalPaise` is the customer-charged amount
      // (= amount_paise when the row exists; falls back to gross for legacy).
      doc.rect(totalsLeft, ty - 2, totalsRight - totalsLeft, 30).fill(PANEL_BG);
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(11)
        .text('Total paid', totalsLeft + 10, ty + 7);
      doc.font('Helvetica-Bold').fontSize(13).fillColor(BRAND_DARK)
        .text(formatINR(lines.totalPaise), MARGIN, ty + 6, { width: totalsRight - MARGIN - 10, align: 'right' });
      ty += 38;

      // ───────── Payment details ─────────
      if (paymentRow) {
        const paidLabel = paymentRow.paid_at
          ? new Date(paymentRow.paid_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
          : '—';
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9)
          .text('PAYMENT DETAILS', MARGIN, ty + 6, { characterSpacing: 1 });
        ty += 22;
        doc.fillColor(INK).font('Helvetica').fontSize(9.5);
        const payLines: Array<[string, string]> = [
          ['Status', 'Paid'],
          ['Date', paidLabel],
          ['Method', String(paymentRow.method || 'Online').toString()],
        ];
        if (paymentRow.provider_payment_id) payLines.push(['Reference', String(paymentRow.provider_payment_id)]);
        for (const [k, v] of payLines) {
          doc.fillColor(MUTED).text(k, MARGIN, ty, { width: 80, continued: false });
          doc.fillColor(INK).text(v, MARGIN + 90, ty, { width: 300 });
          ty += 14;
        }
      }

      // ───────── Cancellation Policy box (MMT-style) ─────────
      // Self-service cancel hint appended so customers don't email support
      // to cancel — the dashboard does it instantly and the refund flow is
      // already wired. Matches the receipt-email copy in
      // describeCancellationPolicy() so all three surfaces read the same.
      const policyText = describeCancellationPolicy(cancellationPolicy, checkInDate);
      const policyTop = Math.max(ty + 14, 660);
      const policyHeight = 60;
      doc.roundedRect(MARGIN, policyTop, RIGHT - MARGIN, policyHeight, 6).fillAndStroke('#fffbea', '#fde68a');
      doc.fillColor('#78350f').font('Helvetica-Bold').fontSize(10)
        .text('Cancellation Policy', MARGIN + 14, policyTop + 10);
      doc.font('Helvetica').fontSize(9).fillColor('#78350f')
        .text(policyText, MARGIN + 14, policyTop + 26, { width: RIGHT - MARGIN - 28 });

      // ───────── Footer ─────────
      const footerY = 770;
      doc.moveTo(MARGIN, footerY - 14).lineTo(RIGHT, footerY - 14).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(
        gstin
          ? `${gst.label} (SAC ${gst.hsn}) — GST collected at ${fullRatePct}% ${interState ? 'as IGST (inter-state supply)' : 'as CGST + SGST (intra-state supply)'}.`
          : 'GST not applicable — provider is not GST-registered under the CGST Act.',
        MARGIN, footerY - 6, { width: RIGHT - MARGIN, align: 'left' },
      );
      doc.fillColor(MUTED).fontSize(8).text(
        'This is a system-generated tax invoice and does not require a signature.   ·   Queries: support@istaseva.com',
        MARGIN, footerY + 12, { width: RIGHT - MARGIN, align: 'center' },
      );
      const platformGstin = (config.app as any).platformGstin
        ? String((config.app as any).platformGstin).trim()
        : '';
      const platformLine = platformGstin
        ? `IstaSeva Technologies Pvt. Ltd. (GSTIN: ${platformGstin})  ·  istaseva.com`
        : 'IstaSeva Technologies Pvt. Ltd.  ·  istaseva.com';
      doc.fillColor(MUTED).fontSize(7.5).text(
        platformLine,
        MARGIN, footerY + 28, { width: RIGHT - MARGIN, align: 'center' },
      );

      doc.end();
    });

    return { pdf, filename: `invoice-${bookingReference(booking.id)}.pdf` };
  }
}

export const invoiceService = new InvoiceService();
