import { bookingsRepository } from '../repositories/bookings.repository.js';
import { messagesRepository } from '../../chat/repositories/messages.repository.js';
import { logger } from '../../../common/logging/logger.js';

function fmtDate(scheduled: string | Date | null): string | null {
  if (!scheduled) return null;
  const iso = scheduled instanceof Date ? scheduled.toISOString().slice(0, 10) : String(scheduled).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// "14:00:00" / "14:00" → "2:00 PM"
function fmtTime(t: string | null | undefined): string | null {
  if (!t || !/^\d{1,2}:\d{2}/.test(t)) return null;
  const [hStr, mStr] = t.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function parseNotes(notes: string | null): Record<string, unknown> {
  if (!notes) return {};
  try {
    const p = JSON.parse(notes);
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type Parties = Awaited<ReturnType<typeof bookingsRepository.getBookingChatParties>>['rows'][number];

/** Compose the per-type "booking confirmed" message body (multi-line text). */
function buildMessage(row: Parties): string {
  const listing = row.listing_name?.trim() || 'your booking';
  const kind = String(row.listing_type || '').toLowerCase();
  const cat = String(row.service_category || '').toLowerCase();
  const notes = parseNotes(row.notes);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const date = fmtDate(row.scheduled_date);
  const startTime = fmtTime(row.start_time);
  const lines: string[] = [`Booking confirmed ✅`, listing];

  const isTransport = kind === 'transport' || cat.startsWith('driver-');
  const isStay = kind === 'stay' || /hotel|homestay|stay/.test(cat);

  if (isStay) {
    const checkOut = fmtDate(str(notes.checkOut) ?? row.end_date);
    if (date) lines.push(`Check-in: ${date}${startTime ? ` · ${startTime}` : ''}`);
    if (checkOut) lines.push(`Check-out: ${checkOut}${row.end_time ? ` · ${fmtTime(row.end_time)}` : ''}`);
    const roomBits = [row.room_type ? `Room: ${row.room_type}` : null, row.room_count && row.room_count > 1 ? `${row.room_count} rooms` : null, row.guest_count ? `${row.guest_count} guests` : null].filter(Boolean);
    if (roomBits.length) lines.push(roomBits.join(' · '));
  } else if (isTransport) {
    const pickup = str(notes.pickup);
    const drop = str(notes.drop);
    const mode = str(notes.mode) ?? str(notes.transportMode);
    const passengers = Number(notes.passengers);
    if (date) lines.push(`Pickup: ${date}${startTime ? ` · ${startTime}` : ''}`);
    if (pickup || drop) lines.push(`Route: ${pickup ?? '—'} → ${drop ?? '—'}`);
    const trBits = [mode ? `Mode: ${mode}` : null, Number.isFinite(passengers) && passengers > 0 ? `${passengers} passengers` : null].filter(Boolean);
    if (trBits.length) lines.push(trBits.join(' · '));
  } else {
    // service
    const serviceName = str(notes.selectedServiceName);
    const location = str(notes.location) ?? str(notes.address);
    if (date) lines.push(`When: ${date}${startTime ? ` · ${startTime}` : ''}`);
    if (serviceName) lines.push(`Service: ${serviceName}`);
    if (location) lines.push(`At: ${location}`);
  }

  lines.push(`Message me here if you have any questions.`);
  return lines.join('\n');
}

/**
 * Seed a provider→guest "booking confirmed" chat message on confirmation, now
 * with the booking's key details (dates/times, route, room/guests) so the
 * thread is immediately useful. Idempotent + best-effort; never throws.
 */
export async function seedBookingConfirmationMessage(bookingId: string): Promise<void> {
  try {
    const parties = await bookingsRepository.getBookingChatParties(bookingId);
    const row = parties.rows[0];
    if (!row) return;

    const guestUserId = row.guest_user_id;
    const counterpartyUserId = row.counterparty_user_id;
    if (!guestUserId || !counterpartyUserId || guestUserId === counterpartyUserId) return;

    if (await messagesRepository.existsByBookingConfirmation(bookingId)) return;

    await messagesRepository.sendMessage(counterpartyUserId, {
      receiver_id: guestUserId,
      content: buildMessage(row),
      metadata: {
        bookingId,
        kind: 'booking_confirmed',
        listingType: row.listing_type ?? undefined,
        system: true,
      },
    });
  } catch (err) {
    logger.warn('Failed to seed booking-confirmation chat message', {
      bookingId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
