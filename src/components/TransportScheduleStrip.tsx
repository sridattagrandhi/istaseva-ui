import { useMemo } from "react";

/**
 * Single-day horizontal timeline showing a driver's working hours, with
 * existing bookings shaded and free 1-hour cells optionally clickable.
 *
 * Slot model (new): slots are emitted as 1-hour cells starting at the
 * driver's working-hours start. After every booked block we restart the
 * cascade at `bookedEnd + bufferMinutes`, so a booking ending at 1:00 PM
 * with a 15-minute buffer produces slots at 1:15, 2:15, 3:15, … instead
 * of jumping back to a rigid hour grid. This matches drivers' real-world
 * "give me 15 min between trips" expectation and prevents the customer
 * from picking a slot that crowds the prior booking.
 *
 * Click model (new): the strip is a multi-select picker. Clicking a free
 * cell toggles it; clicking a selected cell deselects it. Contiguity is
 * enforced — a non-adjacent click clears the prior selection and starts
 * a fresh range. The bounding window (min selected → max selected + 1hr)
 * is mirrored back into the parent's hourlyStart/hourlyEnd state so the
 * rest of the booking flow continues to read a single (start, end) pair.
 *
 * Reused in two places so the driver and the customer see the SAME
 * picture of what's bookable:
 *   1. The host dashboard's "Schedule" dialog renders one strip per day
 *      for the next 30 days (read-only — drivers don't book themselves).
 *   2. The transport booking modal renders the strip for the selected
 *      date so customers can click 1-hour cells to set their start/end.
 */

export type BookingBlock = {
  /** "HH:MM" — start of booked window in 24h. */
  start: string;
  /** "HH:MM" — exclusive end of booked window. */
  end: string;
  /** Optional label rendered in the booked block (e.g. "Hourly · 3h"). */
  label?: string;
};

export type ScheduleStripProps = {
  /** "HH:MM" — start of working hours for THIS day. Empty/null → closed. */
  windowStart: string | null;
  /** "HH:MM" — end of working hours for THIS day. */
  windowEnd: string | null;
  /** Existing bookings on this date. */
  bookings: BookingBlock[];
  /** Minutes of buffer the driver requested between back-to-back jobs. */
  bufferMinutes?: number;
  /** Set of "HH:MM" slot starts the customer has currently selected.
   *  Multi-select; the parent tracks this so the bounding window can be
   *  derived. Pass an empty Set to render no selection. */
  selectedStarts?: Set<string>;
  /** Slot-toggle handler. When supplied, free cells become clickable
   *  and the strip enters "picker" mode. */
  onToggleSlot?: (hhmm: string) => void;
  /** Optional duration in minutes for each cell. Default 60 (1 hour). */
  durationMinutes?: number;
  /** Tag rendered above the strip — typically the date label. */
  caption?: string;
  /** Earliest bookable start (minutes-since-midnight) for THIS date. Cells that
   *  begin before it are dropped entirely — used to hide already-past / within-
   *  lead-time slots on today. Omit/undefined = no lower bound (future dates). */
  minStartMinutes?: number;
};

const parseHHMM = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  if (h < 0 || h > 24 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
};

const formatHHMM = (mins: number): string => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

const formatLabel = (mins: number): string => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, "0")}${period}`;
};

type Cell = {
  /** Start of the slot in minutes-since-midnight. */
  start: number;
  /** End of the slot in minutes-since-midnight. */
  end: number;
  /** State drives the cell's color + clickability. */
  state: "free" | "booked" | "selected" | "buffer";
  /** Display label rendered in the cell. */
  label: string;
  /** Optional second-line label for booked blocks. */
  subLabel?: string;
};

/**
 * Build the cell list for the day. Bookings are merged into the cell
 * stream as their own "booked" cells (one per booking) so the user can
 * see exactly which window is taken. Free cells cascade off either the
 * working-hours start or `bookedEnd + buffer` after a booking.
 */
function buildCells(args: {
  windowStart: number;
  windowEnd: number;
  bookings: Array<{ s: number; e: number; label?: string }>;
  bufferMinutes: number;
  durationMinutes: number;
  selectedStarts: Set<string>;
}): Cell[] {
  const { windowStart, windowEnd, bookings, bufferMinutes, durationMinutes, selectedStarts } = args;
  if (windowEnd <= windowStart) return [];
  // Sort bookings by start so the cascade walks chronologically.
  const sorted = [...bookings].sort((a, b) => a.s - b.s);
  const out: Cell[] = [];
  let cursor = windowStart;

  const emitFreeCascade = (until: number) => {
    while (cursor + durationMinutes <= until) {
      const slotStart = cursor;
      const slotEnd = cursor + durationMinutes;
      const key = formatHHMM(slotStart);
      const isSelected = selectedStarts.has(key);
      out.push({
        start: slotStart,
        end: slotEnd,
        state: isSelected ? "selected" : "free",
        label: formatLabel(slotStart),
      });
      cursor += durationMinutes;
    }
  };

  for (const b of sorted) {
    // Skip bookings that are entirely outside the working window.
    if (b.e <= windowStart || b.s >= windowEnd) continue;
    // Emit any free cells before this booking starts.
    emitFreeCascade(b.s);
    // Emit one cell for the booked block itself.
    const bookedStart = Math.max(windowStart, b.s);
    const bookedEnd = Math.min(windowEnd, b.e);
    out.push({
      start: bookedStart,
      end: bookedEnd,
      state: "booked",
      label: `${formatLabel(bookedStart)} – ${formatLabel(bookedEnd)}`,
      subLabel: b.label,
    });
    // Emit an explicit buffer cell so the legend's yellow chip actually
    // corresponds to something visible on the strip. Previously the buffer
    // was implicit (just a jump in the cursor), so users saw the legend
    // entry but no buffer cell on the day — making it look like the
    // 15-minute gap wasn't honoured.
    if (bufferMinutes > 0 && bookedEnd < windowEnd) {
      const bufferEnd = Math.min(windowEnd, bookedEnd + bufferMinutes);
      out.push({
        start: bookedEnd,
        end: bufferEnd,
        state: "buffer",
        label: `+${bufferEnd - bookedEnd}m`,
      });
    }
    // Restart cascade after the booking + buffer. We snap forward to
    // the next minute boundary so we don't lose precision; the actual
    // emitted slot label keeps the literal HH:MM minute (e.g. 1:15 PM).
    cursor = Math.max(cursor, bookedEnd + bufferMinutes);
  }
  // Tail cascade after the last booking.
  emitFreeCascade(windowEnd);

  return out;
}

export default function TransportScheduleStrip({
  windowStart, windowEnd, bookings, bufferMinutes = 0,
  selectedStarts, onToggleSlot, durationMinutes = 60, caption, minStartMinutes,
}: ScheduleStripProps) {
  const startMin = parseHHMM(windowStart);
  const endMin = parseHHMM(windowEnd);
  const isOpen = startMin != null && endMin != null && endMin > startMin;

  const cells = useMemo<Cell[]>(() => {
    if (!isOpen) return [];
    const bookingsParsed = bookings
      .map((b) => ({
        s: parseHHMM(b.start) ?? 0,
        e: parseHHMM(b.end) ?? 0,
        label: b.label,
      }))
      .filter((b) => b.e > b.s);
    const built = buildCells({
      windowStart: startMin!,
      windowEnd: endMin!,
      bookings: bookingsParsed,
      bufferMinutes,
      durationMinutes,
      selectedStarts: selectedStarts ?? new Set<string>(),
    });
    // Drop cells that start before the earliest bookable time (past / within
    // the lead-time buffer on today) so they never render.
    return minStartMinutes == null ? built : built.filter((c) => c.start >= minStartMinutes);
  }, [isOpen, startMin, endMin, bookings, bufferMinutes, durationMinutes, selectedStarts, minStartMinutes]);

  if (!isOpen) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 flex items-center justify-between">
        {caption && <span className="text-xs font-medium text-muted-foreground">{caption}</span>}
        <span className="text-xs text-muted-foreground italic">Closed</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 space-y-1.5">
      {caption && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-medium">{caption}</span>
          <span>{formatLabel(startMin!)} – {formatLabel(endMin!)}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {cells.map((cell) => {
          const clickable = !!onToggleSlot && (cell.state === "free" || cell.state === "selected");
          const base = "min-w-[58px] h-9 rounded-md text-[11px] font-semibold flex items-center justify-center select-none transition-colors px-2";
          const cls =
            cell.state === "booked" ? "bg-destructive/15 text-destructive border border-destructive/30 cursor-not-allowed" :
            cell.state === "buffer" ? "bg-yellow-100 text-yellow-800 border border-yellow-300 cursor-not-allowed" :
            cell.state === "selected" ? "bg-primary text-primary-foreground border border-primary shadow-sm" :
            clickable ? "bg-success/10 text-success border border-success/30 hover:bg-success/25 cursor-pointer" :
            "bg-success/5 text-success border border-success/20";
          const slotKey = formatHHMM(cell.start);
          return (
            <button
              key={`${cell.start}-${cell.state}`}
              type="button"
              onClick={() => clickable && onToggleSlot!(slotKey)}
              disabled={!clickable}
              title={
                cell.state === "booked"
                  ? `Booked ${cell.label}`
                  : cell.state === "buffer"
                    ? `${cell.label} buffer after booked trip`
                    : cell.state === "selected"
                      ? `${cell.label} — selected (click to remove)`
                      : `${cell.label} — free`
              }
              className={`${base} ${cls}`}
              aria-pressed={cell.state === "selected"}
              aria-label={`${cell.label} ${cell.state}`}
            >
              {cell.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-success/30 border border-success/40" /> Free</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-destructive/30 border border-destructive/40" /> Booked</span>
        {bufferMinutes > 0 && (
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-yellow-300 border border-yellow-400" /> Buffer {bufferMinutes}m after booked</span>
        )}
        {selectedStarts && selectedStarts.size > 0 && (
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-primary border border-primary" /> Selected ({selectedStarts.size}h)</span>
        )}
      </div>
    </div>
  );
}

/** Pick the working-hours tuple for a given date out of a WorkingHours map.
 *  Tiny helper so callers don't have to translate Date → weekday key. */
export function workingHoursForDate(
  workingHours: Record<string, [string, string] | null | undefined>,
  date: Date,
): { start: string | null; end: string | null } {
  const map: Record<number, string> = { 0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat" };
  const key = map[date.getDay()];
  const tuple = workingHours?.[key];
  if (!Array.isArray(tuple) || tuple.length !== 2) return { start: null, end: null };
  return { start: tuple[0] || null, end: tuple[1] || null };
}
