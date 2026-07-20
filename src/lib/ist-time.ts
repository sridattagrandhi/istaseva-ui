/**
 * IST (Asia/Kolkata, UTC+05:30) wall-clock helpers.
 *
 * The marketplace operates in IST: listings, slots, and working hours are
 * IST times, and the backend's past-date gate (`bookings.service.createHold`)
 * compares `scheduledDate` against IST-today. Anchoring client calendars to
 * the BROWSER's local timezone made "today" a past date for any user west of
 * IST (a US evening is already the next IST day) — every booking then failed
 * with "Pick a future date" even though the picked chip looked available.
 *
 * Mirrors `istToday()` in `mobile/src/design/api/bookings.ts`: shift the
 * epoch by the fixed IST offset and read the UTC fields of the shifted
 * instant. IST has no DST, so the constant offset is always correct, and
 * this avoids depending on Intl timezone data.
 */
const IST_OFFSET_MIN = 330;

/** A Date whose LOCAL date/time fields read the current IST wall-clock. */
export function istNow(): Date {
  const shifted = new Date(Date.now() + IST_OFFSET_MIN * 60_000);
  return new Date(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    shifted.getUTCHours(),
    shifted.getUTCMinutes(),
    shifted.getUTCSeconds(),
  );
}

/** IST-today at (local) midnight — the calendar-floor variant of istNow. */
export function istToday(): Date {
  const d = istNow();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** IST calendar date as "YYYY-MM-DD", offset by `offsetDays` from today. */
export function istDateIso(offsetDays = 0): string {
  const d = istToday();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** IST-today as "YYYY-MM-DD". */
export function istTodayIso(): string {
  return istDateIso(0);
}

/** Minutes since IST midnight, right now (0–1439). */
export function istNowMinutes(): number {
  const d = istNow();
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Lead time (minutes) a same-day service/transport slot must be in the future
 * before it can be booked. A slot starting sooner than this — or already past —
 * is treated as unavailable in the pickers AND rejected server-side. Mirrored
 * in `mobile/src/design/api/bookings.ts` and `server` createHold; keep in sync.
 */
export const BOOKING_LEAD_MINUTES = 30;

/** Parse a 12-hour "h:mm AM/PM" label (day prefix optional, e.g. "Mon 6:30 PM")
 *  into minutes since midnight, or null when unparseable. */
export function slotTimeMinutes(label: string): number | null {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(label);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") h += 12;
  return h * 60 + Number(m[2]);
}

/**
 * True when `label`'s start time on `iso` (YYYY-MM-DD) is already past or falls
 * within the booking lead-time buffer, in IST. Only *today* can be "too soon";
 * any future date is always fine. Unparseable labels return false so a weirdly
 * authored slot is never silently hidden.
 */
export function isSlotTooSoon(label: string, iso: string): boolean {
  if (iso !== istTodayIso()) return false;
  const slotMin = slotTimeMinutes(label);
  if (slotMin == null) return false;
  return slotMin < istNowMinutes() + BOOKING_LEAD_MINUTES;
}
