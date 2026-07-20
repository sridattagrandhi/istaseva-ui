/**
 * SES Email Service
 *
 * Sends transactional HTML emails via AWS SES.
 * User email addresses are resolved through Firebase Admin (source of truth for auth).
 * All sends are fire-and-forget — failures are logged but never surface to callers.
 */
import { SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses';
import nodemailer, { type Transporter } from 'nodemailer';
import { sesClient } from '../../../common/aws/clients.js';

/**
 * True when the running server is not in a production-tier deployment.
 * Mirrors the same check `config/index.ts` uses to derive `isProduction`. */
function isProductionEnv(): boolean {
  return config.app.nodeEnv === 'production' || config.app.environment === 'production';
}

/**
 * Resolve the SMTP host. In non-production environments, default to
 * `localhost` (port 1025) when nothing is configured — that's the standard
 * MailPit / MailHog catcher convention, so a developer running
 * `mailpit` (or `mailhog`) locally sees booking-confirmed + booking-
 * cancelled emails land in the same web UI without any code changes.
 * Production must always set SMTP_HOST (or fall through to SES) explicitly
 * — we never invent a default there, since silently emailing localhost
 * from a deployed box would drop transactional mail on the floor. */
function resolveSmtpHost(): string | undefined {
  if (config.notification.smtpHost) return config.notification.smtpHost;
  if (!isProductionEnv()) return 'localhost';
  return undefined;
}
function resolveSmtpPort(): number {
  // When falling back to the dev catcher, MailPit/MailHog both listen on
  // 1025 by default. Honor an explicit SMTP_PORT either way so a dev who
  // runs the catcher on a different port can override.
  if (config.notification.smtpHost) return config.notification.smtpPort;
  if (!isProductionEnv() && config.notification.smtpPort === 587) return 1025;
  return config.notification.smtpPort;
}

// nodemailer transporter — lazily built on first send when SMTP_HOST is set
// in env. Reusing the same transporter across requests lets the underlying
// pool keep connections warm (relevant for SES SMTP — opening a TLS handshake
// per booking confirmation would add ~150ms per email). Cleared on unhandled
// auth errors below so a credential rotation eventually picks up new values.
let smtpTransporter: Transporter | null = null;
function getSmtpTransporter(): Transporter | null {
  const host = resolveSmtpHost();
  if (!host) return null;
  if (smtpTransporter) return smtpTransporter;
  smtpTransporter = nodemailer.createTransport({
    host,
    port: resolveSmtpPort(),
    secure: config.notification.smtpSecure,
    auth: config.notification.smtpUser && config.notification.smtpPass
      ? { user: config.notification.smtpUser, pass: config.notification.smtpPass }
      : undefined,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
  });
  return smtpTransporter;
}
import { config } from '../../../common/config/index.js';
import { logger } from '../../../common/logging/logger.js';
import { dbQuery } from '../../../common/repositories/database.js';

// ─── Firebase Admin lazy init (reused from fcm.service) ───────────────────────
let adminApp: any = null;
async function getAdmin() {
  if (adminApp) return adminApp;
  const { default: admin } = await import('firebase-admin');
  if (admin.apps.length > 0) { adminApp = admin.apps[0]; return adminApp; }
  adminApp = admin.initializeApp();
  return adminApp;
}

/**
 * Resolve a recipient email given a userId.
 *
 * The userId might be any of:
 *   (a) a Firebase UID (guest booking path — passed straight from auth context)
 *   (b) `user_profiles.user_id` (same as Firebase UID for new users)
 *   (c) `provider_profiles.id` (provider primary key — host booking path)
 *   (d) `provider_profiles.user_id` (internal UUID linking host → user_profiles)
 *
 * Strategy:
 *   1. Try user_profiles.user_id directly (fast path — set by auth middleware).
 *   2. Join via provider_profiles in case we were handed a provider UUID.
 *   3. Fall back to Firebase Admin for legacy rows that haven't been denormalized yet.
 */
export async function getUserEmailById(userId: string): Promise<string | null> {
  try {
    // Try every plausible linkage since the schema has drifted between the
    // Supabase legacy era (UUID user_ids) and the Firebase era (string UIDs).
    // All user_id columns are TEXT but id columns are UUID — cast everything
    // to text for safe cross-column comparison regardless of input shape
    // (Firebase UID strings like "Wggy..." vs legacy UUIDs).
    const result = await dbQuery<{ email: string | null }>(
      `SELECT email FROM (
         -- (1) direct match on user_profiles.user_id (populated at signup / by auth middleware)
         SELECT up.email, 1 AS priority FROM user_profiles up
           WHERE up.user_id::text = $1 AND up.email IS NOT NULL
         UNION ALL
         -- (2) user_profiles primary key (if caller handed us up.id)
         SELECT up.email, 2 AS priority FROM user_profiles up
           WHERE up.id::text = $1 AND up.email IS NOT NULL
         UNION ALL
         -- (3) provider → user_profiles via any plausible link
         SELECT up.email, 3 AS priority FROM user_profiles up
           JOIN provider_profiles pp
             ON up.user_id::text = pp.user_id::text
             OR up.id::text      = pp.user_id::text
           WHERE (pp.id::text = $1 OR pp.user_id::text = $1) AND up.email IS NOT NULL
       ) matches
       ORDER BY priority
       LIMIT 1`,
      [userId]
    );
    const email = result.rows?.[0]?.email;
    if (email) return email;
  } catch (err) {
    logger.debug('getUserEmailById: DB lookup failed, trying Firebase', { err: String(err) });
  }

  try {
    const admin = await getAdmin();
    const user = await admin.auth().getUser(userId);
    return user.email ?? null;
  } catch {
    return null;
  }
}

// ─── HTML Templates ────────────────────────────────────────────────────────────

function baseLayout(content: string, preheader = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>IstaSeva</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;">${preheader}&nbsp;&zwnj;</span>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);padding:28px 40px;text-align:center;">
            <span style="font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">IstaSeva</span>
            <span style="display:block;font-size:13px;color:rgba(255,255,255,0.75);margin-top:2px;">India's trusted services marketplace</span>
          </td>
        </tr>
        <!-- Body -->
        <tr><td style="padding:40px;">${content}</td></tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:24px 40px;text-align:center;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">
              © ${new Date().getFullYear()} IstaSeva · <a href="https://istaseva.com" style="color:#6366f1;text-decoration:none;">istaseva.com</a>
            </p>
            <p style="margin:8px 0 0;font-size:11px;color:#d1d5db;">
              You're receiving this because you have an account on IstaSeva.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function divider() {
  return `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />`;
}

function infoRow(label: string, value: string) {
  return `<tr>
    <td style="padding:6px 0;font-size:14px;color:#6b7280;width:140px;">${label}</td>
    <td style="padding:6px 0;font-size:14px;color:#111827;font-weight:500;">${value}</td>
  </tr>`;
}

/** Render a list of "HH:MM" slot starts as "9:00 AM, 10:00 AM, …" for
 *  the booking-confirmed email + invoice. Sorted ascending; durations
 *  are implied (1-hour blocks today). */
function formatSlotList(slots: string[]): string {
  const fmt = (hhmm: string): string => {
    const [hStr, mStr] = String(hhmm || '').split(':');
    const h = Number(hStr);
    const m = Number(mStr);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return m === 0 ? `${h12}:00 ${period}` : `${h12}:${String(m).padStart(2, '0')} ${period}`;
  };
  return [...slots]
    .filter((s) => typeof s === 'string' && s.includes(':'))
    .sort()
    .map(fmt)
    .join(', ');
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Per-type Templates ────────────────────────────────────────────────────────
//
// Email design philosophy:
//   - No CTAs / buttons. Notifications already deep-link inside the app; the
//     email's job is to inform, not drive a click. Removes broken-button
//     incidents and keeps the copy professional.
//   - Use the rich `message` from the notification verbatim — it's already
//     descriptive ("Your booking at Trident Hotels for Thu, 7 May → Sun,
//     10 May has been cancelled. Any payment will be refunded shortly.").
//   - The structured fields (date, guest, provider) are surfaced in the
//     summary table for skim-readers, but copy doesn't depend on them.

// Exported for unit tests — production code dispatches via sendNotificationEmail
// which selects the template internally. Keeping the map exported is cheap and
// lets us assert the rendered HTML/text per category without spinning up SES.
export const templates: Record<string, (data: EmailData) => { subject: string; html: string; text: string }> = {
  booking_confirmed: (d) => {
    // MMT-inspired layout. Three blocks:
    //   1. Confirmation header + booking refs
    //   2. Booking Details grid (hotel/route, check-in/out OR scheduled date,
    //      guest, nights/quantity)
    //   3. Fare Summary table — Subtotal, Platform Fee, GST, Discount, Total
    //   4. Cancellation Policy box (always shown so the guest knows the rules
    //      before they need them)
    const ref = d.bookingId ? String(d.bookingId).slice(0, 8).toUpperCase() : '';
    const isStay = !!(d.checkInDate || d.checkOutDate || d.hotelAddress);
    const isTransport = !!(d.pickup || d.drop);
    const p = d.pricing;

    // Booking refs band — mirrors MMT's "R360 Booking ID / Partner Ref ID / Booked on".
    const refsBand = `
      <table cellpadding="0" cellspacing="0" style="width:100%;background:#f3f4f6;border-radius:8px;padding:14px 18px;margin-bottom:24px;">
        <tbody>
          ${ref ? infoRow('Booking Ref', `<span style="font-family:'SFMono-Regular',Menlo,monospace;">${escapeHtml(ref)}</span>`) : ''}
          ${d.bookingId ? infoRow('Booking ID', `<span style="font-family:'SFMono-Regular',Menlo,monospace;font-size:12px;">${escapeHtml(d.bookingId)}</span>`) : ''}
          ${d.bookedOn ? infoRow('Booked On', escapeHtml(d.bookedOn)) : ''}
        </tbody>
      </table>`;

    // Booking Details: shape varies by category. Stay = hotel + dates;
    // Transport = route + scheduled time; Service = service date + provider.
    const detailRows: string[] = [];
    if (isStay) {
      detailRows.push(infoRow('Hotel', `<strong>${escapeHtml(d.listing || d.title)}</strong>`));
      if (d.hotelAddress) detailRows.push(infoRow('Address', escapeHtml(d.hotelAddress)));
      // WS6: the host is encouraged (not required) to provide a street-level
      // address. When they haven't, be upfront rather than leaving the guest
      // to discover it at the door.
      if (d.hasExactAddress === false) {
        detailRows.push(infoRow('Getting there',
          `<span style="color:#6b7280;">The host hasn't added a full street address yet — `
          + `message or call your host in the app for exact directions.</span>`));
      }
      if (d.checkInDate) {
        const t = d.checkInTime ? `, ${escapeHtml(d.checkInTime)}` : '';
        detailRows.push(infoRow('Check-In', `${escapeHtml(d.checkInDate)}${t} <span style="color:#9ca3af;font-size:12px;">(local time)</span>`));
      }
      if (d.checkOutDate) {
        const t = d.checkOutTime ? `, ${escapeHtml(d.checkOutTime)}` : '';
        detailRows.push(infoRow('Check-Out', `${escapeHtml(d.checkOutDate)}${t} <span style="color:#9ca3af;font-size:12px;">(local time)</span>`));
      }
      if (d.nights && d.nights > 0) detailRows.push(infoRow('Duration', `${d.nights} Night${d.nights === 1 ? '' : 's'}`));
      if (d.guestCount && d.guestCount > 0) detailRows.push(infoRow('Guests', `${d.guestCount} ${d.guestCount === 1 ? 'Guest' : 'Guests'}`));
      if (d.roomType) detailRows.push(infoRow('Room Type', `<strong>${escapeHtml(d.roomType)}</strong>`));
      if (d.roomCount && d.roomCount > 1) {
        detailRows.push(infoRow('Rooms', `${d.roomCount} ${d.roomCount === 1 ? 'Room' : 'Rooms'}`));
      }
      if (d.guest) detailRows.push(infoRow('Guest Name', escapeHtml(d.guest)));
    } else if (isTransport) {
      detailRows.push(infoRow('Service', `<strong>${escapeHtml(d.serviceType || 'Transport')}</strong>`));
      // Vehicle identity so the rider can spot the car that arrives.
      if (d.vehicleModel) detailRows.push(infoRow('Vehicle', `<strong>${escapeHtml(d.vehicleModel)}</strong>`));
      if (d.vehicleColor) detailRows.push(infoRow('Colour', escapeHtml(d.vehicleColor)));
      if (d.licensePlate) detailRows.push(infoRow('Number plate', `<strong>${escapeHtml(d.licensePlate)}</strong>`));
      // Driver = the person's name (falls back to the listing/provider name on
      // legacy rows) plus their phone so the rider can reach them.
      const driverDisplay = d.driverName || d.listing || d.provider;
      if (driverDisplay) detailRows.push(infoRow('Driver', escapeHtml(driverDisplay)));
      if (d.driverPhone) detailRows.push(infoRow('Driver phone', escapeHtml(d.driverPhone)));
      if (d.pickup) detailRows.push(infoRow('Pickup', escapeHtml(d.pickup)));
      if (d.drop) detailRows.push(infoRow('Drop', escapeHtml(d.drop)));
      if (typeof d.estimatedKm === 'number' && d.estimatedKm > 0) detailRows.push(infoRow('Distance', `~${d.estimatedKm} km`));
      // Render pickup date and time on SEPARATE rows for scannability —
      // a customer glancing at the email shouldn't have to parse
      // "2026-06-01 14:00" mentally. The incoming `d.date` is currently
      // a single string ("YYYY-MM-DD HH:MM" from the assistant booking
      // flow); split on the first whitespace. When there's no time
      // component, just show the date row.
      if (d.date) {
        const dateStr = String(d.date).trim();
        const spaceIdx = dateStr.search(/\s/);
        const datePart = spaceIdx >= 0 ? dateStr.slice(0, spaceIdx) : dateStr;
        const timePart = spaceIdx >= 0 ? dateStr.slice(spaceIdx + 1).trim() : '';
        detailRows.push(infoRow('Pickup Date', escapeHtml(datePart)));
        if (timePart) {
          detailRows.push(infoRow('Pickup Time', `${escapeHtml(timePart)} <span style="color:#9ca3af;font-size:12px;">(local time)</span>`));
        }
      }
      // Booking time slot — surfaces the start–end window the customer
      // actually reserved. Hourly bookings show the chosen window; day
      // rentals fall back to the default 00:00–23:59 the assistant stamps,
      // which still tells the driver "all day".
      if (d.bookingStartTime && d.bookingEndTime) {
        detailRows.push(infoRow('Booking time', `${escapeHtml(d.bookingStartTime)} – ${escapeHtml(d.bookingEndTime)}`));
      } else if (d.bookingStartTime) {
        detailRows.push(infoRow('Booking time', escapeHtml(d.bookingStartTime)));
      }
      // Mode-derived units the customer was billed for. Each row only
      // renders when the matching field came through, so a day rental
      // doesn't accidentally show "Hours: 1" and an hourly booking
      // doesn't claim "Days: 1".
      if (typeof d.transportHours === 'number' && d.transportHours > 0) {
        detailRows.push(infoRow('Hours', `${d.transportHours} hour${d.transportHours === 1 ? '' : 's'}`));
      }
      if (typeof d.transportDays === 'number' && d.transportDays > 0) {
        detailRows.push(infoRow('Days', `${d.transportDays} day${d.transportDays === 1 ? '' : 's'}`));
      }
      if (d.transportPackage) {
        detailRows.push(infoRow('Package', escapeHtml(d.transportPackage)));
      }
      if (d.guest) detailRows.push(infoRow('Passenger', escapeHtml(d.guest)));
      if (typeof d.passengers === 'number' && d.passengers > 0) {
        detailRows.push(infoRow('Passengers', `${d.passengers}`));
      }
      if (Array.isArray(d.selectedSlots) && d.selectedSlots.length > 0) {
        detailRows.push(infoRow('Slots booked', escapeHtml(formatSlotList(d.selectedSlots))));
      }
    } else {
      detailRows.push(infoRow('Service', `<strong>${escapeHtml(d.listing || d.title)}</strong>`));
      // When a services-catalog group was selected, surface its name right
      // below the listing so the customer sees both the business and the
      // specific offering (a salon listing otherwise renders identically
      // across men's / women's / kids haircut bookings).
      if (d.selectedServiceName) detailRows.push(infoRow('Offering', escapeHtml(d.selectedServiceName)));
      if (d.provider) detailRows.push(infoRow('Provider', escapeHtml(d.provider)));
      // Visit-provider: the confirmed customer travels to the provider, so
      // the email is where the exact address lands (the public listing may
      // withhold it until booking — WS6).
      if (d.visitAddress) detailRows.push(infoRow('Where to go', escapeHtml(d.visitAddress)));
      // WS6: the provider never gave a street-level address — the "Where to
      // go" above (or Location row) is only the area. Be upfront, like the
      // stay branch. hasExactAddress is true for at-home/online/transport,
      // so this only ever renders for visit-provider.
      if (d.hasExactAddress === false) {
        detailRows.push(infoRow('Getting there',
          `<span style="color:#6b7280;">The provider hasn't added a full street address yet — `
          + `message or call them in the app for exact directions.</span>`));
      }
      if (d.serviceLocation) detailRows.push(infoRow('Location', escapeHtml(d.serviceLocation)));
      if (d.date) detailRows.push(infoRow('Scheduled', `${escapeHtml(d.date)} <span style="color:#9ca3af;font-size:12px;">(local time)</span>`));
      // Booking time slot for services — start–end window the customer
      // reserved. Surfaced explicitly (not just inside `Scheduled`) so the
      // provider can see the exact window at a glance.
      if (d.bookingStartTime && d.bookingEndTime) {
        detailRows.push(infoRow('Booking time', `${escapeHtml(d.bookingStartTime)} – ${escapeHtml(d.bookingEndTime)}`));
      } else if (d.bookingStartTime) {
        detailRows.push(infoRow('Booking time', escapeHtml(d.bookingStartTime)));
      }
      if (d.serviceDuration) detailRows.push(infoRow('Duration', escapeHtml(d.serviceDuration)));
      if (d.guest) detailRows.push(infoRow('Customer', escapeHtml(d.guest)));
    }
    const detailsBlock = `
      <h3 style="margin:0 0 10px;font-size:15px;color:#111827;">Booking Details</h3>
      <table cellpadding="0" cellspacing="0" style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
        <tbody>${detailRows.join('')}</tbody>
      </table>`;

    // Fare Summary — MMT's table with Subtotal / Tax / Discount / Total.
    // We add a Platform Fee line because IstaSeva shows it explicitly. Lines
    // render only when the breakdown supplies them.
    const fareRow = (label: string, value: string, opts?: { bold?: boolean; muted?: boolean }) => `
      <tr>
        <td style="padding:8px 0;font-size:${opts?.bold ? 14 : 13}px;color:${opts?.muted ? '#6b7280' : '#111827'};${opts?.bold ? 'font-weight:700;' : ''}">${label}</td>
        <td style="padding:8px 0;font-size:${opts?.bold ? 14 : 13}px;color:${opts?.muted ? '#6b7280' : '#111827'};${opts?.bold ? 'font-weight:700;' : ''}text-align:right;">${escapeHtml(value)}</td>
      </tr>`;

    const fareBlock = p ? `
      <h3 style="margin:0 0 10px;font-size:15px;color:#111827;">Fare Summary</h3>
      <table cellpadding="0" cellspacing="0" style="width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;margin-bottom:6px;">
        <tbody>
          <tr><td colspan="2" style="padding:0 0 8px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#9ca3af;letter-spacing:0.6px;text-transform:uppercase;">Fare Details</td></tr>
          ${p.addOnItems && p.addOnItems.length > 0
            ? `${fareRow(p.serviceName || 'Service charge', p.baseChargeOnly ?? p.subtotal)}
               ${p.addOnItems.map((a) => fareRow(`+ ${a.label}`, a.amount, { muted: true })).join('\n          ')}`
            : fareRow(
                isStay ? 'Base Cost'
                  : isTransport ? 'Trip Fare'
                  : (p.serviceName || 'Service Cost'),
                p.subtotal,
              )}
          ${p.platformFee ? fareRow('Platform Fee (10%)', p.platformFee, { muted: true }) : ''}
          ${p.discount ? fareRow('Coupon discount', `- ${p.discount}`, { muted: true }) : ''}
          ${fareRow(p.gstLabel, p.gstAmount, { muted: true })}
          ${p.insurance ? fareRow('Insurance Premium', p.insurance, { muted: true }) : ''}
          <tr><td colspan="2" style="padding:8px 0 0;border-top:1px solid #e5e7eb;"></td></tr>
          ${fareRow('Total Paid', p.total, { bold: true })}
        </tbody>
      </table>
      ${d.paymentMethod ? `<p style="margin:0 0 18px;font-size:12px;color:#6b7280;text-align:right;">Paid via ${escapeHtml(d.paymentMethod)}</p>` : '<div style="margin-bottom:18px;"></div>'}` : '';

    // GSTIN block — always render so the receipt has a clear answer about tax
    // identifiers. Falls back to "Not GST-registered" when neither party has
    // a number on file. Vendors with GSTINs see them; platform GSTIN is
    // always sourced from the running app config (mock in staging).
    const providerGstinLine = d.providerGstin
      ? `Vendor GSTIN: <strong>${escapeHtml(d.providerGstin)}</strong>`
      : 'Vendor is not GST-registered under the CGST Act.';
    const platformGstinLine = d.platformGstin
      ? `IstaSeva GSTIN: <strong>${escapeHtml(d.platformGstin)}</strong>`
      : '';
    const gstinBlock = `
      <table cellpadding="0" cellspacing="0" style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 18px;margin-bottom:24px;">
        <tbody>
          <tr><td style="font-size:12px;color:#374151;line-height:1.7;">
            ${providerGstinLine}${platformGstinLine ? `<br />${platformGstinLine}` : ''}
          </td></tr>
        </tbody>
      </table>`;

    // Cancellation Policy box — short paragraph; defaults to flexible if the
    // caller didn't include one so guests always see something.
    const policyText = d.cancellationPolicyText
      || 'Full refund on cancellation. Refunds usually land in 5-7 business days.';
    const policyBlock = `
      <h3 style="margin:0 0 10px;font-size:15px;color:#111827;">Cancellation Policy</h3>
      <table cellpadding="0" cellspacing="0" style="width:100%;background:#fffbea;border:1px solid #fde68a;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
        <tbody>
          <tr><td style="font-size:13px;color:#78350f;line-height:1.6;">${escapeHtml(policyText)}</td></tr>
        </tbody>
      </table>`;

    // Plain-text mirror.
    const fareText = p ? [
      '',
      'Fare Summary:',
      ...(p.addOnItems && p.addOnItems.length > 0
        ? [
            `  ${p.serviceName || 'Service charge'}: ${p.baseChargeOnly ?? p.subtotal}`,
            ...p.addOnItems.map((a) => `  + ${a.label}: ${a.amount}`),
          ]
        : [`  ${isStay ? 'Base Cost' : isTransport ? 'Trip Fare' : (p.serviceName || 'Service Cost')}: ${p.subtotal}`]),
      p.platformFee ? `  Platform Fee (10%): ${p.platformFee}` : '',
      p.discount ? `  Coupon discount: -${p.discount}` : '',
      `  ${p.gstLabel}: ${p.gstAmount}`,
      p.insurance ? `  Insurance Premium: ${p.insurance}` : '',
      `  Total Paid: ${p.total}`,
      d.paymentMethod ? `  Paid via: ${d.paymentMethod}` : '',
    ].filter(Boolean).join('\n') : '';
    const gstinText = [
      '',
      d.providerGstin ? `Vendor GSTIN: ${d.providerGstin}` : 'Vendor is not GST-registered under the CGST Act.',
      d.platformGstin ? `IstaSeva GSTIN: ${d.platformGstin}` : '',
    ].filter(Boolean).join('\n');

    return ({
      subject: `Booking confirmed — ${d.listing || d.title}`,
      html: baseLayout(`
        <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 18px;">
          <tr>
            <td>
              <h2 style="margin:0;font-size:22px;color:#111827;">We're delighted to confirm your booking${isStay ? ' at ' + escapeHtml(d.listing || d.title) : ''}.</h2>
              <p style="margin:8px 0 0;font-size:14px;color:#374151;line-height:1.6;">${escapeHtml(d.message)}</p>
            </td>
          </tr>
        </table>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
          <tr>
            <td style="background:#dcfce7;border:1px solid #86efac;border-radius:999px;padding:8px 16px;font-size:13px;color:#166534;font-weight:600;">
              ✓ Booking Confirmed
            </td>
          </tr>
        </table>
        ${refsBand}
        ${detailsBlock}
        ${fareBlock}
        ${gstinBlock}
        ${policyBlock}
        ${divider()}
        <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">Your GST-compliant tax invoice is attached to this email and is also downloadable from your dashboard. If anything looks off, just reply — our support team will help.</p>
      `, 'Your booking has been confirmed'),
      text: [
        'BOOKING CONFIRMED',
        '',
        d.message,
        ref ? `Booking Ref: ${ref}` : '',
        d.bookingId ? `Booking ID: ${d.bookingId}` : '',
        d.bookedOn ? `Booked On: ${d.bookedOn}` : '',
        '',
        'Booking Details:',
        isStay ? `  Hotel: ${d.listing || d.title}` : `  Service: ${d.listing || d.title}`,
        // Plain-text mirror of the HTML "Offering" row — service bookings
        // only, gated on a catalog group having been selected.
        !isStay && d.selectedServiceName ? `  Offering: ${d.selectedServiceName}` : '',
        d.hotelAddress ? `  Address: ${d.hotelAddress}` : '',
        d.visitAddress ? `  Where to go: ${d.visitAddress}` : '',
        // WS6: no street-level address on file — mirror the HTML note (the
        // plain-text body previously omitted it entirely, even for stays).
        d.hasExactAddress === false ? '  Getting there: message or call your host in the app for exact directions' : '',
        d.checkInDate ? `  Check-In: ${d.checkInDate}${d.checkInTime ? ', ' + d.checkInTime : ''} (local time)` : '',
        d.checkOutDate ? `  Check-Out: ${d.checkOutDate}${d.checkOutTime ? ', ' + d.checkOutTime : ''} (local time)` : '',
        d.nights ? `  Duration: ${d.nights} Night${d.nights === 1 ? '' : 's'}` : '',
        d.guestCount ? `  Guests: ${d.guestCount}` : '',
        d.roomType ? `  Room Type: ${d.roomType}` : '',
        d.vehicleModel ? `  Vehicle: ${d.vehicleModel}` : '',
        d.vehicleColor ? `  Colour: ${d.vehicleColor}` : '',
        d.licensePlate ? `  Number plate: ${d.licensePlate}` : '',
        (d.driverName || (isTransport ? (d.listing || d.provider) : '')) ? `  Driver: ${d.driverName || d.listing || d.provider}` : '',
        d.driverPhone ? `  Driver phone: ${d.driverPhone}` : '',
        d.pickup ? `  Pickup: ${d.pickup}` : '',
        d.drop ? `  Drop: ${d.drop}` : '',
        d.guest ? `  Guest: ${d.guest}` : '',
        fareText,
        gstinText,
        '',
        'Cancellation Policy:',
        `  ${policyText}`,
        '',
        'Your GST tax invoice is attached.',
      ].filter((line) => line !== '').join('\n'),
    });
  },

  new_booking: (d) => {
    // d.listing is the real listing name. d.title is the *notification*
    // title ("New Booking 🎉"). Prefer the listing name; fall back to title
    // only so older in-flight SQS messages that predate the metadata fix
    // still produce something coherent.
    const listingName = d.listing || d.title;
    // Service-row label so the provider sees what kind of booking it is
    // (Stay / Transport · cab / Cleaning) without having to open the app.
    const serviceLabel = d.serviceType || 'Booking';
    const routeLine = d.pickup && d.drop ? `${d.pickup} → ${d.drop}` : (d.pickup || d.drop || '');
    const kmLine = typeof d.estimatedKm === 'number' && d.estimatedKm > 0 ? `~${d.estimatedKm} km` : '';
    return ({
    subject: `New booking — ${listingName}`,
    html: baseLayout(`
      <h2 style="margin:0 0 12px;font-size:22px;color:#111827;">You have a new booking</h2>
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">${escapeHtml(d.message)}</p>
      <table cellpadding="0" cellspacing="0" style="width:100%;background:#f9fafb;border-radius:8px;padding:16px;margin-bottom:8px;">
        <tbody>
          ${infoRow('Service', escapeHtml(serviceLabel))}
          ${infoRow('Listing', escapeHtml(listingName))}
          ${d.date ? infoRow('Date', escapeHtml(d.date)) : ''}
          ${routeLine ? infoRow('Route', escapeHtml(routeLine)) : ''}
          ${kmLine ? infoRow('Distance', escapeHtml(kmLine)) : ''}
          ${d.guest ? infoRow('Guest', escapeHtml(d.guest)) : ''}
          ${d.amount ? infoRow('Amount', escapeHtml(d.amount)) : ''}
          ${d.bookingId ? infoRow('Reference', escapeHtml(String(d.bookingId).slice(0, 8).toUpperCase())) : ''}
        </tbody>
      </table>
      ${divider()}
      <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">Open your dashboard to review the full details. Quick acceptances make for happy guests.</p>
    `, 'A new guest has booked your listing'),
    text: `New booking.\n\n${d.message}\n\nService: ${serviceLabel}\nListing: ${listingName}${d.date ? `\nDate: ${d.date}` : ''}${routeLine ? `\nRoute: ${routeLine}` : ''}${kmLine ? `\nDistance: ${kmLine}` : ''}${d.guest ? `\nGuest: ${d.guest}` : ''}${d.amount ? `\nAmount: ${d.amount}` : ''}${d.bookingId ? `\nReference: ${String(d.bookingId).slice(0, 8).toUpperCase()}` : ''}\n\nOpen your dashboard to review.`,
    });
  },

  booking_cancelled: (d) => ({
    subject: `Booking cancelled — ${d.title}`,
    html: baseLayout(`
      <h2 style="margin:0 0 12px;font-size:22px;color:#111827;">Booking cancelled</h2>
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">${escapeHtml(d.message)}</p>
      <table cellpadding="0" cellspacing="0" style="width:100%;background:#fef2f2;border-radius:8px;padding:16px;margin-bottom:8px;">
        <tbody>
          ${infoRow('Booking', escapeHtml(d.title))}
          ${d.date ? infoRow('Date', escapeHtml(d.date)) : ''}
        </tbody>
      </table>
      ${divider()}
      <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">Refunds typically post to your original payment method within 5–7 business days. If you have questions, just reply to this email.</p>
    `, 'Your booking has been cancelled'),
    text: `Booking cancelled.\n\n${d.message}\n\nBooking: ${d.title}${d.date ? `\nDate: ${d.date}` : ''}\n\nRefunds typically post within 5–7 business days.`,
  }),

  booking_completed: (d) => ({
    subject: `Hope you enjoyed it — ${d.title}`,
    html: baseLayout(`
      <h2 style="margin:0 0 12px;font-size:22px;color:#111827;">Hope you enjoyed it</h2>
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">${escapeHtml(d.message)}</p>
      <table cellpadding="0" cellspacing="0" style="width:100%;background:#f9fafb;border-radius:8px;padding:16px;margin-bottom:8px;">
        <tbody>
          ${infoRow('Booking', escapeHtml(d.title))}
          ${d.date ? infoRow('Date', escapeHtml(d.date)) : ''}
          ${d.provider ? infoRow('Provider', escapeHtml(d.provider)) : ''}
        </tbody>
      </table>
      ${divider()}
      <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">If you have a moment, leaving a review from your dashboard helps other travellers. You can also re-download the invoice from there.</p>
    `, 'Leave a review for your recent booking'),
    text: `${d.message}\n\nBooking: ${d.title}\n\nLeave a review from your dashboard to help others.`,
  }),

  payment: (d) => ({
    subject: `${d.title}`,
    html: baseLayout(`
      <h2 style="margin:0 0 12px;font-size:22px;color:#111827;">${escapeHtml(d.title)}</h2>
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">${escapeHtml(d.message)}</p>
      ${divider()}
      <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">If anything looks wrong, reply to this email and we'll sort it out.</p>
    `, d.message),
    text: `${d.title}\n\n${d.message}`,
  }),

  // The one template that intentionally carries a CTA button — the entire
  // purpose of this email IS the click. `d.link` is a one-time Firebase
  // reset link (expires in ~1 hour). Falls back gracefully if link is absent.
  password_reset: (d) => ({
    subject: 'Reset your IstaSeva password',
    html: baseLayout(`
      <h2 style="margin:0 0 12px;font-size:22px;color:#111827;">Reset your password</h2>
      <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.6;">${escapeHtml(d.message)}</p>
      ${d.link ? `
      <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;"><tbody><tr><td align="center" style="border-radius:10px;background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);">
        <a href="${d.link}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">Reset password</a>
      </td></tr></tbody></table>
      <p style="margin:0 0 8px;font-size:13px;color:#6b7280;line-height:1.6;">Or paste this link into your browser:</p>
      <p style="margin:0 0 20px;font-size:12px;color:#9ca3af;word-break:break-all;">${escapeHtml(d.link)}</p>
      ` : ''}
      ${divider()}
      <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">This link expires in 1 hour and can only be used once. If you didn't ask to reset your password, no action is needed — your account is still secure.</p>
    `, 'Reset your IstaSeva password'),
    text: `Reset your password\n\n${d.message}${d.link ? `\n\nReset your password:\n${d.link}` : ''}\n\nThis link expires in 1 hour and can only be used once. If you didn't request this, you can ignore this email.`,
  }),

  // Security alert fired AFTER a password is actually changed (post-reset).
  // Not a CTA email — the button is a recovery escape hatch for the case
  // where the change was NOT the recipient (account takeover): d.link points
  // at the reset flow so they can immediately re-lock the account.
  password_changed: (d) => ({
    subject: 'Your IstaSeva password was changed',
    html: baseLayout(`
      <h2 style="margin:0 0 12px;font-size:22px;color:#111827;">Your password was changed</h2>
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">${escapeHtml(d.message)}</p>
      ${d.link ? `
      <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;"><tbody><tr><td align="center" style="border-radius:10px;background:linear-gradient(135deg,#dc2626 0%,#b91c1c 100%);">
        <a href="${d.link}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">Secure my account</a>
      </td></tr></tbody></table>
      ` : ''}
      ${divider()}
      <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">If you made this change, you can ignore this email. If you didn't, reset your password now and contact support — someone else may have access to your account.</p>
    `, 'Your IstaSeva password was changed'),
    text: `Your password was changed\n\n${d.message}${d.link ? `\n\nSecure your account:\n${d.link}` : ''}\n\nIf you made this change, you can ignore this email. If you didn't, reset your password now and contact support.`,
  }),

  // Host-books-on-behalf: "complete your payment" email to the walk-up guest.
  // Like password_reset, the CTA IS the point — d.link is the Razorpay
  // Payment Link short URL. The QR code arrives as a PNG attachment (email
  // clients block data: URIs in <img>, so we don't inline it).
  payment_link: (d) => ({
    subject: d.listing ? `Complete your booking — ${d.listing}` : 'Complete your booking payment',
    html: baseLayout(`
      <h2 style="margin:0 0 12px;font-size:22px;color:#111827;">Complete your booking</h2>
      <p style="margin:0 0 8px;font-size:15px;color:#374151;line-height:1.6;">${escapeHtml(d.message)}</p>
      ${d.date ? `<p style="margin:0 0 4px;font-size:14px;color:#374151;"><strong>When:</strong> ${escapeHtml(d.date)}</p>` : ''}
      ${d.amount ? `<p style="margin:0 0 24px;font-size:14px;color:#374151;"><strong>Amount:</strong> ${escapeHtml(d.amount)}</p>` : ''}
      ${d.link ? `
      <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;"><tbody><tr><td align="center" style="border-radius:10px;background:linear-gradient(135deg,#2b2436 0%,#8b5e4a 100%);">
        <a href="${d.link}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">Pay now</a>
      </td></tr></tbody></table>
      <p style="margin:0 0 8px;font-size:13px;color:#6b7280;line-height:1.6;">Or paste this link into your browser:</p>
      <p style="margin:0 0 20px;font-size:12px;color:#9ca3af;word-break:break-all;">${escapeHtml(d.link)}</p>
      ` : ''}
      ${divider()}
      <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">You can also scan the attached QR code to pay. Your booking is held until the link expires — it's confirmed the moment payment completes.</p>
    `, 'Complete your booking payment'),
    text: `Complete your booking\n\n${d.message}${d.date ? `\nWhen: ${d.date}` : ''}${d.amount ? `\nAmount: ${d.amount}` : ''}${d.link ? `\n\nPay here:\n${d.link}` : ''}\n\nYou can also scan the attached QR code to pay. Your booking is confirmed the moment payment completes.`,
  }),
};

// ─── Generic fallback ──────────────────────────────────────────────────────────

function genericTemplate(d: EmailData) {
  return {
    subject: d.title,
    html: baseLayout(`
      <h2 style="margin:0 0 12px;font-size:22px;color:#111827;">${escapeHtml(d.title)}</h2>
      <p style="margin:0;font-size:15px;color:#374151;line-height:1.6;">${escapeHtml(d.message)}</p>
    `, d.message),
    text: `${d.title}\n\n${d.message}`,
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

export interface EmailPricingBreakdown {
  /** Line-item description (listing or service name) */
  description?: string;
  /** Pre-tax taxable value, INR-formatted (e.g. "INR 1,000.00") */
  subtotal: string;
  /** Tax line label, e.g. "CGST + SGST @ 18%" or "IGST @ 18%" */
  gstLabel: string;
  /** Total tax amount, INR-formatted */
  gstAmount: string;
  /** Grand total paid, INR-formatted */
  total: string;
  /** Optional MMT-style fare-summary fields. Render only when present so
   *  callers that haven't migrated still produce a coherent email. */
  platformFee?: string;
  insurance?: string;
  discount?: string;
  /** Optional service add-on line items (e.g. "Beard trim", "Shaving").
   *  When present, the Fare Summary splits the base into "Service charge"
   *  + one "+ <label>" row per add-on so the receipt mirrors what the
   *  booking modal showed. Each amount is INR-formatted. */
  addOnItems?: Array<{ label: string; amount: string }>;
  /** When `addOnItems` is set, callers should also pass the base portion
   *  (subtotal minus add-ons sum) so the email can render it as the
   *  "Service charge" row instead of repeating the full subtotal. */
  baseChargeOnly?: string;
  /** Selected services-catalog group name (e.g. "Women's Haircut"). When
   *  present it labels the base row in the Fare Summary instead of the
   *  generic "Service charge" / "Service Cost", so the email matches the
   *  fare breakdown the customer saw in the booking modal and the invoice
   *  PDF. Empty for legacy listings without a catalog. */
  serviceName?: string;
}

export interface EmailData {
  title: string;
  message: string;
  link?: string;
  date?: string;
  provider?: string;
  guest?: string;
  listing?: string;
  amount?: string;
  bookingId?: string;
  pricing?: EmailPricingBreakdown;
  /** Transport bookings carry these extras for richer email summaries.
   *  Optional everywhere else — the template renders the row only when present. */
  serviceType?: string;
  pickup?: string;
  drop?: string;
  estimatedKm?: number;
  /** Transport vehicle identity + driver contact — surfaced on the
   *  booking_confirmed email so the rider can spot the car and reach the
   *  driver. driverName is the person; driverPhone the OTP-verified contact. */
  vehicleModel?: string;
  vehicleColor?: string;
  licensePlate?: string;
  driverName?: string;
  driverPhone?: string;
  /** Stay-specific. When present the booking_confirmed template renders a
   *  MMT-style "Booking Details" grid with check-in/out date+time + room.
   *  NEVER set for services — `isStay` is inferred from its presence; use
   *  `visitAddress` for visit-provider service bookings instead. */
  hotelAddress?: string;
  /** Service-specific (visit-provider): the provider's shop/studio address
   *  the customer travels to. Confirmed guests are entitled to it even when
   *  the public listing withholds it (WS6) — the send path reads it from the
   *  booking notes, which snapshot the server-resolved address. */
  visitAddress?: string;
  /** False when the host hasn't provided a street-level address (WS6:
   *  encouraged, not required) — the template then adds a "Getting there"
   *  note telling the guest to message/call the host for directions. */
  hasExactAddress?: boolean;
  checkInDate?: string;
  checkInTime?: string;
  checkOutDate?: string;
  checkOutTime?: string;
  nights?: number;
  guestCount?: number;
  roomType?: string;
  /** Number of rooms of `roomType` the guest booked in one shot. Renders
   *  as a "Rooms" row on the booking-detail grid when > 1. */
  roomCount?: number;
  /** Plain-English cancellation policy text shown in the policy box at the
   *  bottom — same copy that's surfaced on the cancel-preview card. */
  cancellationPolicyText?: string;
  bookedOn?: string;
  /** Tax-identifier fields. providerGstin is the host/vendor's GST number
   *  (when registered); platformGstin is IstaSeva's own. Both render with
   *  a fallback string when missing so the receipt never shows a broken row. */
  providerGstin?: string;
  platformGstin?: string;
  /** "UPI", "Card", "Net banking" — surfaced under the Fare Summary table. */
  paymentMethod?: string;
  /** Service-specific extras. Render only when present. */
  serviceLocation?: string;
  serviceDuration?: string;
  /** Selected services-catalog group name (e.g. "Women's Haircut"). When
   *  present, the booking-details grid adds it under the "Service" row so
   *  the customer + provider can both see the specific offering booked
   *  rather than only the listing's business name. Empty for legacy
   *  listings without a catalog. */
  selectedServiceName?: string;
  /** Transport-specific. Surfaced on the booking_confirmed template so
   *  the guest + driver both see the headcount and any slot picks the
   *  customer made on the day-strip. */
  passengers?: number;
  /** "HH:MM" slot starts the customer toggled on the strip — joined as
   *  "9:00 AM, 10:00 AM, …" in the email. Empty/undefined skips the row. */
  selectedSlots?: string[];
  /** Mode-specific transport extras. Each renders only when present so
   *  hourly/day/package bookings each surface the unit the customer
   *  actually paid for (hours / days / package name). */
  transportMode?: string;       // 'hourly' | 'day' | 'package'
  transportHours?: number;      // hourly mode
  transportDays?: number;       // day mode
  transportPackage?: string;    // package mode — resolved name (falls back to id)
  /** Booking time slot — start/end times the customer reserved. Used for
   *  service + transport receipts; stays use checkInTime/checkOutTime instead. */
  bookingStartTime?: string;    // "HH:MM"
  bookingEndTime?: string;      // "HH:MM"
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

// ─── MIME helpers (only used when an attachment is present) ────────────────────
//
// SES's `SendEmailCommand` doesn't support attachments — must hand-build a
// multipart/mixed MIME message and use `SendRawEmailCommand`. Kept minimal
// (no nodemailer dep): subject encoded-word for emoji, base64 bodies to
// sidestep quoted-printable line-length pitfalls, base64 attachment wrapped
// at 76 cols per RFC 2045.

function encodeMimeSubject(subject: string): string {
  // ASCII-only subjects pass through unchanged. Anything else (e.g. "Booking
  // Confirmed ✅") gets RFC 2047 encoded-word treatment so it renders in
  // every mail client, including older ones.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function wrapBase64(b64: string): string {
  return b64.match(/.{1,76}/g)?.join('\r\n') ?? b64;
}

function randomBoundary(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildRawMimeMessage(args: {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
}): Buffer {
  const CRLF = '\r\n';
  const mixed = randomBoundary('MIXED');
  const alt = randomBoundary('ALT');

  const headers = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${encodeMimeSubject(args.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ].join(CRLF);

  const altPart =
    `--${alt}${CRLF}` +
    `Content-Type: text/plain; charset=UTF-8${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    `${wrapBase64(Buffer.from(args.text, 'utf8').toString('base64'))}${CRLF}${CRLF}` +
    `--${alt}${CRLF}` +
    `Content-Type: text/html; charset=UTF-8${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    `${wrapBase64(Buffer.from(args.html, 'utf8').toString('base64'))}${CRLF}${CRLF}` +
    `--${alt}--${CRLF}`;

  const attachmentParts = args.attachments
    .map((a) =>
      `--${mixed}${CRLF}` +
      `Content-Type: ${a.contentType}; name="${a.filename}"${CRLF}` +
      `Content-Transfer-Encoding: base64${CRLF}` +
      `Content-Disposition: attachment; filename="${a.filename}"${CRLF}${CRLF}` +
      `${wrapBase64(a.content.toString('base64'))}${CRLF}`,
    )
    .join('');

  const body =
    `--${mixed}${CRLF}` +
    `Content-Type: multipart/alternative; boundary="${alt}"${CRLF}${CRLF}` +
    altPart +
    CRLF +
    attachmentParts +
    `--${mixed}--${CRLF}`;

  return Buffer.from(`${headers}${CRLF}${CRLF}${body}`, 'utf8');
}

export async function sendNotificationEmail(params: {
  toEmail: string;
  type: string;
  data: EmailData;
  attachments?: EmailAttachment[];
}): Promise<void> {
  // From-address resolution order: explicit SMTP_FROM_EMAIL (set when the
  // SMTP server enforces a different sender than SES does) → SES_FROM_EMAIL
  // (back-compat with the existing path) → hard-coded default. Keeping the
  // `IstaSeva <...>` display name on both paths so guests see the same
  // friendly sender regardless of which backend actually delivers.
  const fromEmail = config.notification.smtpFromEmail
    || config.notification.sesFromEmail
    || 'noreply@istaseva.com';
  const source = `IstaSeva <${fromEmail}>`;
  const builder = templates[params.type] ?? genericTemplate;
  const { subject, html, text } = builder(params.data);

  // SMTP path — when SMTP_HOST is configured we route through nodemailer
  // instead of the SES SDK. Same template output, same attachment shape;
  // nodemailer handles the multipart/mixed MIME internally so we don't
  // need the hand-rolled buildRawMimeMessage path here. SES SMTP interface
  // (email-smtp.<region>.amazonaws.com) keeps your existing istaseva DKIM
  // working — drop in those creds and deliverability is unchanged.
  const smtp = getSmtpTransporter();
  if (smtp) {
    await smtp.sendMail({
      from: source,
      to: params.toEmail,
      subject,
      html,
      text,
      attachments: params.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
    return;
  }

  // Fast path: no attachments → SendEmailCommand (existing behaviour,
  // simpler, well-tested). Only use the raw-MIME path when we actually
  // need to attach a file, so we don't pay the encoding cost or take on
  // the MIME risk surface for every transactional email.
  if (!params.attachments?.length) {
    await sendSesWithRetry(() => sesClient.send(new SendEmailCommand({
      Source: source,
      Destination: { ToAddresses: [params.toEmail] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          Text: { Data: text, Charset: 'UTF-8' },
        },
      },
    })));
    return;
  }

  const raw = buildRawMimeMessage({
    from: source,
    to: params.toEmail,
    subject,
    html,
    text,
    attachments: params.attachments,
  });
  await sendSesWithRetry(() => sesClient.send(new SendRawEmailCommand({
    Source: source,
    Destinations: [params.toEmail],
    RawMessage: { Data: raw },
  })));
}

/**
 * Wrap a SES SDK call with one transient-error retry. We see ECONNRESET /
 * EPIPE / ETIMEDOUT in production when the SDK's keep-alive HTTPS connection
 * goes stale between sends — most commonly on the larger raw-MIME path with
 * a PDF invoice attachment. A single retry (with a tiny backoff so the SDK
 * can rebuild the connection) clears it; the underlying SES request itself
 * is idempotent at the protocol level so a double-send risk is negligible
 * for transient pre-write failures like these (the connection was reset
 * before SES processed anything).
 *
 * Non-transient errors (auth, throttling, MessageRejected, etc.) bubble up
 * unchanged so callers/logs still see the real reason.
 */
const TRANSIENT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']);
function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; name?: string; cause?: { code?: string } };
  return TRANSIENT_CODES.has(e.code ?? '')
    || TRANSIENT_CODES.has(e.cause?.code ?? '')
    || e.name === 'TimeoutError';
}
async function sendSesWithRetry<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (err) {
    if (!isTransientNetworkError(err)) throw err;
    logger.warn('SES send hit transient error — retrying once', {
      err: err instanceof Error ? err.message : String(err),
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    return send();
  }
}

/**
 * For booking_confirmed emails we attach the GST tax-invoice PDF. The render
 * is best-effort — if it fails (missing pricing data, schema gap, whatever),
 * the email still goes out, just without the attachment. Lazy import keeps
 * the bookings module out of the notifications module's static graph and
 * avoids the circular-dep risk (bookings → notifications → email).
 */
async function maybeBuildInvoiceAttachment(
  type: string,
  userId: string,
  bookingId: string | undefined,
): Promise<EmailAttachment[] | undefined> {
  if (type !== 'booking_confirmed' || !bookingId) return undefined;
  try {
    const { invoiceService } = await import('../../bookings/services/invoice.service.js');
    const { pdf, filename } = await invoiceService.render(bookingId, userId);
    return [{ filename, content: pdf, contentType: 'application/pdf' }];
  } catch (err) {
    logger.warn('Invoice attachment skipped — render failed', {
      bookingId,
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Convenience wrapper: looks up the user's email from Firebase Auth,
 * then sends the notification email. Silent on failure.
 *
 * For booking_confirmed emails, also attempts to attach the GST tax-invoice
 * PDF so the guest's inbox has the receipt without needing to log in.
 */
export async function sendNotificationEmailToUser(params: {
  userId: string;
  type: string;
  data: EmailData;
}): Promise<void> {
  try {
    const email = await getUserEmailById(params.userId);
    if (!email) {
      logger.warn('sendNotificationEmailToUser: no email for user', { userId: params.userId });
      return;
    }
    const attachments = await maybeBuildInvoiceAttachment(
      params.type,
      params.userId,
      params.data.bookingId,
    );
    await sendNotificationEmail({
      toEmail: email,
      type: params.type,
      data: params.data,
      attachments,
    });
    logger.info('Email sent', {
      userId: params.userId,
      type: params.type,
      attached: attachments?.length ?? 0,
    });
  } catch (err) {
    logger.error('Email send failed', { userId: params.userId, type: params.type, err: String(err) });
  }
}
