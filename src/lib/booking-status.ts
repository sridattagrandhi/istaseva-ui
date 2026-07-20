/**
 * Derive an effective booking status from the stored status + the clock.
 *
 * The server stores "confirmed" the moment payment clears and never flips to
 * in_progress / completed on its own (no background worker yet). For any
 * dashboard that tabs bookings by state to actually mean something, we compute
 * status on the fly from the dates:
 *   - cancelled / expired / pending / in_progress / completed → pass through
 *   - confirmed + we're past check-out → completed
 *   - confirmed + we're mid-stay      → in_progress
 *   - otherwise                        → confirmed (upcoming)
 *
 * Pure display-time transform — we don't mutate the DB from the client. When a
 * server-side cron lands, delete this helper and trust the stored status.
 */
export function effectiveBookingStatus(b: {
  status: string;
  scheduledDate?: string;
  startTime?: string;
  endTime?: string;
  notes?: string | null;
}): string {
  if (!b.status) return "confirmed";
  if (["cancelled", "expired", "pending", "in_progress", "completed"].includes(b.status)) return b.status;
  if (b.status !== "confirmed") return b.status;

  const now = Date.now();
  const dateStr = b.scheduledDate ? (b.scheduledDate.includes("T") ? b.scheduledDate.split("T")[0] : b.scheduledDate) : null;
  if (!dateStr) return b.status;

  // Stays encode check-out in notes JSON (BookingModal / assistant convention).
  let checkOutStr: string | null = null;
  try {
    const parsed = b.notes ? JSON.parse(b.notes) : null;
    if (parsed?.checkOut) checkOutStr = String(parsed.checkOut);
  } catch { /* notes not JSON — services/transport */ }

  // Postgres TIME columns come back as "HH:MM:SS" — normalize to HH:MM:SS so
  // the ISO-ish string always parses, regardless of whether the caller stored
  // "15:00" or "15:00:00".
  const norm = (t: string) => {
    const parts = t.split(":");
    const hh = (parts[0] || "00").padStart(2, "0");
    const mm = (parts[1] || "00").padStart(2, "0");
    const ss = (parts[2] || "00").padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  };
  // The stored date + time are IST wall-clock values (the marketplace and the
  // backend are India-only). Pin the parse to the IST offset (+05:30, no DST)
  // so the resulting instant is correct regardless of the viewer's device
  // timezone — parsing as device-local mislabels in_progress/completed for
  // anyone whose clock isn't on IST.
  const IST = "+05:30";
  const startMs = new Date(`${dateStr}T${norm(b.startTime || "00:00")}${IST}`).getTime();
  const endMs = checkOutStr
    ? new Date(`${checkOutStr}T${norm(b.endTime || "11:00")}${IST}`).getTime()
    : new Date(`${dateStr}T${norm(b.endTime || "23:59")}${IST}`).getTime();

  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return b.status;
  if (now >= endMs) return "completed";
  if (now >= startMs) return "in_progress";
  return "confirmed";
}
