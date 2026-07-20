/**
 * Tour-package helpers shared by the listing detail card, booking modal
 * package picker, and the host onboarding / edit forms. Keep these small
 * and dependency-free so they can be imported from any surface.
 */

export type WorkingHoursMap = Record<string, [string, string] | null | undefined>;

/** Parse "HH:MM" to minutes-since-midnight. Returns null on bad input. */
function hhmmToMinutes(value: string | undefined | null): number | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  if (h < 0 || h > 24 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

/** Pretty 12-hour formatter — "7am", "12pm", "9:30pm". Trims trailing :00. */
export function formatClock12(hhmm: string): string {
  const mins = hhmmToMinutes(hhmm);
  if (mins == null) return hhmm;
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h24 >= 12 ? "pm" : "am";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, "0")}${period}`;
}

/**
 * Summarize a listing's working-hours map into a single window. Uses the
 * earliest open-day start and the latest open-day end, since tour packages
 * are scheduled day-by-day and the user just wants a sense of "when this
 * driver is generally bookable." Returns null when every day is closed /
 * unset, in which case the surface should hide the line entirely.
 */
export function summarizeWorkingWindow(wh: WorkingHoursMap | undefined | null): string | null {
  if (!wh || typeof wh !== "object") return null;
  let earliest: number | null = null;
  let latest: number | null = null;
  for (const value of Object.values(wh)) {
    if (!Array.isArray(value) || value.length !== 2) continue;
    const start = hhmmToMinutes(value[0]);
    const end = hhmmToMinutes(value[1]);
    if (start == null || end == null || end <= start) continue;
    if (earliest == null || start < earliest) earliest = start;
    if (latest == null || end > latest) latest = end;
  }
  if (earliest == null || latest == null) return null;
  const fmt = (mins: number) => {
    const hh = String(Math.floor(mins / 60)).padStart(2, "0");
    const mm = String(mins % 60).padStart(2, "0");
    return formatClock12(`${hh}:${mm}`);
  };
  return `${fmt(earliest)}–${fmt(latest)}`;
}

/**
 * Returns the widest working-window length (in minutes) across all open
 * days. Used by host-side forms to confirm a package's duration can
 * physically fit inside the driver's onboarded availability — i.e. a 10-hour
 * tour can't run when the only open day is noon–6pm.
 */
export function widestWorkingWindowMinutes(wh: WorkingHoursMap | undefined | null): number {
  if (!wh || typeof wh !== "object") return 0;
  let widest = 0;
  for (const value of Object.values(wh)) {
    if (!Array.isArray(value) || value.length !== 2) continue;
    const start = hhmmToMinutes(value[0]);
    const end = hhmmToMinutes(value[1]);
    if (start == null || end == null || end <= start) continue;
    const span = end - start;
    if (span > widest) widest = span;
  }
  return widest;
}

/** Format a min-max km range, hiding noise when both ends collapse to one
 *  number. "70–90 km" or "85 km". */
export function formatKmRange(min: number | undefined, max: number | undefined): string | null {
  const lo = Number.isFinite(min) && (min as number) > 0 ? Math.round(min as number) : null;
  const hi = Number.isFinite(max) && (max as number) > 0 ? Math.round(max as number) : null;
  if (lo == null && hi == null) return null;
  if (lo != null && hi != null && lo !== hi) return `${lo}–${hi} km`;
  return `${(lo ?? hi) as number} km`;
}

/**
 * Sum the dwellMinutes across a package's stops. Treats missing / non-positive
 * values as 0 so partial entries don't poison the running total. Used by both
 * editor surfaces to flag when the host's per-stop minutes already exceed
 * what they claimed as the tour's total duration.
 */
export function totalDwellMinutes(
  stops: Array<{ dwellMinutes?: number | string | null | undefined }> | undefined | null,
): number {
  if (!Array.isArray(stops)) return 0;
  let sum = 0;
  for (const s of stops) {
    const raw = s?.dwellMinutes;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) sum += n;
  }
  return Math.round(sum);
}

/** Pretty dwell label — "~45 min", "~2 hr", "~1 hr 30 min". */
export function formatDwell(minutes: number | undefined): string | null {
  if (!Number.isFinite(minutes) || (minutes as number) <= 0) return null;
  const m = Math.round(minutes as number);
  if (m < 60) return `~${m} min`;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  if (mm === 0) return `~${hh} hr`;
  return `~${hh} hr ${mm} min`;
}
