// Shared interactive controls used across the redesigned marketplace:
//
//   • DateRangeCalendar — two-month inline calendar for stay check-in/out.
//     Click a date to set check-in, click another to set check-out. Range
//     between is shaded. Clicking a selected endpoint unselects it.
//   • SortPopover — themed dropdown that replaces the OS-styled <select>.
//   • FiltersDialog — centered modal with kind-specific filter groups.
//   • ServiceSlotPicker — multi-day slot picker for /service/:id booking.
//
// All controls share the warm-neutral redesign palette and use the same
// glass-tile surface treatment as the rest of the redesign.

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Minus, Plus, SlidersHorizontal, Star, Users, X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
// All "today" anchors in these calendars are IST, not browser-local: the
// backend rejects scheduledDate < IST-today, so a local-time anchor lets a
// user west of IST pick a chip that is already "yesterday" in India. See
// src/lib/ist-time.ts.
import { istNow, istToday, istTodayIso, isSlotTooSoon } from "@/lib/ist-time";

// ─────────────────────────────────────────────────── DateRangeCalendar ──

export function DateRangeCalendar({
  start, end, onChange, minDate, monthsVisible = 2, disabledDates, blockedDates, priceForDate, basePricePaise, onInvalidRange, allowBlocked = false, compact = false,
}: {
  start: string | null;
  end: string | null;
  onChange: (next: { start: string | null; end: string | null }) => void;
  minDate?: string;
  monthsVisible?: number;
  /** When true, host-blocked nights are still rendered with their distinct
   *  "unavailable" visual but remain SELECTABLE — the host owns the block and
   *  can book over it when creating a booking on a guest's behalf. Booked
   *  nights (real conflicts) stay hard-disabled regardless. Defaults false so
   *  the customer flow is unchanged. */
  allowBlocked?: boolean;
  /** Tighter single-month layout for narrow containers (e.g. the host
   *  "book for a guest" dialog): shorter cells, no per-cell price row, single
   *  column. Defaults false so the customer booking modal is unchanged. */
  compact?: boolean;
  /** ISO `YYYY-MM-DD` strings the backend reports as fully-booked NIGHTS for
   *  this listing/room. Stays use checkout-exclusive semantics, so a booked
   *  date is:
   *    • not selectable as check-in (the guest would be sleeping that night)
   *    • selectable as check-out (they leave that morning, before night N)
   *    • a hard stop for any night strictly inside the range
   *  This mirrors how the backend's booked-dates query expands occupied
   *  nights (scheduled_date .. end_date - 1 day), so the same set drives
   *  both calendars and conflict checks. */
  disabledDates?: Set<string>;
  /** Host-blocked nights (availability override blocked=true). Same checkout-
   *  exclusive treatment as `disabledDates`, but rendered with a distinct
   *  visual so the user understands the host took it offline rather than it
   *  being sold to someone else. */
  blockedDates?: Set<string>;
  /** Custom per-night price overrides in PAISE keyed by ISO date. When
   *  present for a date the cell renders the price beneath the day number
   *  so guests see the effective rate before opening the breakdown. */
  priceForDate?: Map<string, number>;
  /** Listing's effective base nightly price in PAISE. When provided, every
   *  selectable date renders this price beneath the day number — and dates
   *  with a `priceForDate` override use that value instead and get the
   *  custom-price visual. Pass `null`/omit to keep prices off the cells. */
  basePricePaise?: number | null;
  /** Fires when a user picked a checkout that would cross at least one
   *  closed (blocked/booked) night. The selection is rejected silently inside
   *  the calendar; the parent uses this to surface a clear message
   *  ("Your selection includes a booked/blocked night"). The `reason` lets
   *  the caller distinguish booked-vs-blocked when both sets are passed. */
  onInvalidRange?: (info: { reason: 'booked' | 'blocked' | 'mixed'; startIso: string; endIso: string }) => void;
}) {
  const { t } = useLanguage();
  const today = useMemo(() => istToday(), []);
  const min = minDate ? stripTime(new Date(minDate)) : today;
  const [cursor, setCursor] = useState(() => stripTime(start ? new Date(start) : today));

  const months = useMemo(() => Array.from({ length: monthsVisible }, (_, i) => addMonths(cursor, i)), [cursor, monthsVisible]);

  // True when the next click will set/replace the check-IN anchor: either
  // nothing is picked yet, or both endpoints are already locked in (which
  // resets the range to a new check-in). When false the click is treated
  // as a check-OUT, which is exclusive — a booked date is fine to land on.
  const selectingCheckin = !start || Boolean(end);

  // A "closed" night is either booked-by-another-guest (disabledDates) or
  // host-blocked (blockedDates). Both should reject the same way; we keep
  // the two sets separate only so the cell render can show different
  // visuals.
  const closedSet = useMemo(() => {
    if (!disabledDates && !blockedDates) return undefined;
    const out = new Set<string>();
    disabledDates?.forEach((d) => out.add(d));
    // Host bypass: blocked nights don't count as closed, so they stay pickable.
    if (!allowBlocked) blockedDates?.forEach((d) => out.add(d));
    return out;
  }, [disabledDates, blockedDates, allowBlocked]);

  const handleClick = (iso: string) => {
    if (selectingCheckin) {
      if (closedSet?.has(iso)) return; // can't sleep on a closed night
      onChange({ start: iso, end: null });
      return;
    }
    // start is set, end is null — this click resolves the checkout.
    if (iso === start) { onChange({ start: null, end: null }); return; }
    if (new Date(iso) < new Date(start as string)) {
      // Re-anchor as a new check-in; same rule as the selecting branch.
      if (closedSet?.has(iso)) return;
      onChange({ start: iso, end: null });
      return;
    }
    // Checkout is exclusive — iso itself being closed is OK. We only need
    // to verify every night strictly between start and iso is open. If
    // any inner night is closed, fire onInvalidRange so the parent can
    // surface a clear message instead of the click looking like a no-op.
    if (closedSet && rangeIncludesDisabled(start as string, iso, closedSet)) {
      if (onInvalidRange) {
        const reason = classifyRangeConflict(start as string, iso, disabledDates, blockedDates);
        onInvalidRange({ reason, startIso: start as string, endIso: iso });
      }
      return;
    }
    onChange({ start, end: iso });
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-white/85 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-md">
      <div className="mb-2 flex items-center justify-between gap-2">
        <button type="button" onClick={() => setCursor(addMonths(cursor, -1))} className="inline-grid h-8 w-8 place-items-center rounded-full border border-border bg-white text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-90" aria-label={t("rd.ctrl.previousMonth", { defaultValue: "Previous month" })}><ChevronLeft className="h-4 w-4" /></button>
        <div className="text-[12px] font-bold text-muted-foreground">
          {start ? labelFromIso(start) : t("rd.ctrl.selectCheckin", { defaultValue: "Select check-in" })}
          {start && end ? "  →  " : ""}
          {end ? labelFromIso(end) : start ? t("rd.ctrl.selectCheckout", { defaultValue: "Select check-out" }) : ""}
        </div>
        <button type="button" onClick={() => setCursor(addMonths(cursor, 1))} className="inline-grid h-8 w-8 place-items-center rounded-full border border-border bg-white text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-90" aria-label={t("rd.ctrl.nextMonth", { defaultValue: "Next month" })}><ChevronRight className="h-4 w-4" /></button>
      </div>
      <div className={compact ? "grid gap-3" : "grid gap-3 sm:grid-cols-2"}>
        {months.map((m, idx) => (
          <MonthGrid
            key={idx}
            month={m}
            start={start}
            end={end}
            min={min}
            onPick={handleClick}
            disabledDates={disabledDates}
            blockedDates={blockedDates}
            priceForDate={priceForDate}
            basePricePaise={basePricePaise}
            selectingCheckin={selectingCheckin}
            allowBlocked={allowBlocked}
            compact={compact}
          />
        ))}
      </div>
      {(start || end) && (
        <button
          type="button"
          onClick={() => onChange({ start: null, end: null })}
          className="mt-2 inline-flex h-8 items-center gap-1 rounded-full border border-foreground/40 bg-[#8b5e4a]/10 px-3 text-[11px] font-bold text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-95"
        >
          {t("rd.ctrl.clearDates", { defaultValue: "Clear dates" })}
        </button>
      )}
    </div>
  );
}

function MonthGrid({ month, start, end, min, onPick, disabledDates, blockedDates, priceForDate, basePricePaise, selectingCheckin, allowBlocked = false, compact = false }: { month: Date; start: string | null; end: string | null; min: Date; onPick: (iso: string) => void; disabledDates?: Set<string>; blockedDates?: Set<string>; priceForDate?: Map<string, number>; basePricePaise?: number | null; selectingCheckin: boolean; allowBlocked?: boolean; compact?: boolean }) {
  const { t } = useLanguage();
  const year = month.getFullYear();
  const monthIdx = month.getMonth();
  const firstWeekday = new Date(year, monthIdx, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
  const cells: Array<{ iso: string; day: number } | null> = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push({ iso: toIso(new Date(year, monthIdx, d)), day: d });
  return (
    <div>
      <p className="mb-1 text-center text-[11px] font-extrabold uppercase tracking-wide text-foreground">
        {month.toLocaleString("en-IN", { month: "long", year: "numeric" })}
      </p>
      <div className="grid grid-cols-7 gap-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i} className="text-center">{d}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1 text-[12px]">
        {cells.map((cell, i) => {
          if (!cell) return <div key={i} />;
          const isBooked = disabledDates?.has(cell.iso) ?? false;
          const isBlocked = blockedDates?.has(cell.iso) ?? false;
          const isClosed = isBooked || isBlocked;
          // Closed nights (booked OR host-blocked) are HTML-disabled only while
          // the user is choosing a check-IN. When they already have a check-in
          // selected, those dates remain clickable as a checkout-exclusive
          // date; the click handler validates that no inner night is closed.
          // Host bypass: blocked (but not booked) nights stay clickable.
          const closedForPick = allowBlocked ? isBooked : isClosed;
          const disabled = new Date(cell.iso) < min || (closedForPick && selectingCheckin);
          const isStart = cell.iso === start;
          const isEnd = cell.iso === end;
          const inRange = start && end && cell.iso > start && cell.iso < end;
          const isEndpoint = isStart || isEnd;
          const overrideP = priceForDate?.get(cell.iso);
          const hasCustom = overrideP != null;
          // Effective price shown on the cell: override beats base. Custom
          // prices keep an emerald visual; base prices show in muted grey.
          const effectiveP = hasCustom
            ? (overrideP as number)
            : (basePricePaise != null && basePricePaise > 0 ? basePricePaise : null);
          const showPrice = !compact && effectiveP != null && !isClosed && !isEndpoint && !inRange;
          const ariaLabel = isBlocked
            ? t("rd.ctrl.dateUnavailable", { defaultValue: "{{date}} unavailable", date: cell.iso })
            : isBooked
              ? t("rd.ctrl.dateBooked", { defaultValue: "{{date}} booked", date: cell.iso })
              : effectiveP != null
                ? `${cell.iso} ${compactPriceLabel(effectiveP)}${hasCustom ? ' custom' : ''}`
                : cell.iso;
          return (
            <button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => onPick(cell.iso)}
              aria-label={ariaLabel}
              className={`relative ${compact ? "flex h-10 items-center justify-center rounded-lg" : "h-11 rounded-xl"} text-center font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                isBlocked
                  ? "bg-rose-50 text-rose-400 line-through"
                  : isBooked
                    ? "text-muted-foreground line-through"
                    : isEndpoint
                      ? "text-white shadow-sm bg-[linear-gradient(135deg,#2b2436_0%,#7b5244_60%,#8b5e4a_100%)]"
                      : inRange
                        // Light brown wash between the dark-brown endpoints,
                        // matching the warm-tan palette used elsewhere in
                        // the booking surfaces.
                        ? "bg-[hsl(17_55%_88%)] text-foreground"
                        : hasCustom
                          ? "text-foreground hover:bg-muted ring-1 ring-emerald-200"
                          : "text-foreground hover:bg-muted"
              }`}
            >
              <span className="block leading-none">{cell.day}</span>
              {showPrice ? (
                <span className={`mt-0.5 block text-[9px] font-bold leading-none ${hasCustom ? 'text-emerald-700' : 'text-muted-foreground'}`}>
                  {compactPriceLabel(effectiveP as number)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Walks nights between `startIso` (inclusive) and `endIso` (exclusive — the
 *  checkout day, which the next guest can occupy) and returns true if any
 *  fall in the booked set. Used to refuse a check-out pick that would
 *  silently bridge over a fully-booked night. */
function rangeIncludesDisabled(startIso: string, endIso: string, disabled: Set<string>): boolean {
  if (endIso <= startIso) return false;
  const cur = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  while (cur < end) {
    const iso = cur.toISOString().slice(0, 10);
    if (disabled.has(iso)) return true;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return false;
}

/** Classify whether a rejected range crosses booked nights, host-blocked
 *  nights, or both. Used to tailor the user-facing message ("includes a
 *  booked night" vs "includes a host-blocked night" vs the generic
 *  "unavailable"). */
function classifyRangeConflict(
  startIso: string,
  endIso: string,
  bookedDates?: Set<string>,
  blockedDates?: Set<string>,
): 'booked' | 'blocked' | 'mixed' {
  let hitBooked = false;
  let hitBlocked = false;
  const cur = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  while (cur < end) {
    const iso = cur.toISOString().slice(0, 10);
    if (bookedDates?.has(iso)) hitBooked = true;
    if (blockedDates?.has(iso)) hitBlocked = true;
    if (hitBooked && hitBlocked) return 'mixed';
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  if (hitBooked && hitBlocked) return 'mixed';
  if (hitBlocked) return 'blocked';
  return 'booked';
}

/** Render a paise amount as a compact INR badge for a date cell. Use ₹1.2k
 *  above ₹999 to keep cells readable on mobile; sub-₹1000 prints in full. */
function compactPriceLabel(paise: number): string {
  const rupees = Math.round(paise / 100);
  if (rupees >= 1000) {
    const k = rupees / 1000;
    return `₹${k.toFixed(k < 10 ? 1 : 0).replace(/\.0$/, "")}k`;
  }
  return `₹${rupees}`;
}

function stripTime(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addMonths(d: Date, n: number) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function toIso(d: Date) { const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, "0"); const dd = String(d.getDate()).padStart(2, "0"); return `${y}-${m}-${dd}`; }
function labelFromIso(iso: string) { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
/** Parse a YYYY-MM-DD as a LOCAL date — `new Date(iso)` parses as UTC
 *  midnight, which is the previous local day in any timezone west of UTC.
 *  Local construction keeps weekday + getDate accurate everywhere. */
export function localDateFromIso(iso: string): Date {
  const [yy, mm, dd] = iso.split("-").map(Number);
  return new Date(yy, (mm || 1) - 1, dd || 1);
}
export function addDaysIso(iso: string, days: number): string {
  const d = localDateFromIso(iso);
  d.setDate(d.getDate() + days);
  return toIso(d);
}
/** Monday-of-week iso for the week containing `iso`. Weeks here are Mon→Sun
 *  to match the IST norm; calendars rendered Sun→Sat still work because the
 *  strip's grid lays them out left-to-right from the anchor, ignoring locale
 *  week-start. */
function mondayOfIso(iso: string): string {
  const d = localDateFromIso(iso);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const delta = dow === 0 ? -6 : -(dow - 1);
  d.setDate(d.getDate() + delta);
  return toIso(d);
}

// ───────────────────────────────────────────────────────── SortPopover ──

export type SortValue = "recommended" | "price-asc" | "price-desc" | "rating";

export function SortPopover({ value, onChange }: { value: SortValue; onChange: (v: SortValue) => void }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Portal-positioned dropdown so the Google Maps render layer can't paint
  // over it. The portal lives directly under <body>, escaping any stacking
  // context created by the cards/map grid.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScrollOrResize = () => setOpen(false);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const menuWidth = 224; // matches w-56 below
    const top = rect.bottom + 8; // 8px gap, mirrors mt-2
    const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth));
    setMenuPos({ top, left });
  }, [open]);

  const options: Array<{ value: SortValue; label: string }> = [
    { value: "recommended", label: t("rd.ctrl.sortRecommended", { defaultValue: "Recommended" }) },
    { value: "price-asc", label: t("rd.ctrl.sortPriceAsc", { defaultValue: "Price: low to high" }) },
    { value: "price-desc", label: t("rd.ctrl.sortPriceDesc", { defaultValue: "Price: high to low" }) },
    { value: "rating", label: t("rd.ctrl.sortTopRated", { defaultValue: "Top rated" }) },
  ];
  const current = options.find((o) => o.value === value);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("rd.ctrl.sortBy", { defaultValue: "Sort by" })}
        className="inline-flex min-h-[46px] items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-[13px] font-bold text-foreground shadow-sm transition-colors hover:bg-muted active:bg-muted/70"
      >
        <span className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.ctrl.sort", { defaultValue: "Sort" })}</span>
        {current?.label}
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("rd.ctrl.sortBy", { defaultValue: "Sort by" })}
          style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: 224, zIndex: 200 }}
          className="overflow-hidden rounded-2xl border border-border bg-white py-1 shadow-[0_28px_86px_rgba(34,31,39,0.18)]"
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={value === o.value}
              onClick={() => { onChange(o.value); setOpen(false); buttonRef.current?.focus(); }}
              className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus:outline-none ${
                value === o.value ? "font-bold text-foreground" : "text-foreground/90"
              }`}
            >
              {o.label}
              {value === o.value && <Check className="h-3.5 w-3.5 text-accent" aria-hidden="true" />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

// ─────────────────────────────────────────────────── DateRangePopover ──

/** Shared portal-popover positioner. Mirrors SortPopover's behaviour: closes
 *  on outside click, repositions (not closes) on scroll/resize, and clamps the
 *  panel inside the viewport. `align` decides whether the panel's left edge or
 *  right edge tracks the trigger — right-align keeps a wide calendar from
 *  spilling off-screen when the trigger sits near the right of the toolbar. */
function usePopoverPosition(
  open: boolean,
  buttonRef: React.RefObject<HTMLButtonElement>,
  width: number,
  align: "left" | "right" = "left",
) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const place = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const anchored = align === "right" ? rect.right - width : rect.left;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchored));
    setPos({ top: rect.bottom + 8, left });
  }, [align, buttonRef, width]);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);
  return pos;
}

/** True while `open`, registers a document mousedown listener that closes the
 *  popover when the click lands outside both the trigger and the panel. Also
 *  closes on the Escape key so keyboard users aren't trapped. */
function useDismissOnOutside(
  open: boolean,
  refs: Array<React.RefObject<HTMLElement>>,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (refs.some((r) => r.current?.contains(target))) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, refs, close]);
}

const PANEL_CLASS = "rounded-[20px] border border-border bg-white shadow-[0_28px_86px_rgba(34,31,39,0.20)]";

function nightsBetween(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((b - a) / 86400000));
}

/** Toolbar trigger that opens the DateRangeCalendar in a portal-positioned
 *  dropdown — same portal treatment as SortPopover so the map render layer
 *  can't paint over it. Shows two months side by side (like the booking
 *  modal), a live header, a nights summary, and Clear/Apply actions. Acts as
 *  a check-in → check-out filter: the caller narrows the listings by the
 *  chosen range (and logs it). */
export function DateRangePopover({
  start,
  end,
  onChange,
}: {
  start: string | null;
  end: string | null;
  onChange: (next: { start: string | null; end: string | null }) => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPos = usePopoverPosition(open, buttonRef, 640, "left");
  const closeRefs = useMemo(() => [buttonRef, menuRef], []);
  useDismissOnOutside(open, closeRefs, () => setOpen(false));

  const nights = nightsBetween(start, end);
  const label = start && end
    ? `${labelFromIso(start)} → ${labelFromIso(end)}`
    : start
      ? `${labelFromIso(start)} → …`
      : t("rd.ctrl.addDates", { defaultValue: "Add dates" });

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("rd.ctrl.chooseDates", { defaultValue: "Choose your dates" })}
        className={`inline-flex min-h-[46px] items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-bold shadow-sm transition-colors ${
          start ? "border-foreground bg-foreground text-white" : "border-border bg-card text-foreground hover:bg-muted active:bg-muted/70"
        }`}
      >
        <CalendarDays className="h-[18px] w-[18px]" aria-hidden="true" /> {label}
      </button>
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          role="dialog"
          aria-label={t("rd.ctrl.chooseDates", { defaultValue: "Choose your dates" })}
          style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: "min(640px, calc(100vw - 16px))", zIndex: 200 }}
          className={PANEL_CLASS}
        >
          <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
            <div>
              <p className="font-display text-[15px] font-extrabold text-foreground">{t("rd.ctrl.chooseDates", { defaultValue: "Choose your dates" })}</p>
              <p className="text-[12px] font-semibold text-muted-foreground">
                {nights > 0
                  ? t("rd.ctrl.nightsSelected", { defaultValue: "{{count}} night stay", count: nights })
                  : t("rd.ctrl.selectCheckinCheckout", { defaultValue: "Select check-in and check-out" })}
              </p>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label={t("rd.ctrl.close", { defaultValue: "Close" })} className="inline-grid h-11 w-11 place-items-center rounded-full border border-border bg-white text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white active:scale-90 focus-visible:ring-2 focus-visible:ring-primary/40"><X className="h-4 w-4" aria-hidden="true" /></button>
          </header>
          <div className="p-3">
            <DateRangeCalendar
              start={start}
              end={end}
              monthsVisible={2}
              onChange={onChange}
            />
          </div>
          <footer className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
            <button
              type="button"
              onClick={() => onChange({ start: null, end: null })}
              className="text-[13px] font-bold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40"
              disabled={!start && !end}
            >
              {t("rd.ctrl.clearDates", { defaultValue: "Clear dates" })}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex h-10 items-center justify-center rounded-full px-6 text-[13px] font-extrabold text-white shadow-[0_14px_30px_rgba(58,50,71,0.20)]"
              style={{ background: "linear-gradient(135deg, #2b2436 0%, #7b5244 60%, #8b5e4a 100%)" }}
            >
              {t("rd.ctrl.apply", { defaultValue: "Apply" })}
            </button>
          </footer>
        </div>,
        document.body,
      )}
    </>
  );
}

// Single-day picker for the services/transport marketplace (a service is
// booked for ONE day, not a night range). Same pill + portal-panel anatomy as
// DateRangePopover, but a compact single-month grid with single-select. The
// chosen day filters the grid server-side (fully-booked listings drop out).
export function DayPopover({
  value,
  onChange,
  placeholder,
}: {
  value: string | null;
  onChange: (day: string | null) => void;
  placeholder?: string;
}) {
  const { t, language } = useLanguage();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPos = usePopoverPosition(open, buttonRef, 320, "left");
  const closeRefs = useMemo(() => [buttonRef, menuRef], []);
  useDismissOnOutside(open, closeRefs, () => setOpen(false));

  const todayIso = istTodayIso();
  const [view, setView] = useState(() => {
    const base = localDateFromIso(value ?? todayIso);
    return { y: base.getFullYear(), m: base.getMonth() };
  });

  const monthStart = new Date(view.y, view.m, 1);
  // en → en-IN so English dates read day-first ("26 Jul"), matching the rest of
  // this India-focused app; other languages format naturally.
  const locale = language === "en" ? "en-IN" : language;
  // Month header + weekday initials come straight from Intl for the active
  // language, so they're always correct without hand-translated locale keys.
  const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(monthStart);
  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 7 + i))); // 2024-01-07 = Sunday
  }, [locale]);
  // Format a YYYY-MM-DD by parsing it as a LOCAL date (localDateFromIso), not
  // `new Date(iso)` (UTC) — the latter shifts the displayed day back one in
  // behind-UTC timezones, so the pill/cell label would disagree with the value.
  const fmtDay = useMemo(() => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }), [locale]);
  const dayLabel = (iso: string) => fmtDay.format(localDateFromIso(iso));
  const firstWeekday = monthStart.getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push(`${view.y}-${String(view.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  const tY = Number(todayIso.slice(0, 4));
  const tM = Number(todayIso.slice(5, 7)) - 1;
  const canGoPrev = view.y > tY || (view.y === tY && view.m > tM);
  const shiftMonth = (delta: number) => setView((v) => {
    const d = new Date(v.y, v.m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("rd.ctrl.chooseDay", { defaultValue: "Choose a day" })}
        className={`inline-flex min-h-[46px] items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-bold shadow-sm transition-colors ${
          value ? "border-foreground bg-foreground text-white" : "border-border bg-card text-foreground hover:bg-muted active:bg-muted/70"
        }`}
      >
        <CalendarDays className="h-[18px] w-[18px]" aria-hidden="true" /> {value ? dayLabel(value) : (placeholder ?? t("rd.ctrl.anyDay", { defaultValue: "Any day" }))}
      </button>
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          role="dialog"
          aria-label={t("rd.ctrl.chooseDay", { defaultValue: "Choose a day" })}
          style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: "min(320px, calc(100vw - 16px))", zIndex: 200 }}
          className={PANEL_CLASS}
        >
          <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
            <button type="button" onClick={() => shiftMonth(-1)} disabled={!canGoPrev} aria-label={t("rd.ctrl.previousMonth", { defaultValue: "Previous month" })} className="inline-grid h-9 w-9 place-items-center rounded-full border border-border bg-white text-foreground shadow-sm transition-all hover:border-foreground disabled:opacity-30 disabled:hover:border-border"><ChevronLeft className="h-4 w-4" aria-hidden="true" /></button>
            <p className="font-display text-[14px] font-extrabold text-foreground">{monthLabel}</p>
            <button type="button" onClick={() => shiftMonth(1)} aria-label={t("rd.ctrl.nextMonth", { defaultValue: "Next month" })} className="inline-grid h-9 w-9 place-items-center rounded-full border border-border bg-white text-foreground shadow-sm transition-all hover:border-foreground"><ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
          </header>
          <div className="p-3">
            <div className="grid grid-cols-7 gap-1">
              {weekdayLabels.map((w, i) => (
                <div key={i} className="grid h-8 place-items-center text-[11px] font-extrabold uppercase text-muted-foreground">{w}</div>
              ))}
              {cells.map((iso, i) => {
                if (!iso) return <div key={`e${i}`} />;
                const past = iso < todayIso;
                const selected = iso === value;
                return (
                  <button
                    key={iso}
                    type="button"
                    disabled={past}
                    onClick={() => { onChange(iso); setOpen(false); }}
                    aria-pressed={selected}
                    aria-label={dayLabel(iso)}
                    className={`grid h-9 place-items-center rounded-full text-[13px] font-bold transition-colors ${
                      selected ? "bg-foreground text-white" : past ? "text-muted-foreground/35" : "text-foreground hover:bg-muted"
                    }`}
                  >
                    {Number(iso.slice(8, 10))}
                  </button>
                );
              })}
            </div>
          </div>
          <footer className="flex items-center justify-end border-t border-border/60 px-3 py-2.5">
            <button
              type="button"
              onClick={() => { onChange(null); setOpen(false); }}
              className="text-[13px] font-bold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40"
              disabled={!value}
            >
              {t("rd.ctrl.clearDay", { defaultValue: "Clear day" })}
            </button>
          </footer>
        </div>,
        document.body,
      )}
    </>
  );
}

// ──────────────────────────────────────────────────────── GuestsPopover ──

/** Single-total stepper. Default "guests" variant drives the stays
 *  `minGuests` filter — the marketplace shows any stay (or room type) that
 *  sleeps at least this many. The "passengers" variant is the same stepper
 *  reworded for transport's `minSeats` filter (vehicle seats at least this
 *  many). `value === 1` is the neutral "any" state (the trigger reads
 *  "Guests"/"Passengers" and renders inactive); 2+ engages the filter. */
export function GuestsPopover({
  value,
  onChange,
  max = 16,
  variant = "guests",
}: {
  value: number;
  onChange: (n: number) => void;
  max?: number;
  variant?: "guests" | "passengers";
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPos = usePopoverPosition(open, buttonRef, 260, "left");
  const closeRefs = useMemo(() => [buttonRef, menuRef], []);
  useDismissOnOutside(open, closeRefs, () => setOpen(false));

  const isPassengers = variant === "passengers";
  const noun = isPassengers
    ? t("rd.ctrl.passengers", { defaultValue: "Passengers" })
    : t("rd.ctrl.guests", { defaultValue: "Guests" });
  const active = value > 1;
  const label = active
    ? (isPassengers
      ? t("rd.ctrl.passengersCount", { defaultValue: "{{count}} passengers", count: value })
      : t("rd.ctrl.guestsCount", { defaultValue: "{{count}} guests", count: value }))
    : noun;
  const clamp = (n: number) => Math.max(1, Math.min(max, n));

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={noun}
        className={`inline-flex min-h-[46px] items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-bold shadow-sm transition-colors ${
          active ? "border-foreground bg-foreground text-white" : "border-border bg-card text-foreground hover:bg-muted active:bg-muted/70"
        }`}
      >
        <Users className="h-[18px] w-[18px]" aria-hidden="true" /> {label}
      </button>
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          role="dialog"
          aria-label={noun}
          style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: 260, zIndex: 200 }}
          className={`${PANEL_CLASS} p-4`}
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[14px] font-extrabold text-foreground">{noun}</p>
              <p className="text-[12px] font-semibold text-muted-foreground">
                {isPassengers
                  ? t("rd.ctrl.passengersHint", { defaultValue: "Seats at least" })
                  : t("rd.ctrl.guestsHint", { defaultValue: "Sleeps at least" })}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => onChange(clamp(value - 1))}
                disabled={value <= 1}
                aria-label={isPassengers
                  ? t("rd.ctrl.decreasePassengers", { defaultValue: "Fewer passengers" })
                  : t("rd.ctrl.decreaseGuests", { defaultValue: "Fewer guests" })}
                className="inline-grid h-9 w-9 place-items-center rounded-full border border-border bg-white text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-white disabled:hover:text-foreground"
              >
                <Minus className="h-4 w-4" />
              </button>
              <span className="min-w-[24px] text-center text-[16px] font-extrabold tabular-nums text-foreground">{value}</span>
              <button
                type="button"
                onClick={() => onChange(clamp(value + 1))}
                disabled={value >= max}
                aria-label={isPassengers
                  ? t("rd.ctrl.increasePassengers", { defaultValue: "More passengers" })
                  : t("rd.ctrl.increaseGuests", { defaultValue: "More guests" })}
                className="inline-grid h-9 w-9 place-items-center rounded-full border border-border bg-white text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-white disabled:hover:text-foreground"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>
          {active && (
            <button
              type="button"
              onClick={() => { onChange(1); }}
              className="mt-3 text-[13px] font-bold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t("rd.ctrl.clear", { defaultValue: "Clear" })}
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

// ────────────────────────────────────────────────────── FiltersDialog ──

export type StayFilters = {
  /** Multi-select. Empty array means "any type" (no filter). Each entry is
   *  a chip label like "Hotel" / "Village stay" / "Sathram"; the filter
   *  loop normalizes to the backend's hyphenated-lowercase property_type
   *  before comparing. Replaces the old single-value `type: string` field. */
  types: string[];
  priceMax: number;
  ratingMin: number;
  verifiedOnly: boolean;
  amenities: string[];
  minGuests: number;
  minRooms: number;
  minBaths: number;
};

export type ServiceFilters = {
  /** Multi-select. Empty array = "any category" (no filter). Each entry is
   *  a chip label like "cleaning" or "Deep Cleaning"; the filter loop does
   *  a case-insensitive substring match in either direction so parent
   *  buckets ("cleaning") catch subcategory listings ("Deep Cleaning") and
   *  vice versa. Replaces the old single-value `category: string` field. */
  categories: string[];
  priceMax: number;
  ratingMin: number;
  verifiedOnly: boolean;
  modes: Array<"at-home" | "visit-provider" | "online">;
  languages: string[];
};

export type TransportFilters = {
  /** Multi-select vehicle / service type chips. Empty array = "any". Each
   *  entry is either a catalog id ("auto_rickshaw") or a free-text
   *  display label, matching the original `vehicleType` semantics for the
   *  consumer-side filter loop. Replaces the old `vehicleType: string`. */
  vehicleTypes: string[];
  bookingModes: Array<"hourly" | "day" | "package" | "point">;
  priceMax: number;          // per-km cap (no longer surfaced in UI; left
                             // on the type so existing callers / saved
                             // searches stay valid — the filter just
                             // treats this as effectively-unbounded.)
  pricePerHourMax: number;   // 0 = any
  pricePerDayMax: number;    // 0 = any
  ratingMin: number;
  minSeats: number;
  languages: string[];
  verifiedOnly: boolean;
};

export const STAY_FILTER_DEFAULT: StayFilters = {
  types: [], priceMax: 10000, ratingMin: 0, verifiedOnly: false,
  amenities: [], minGuests: 1, minRooms: 0, minBaths: 0,
};
export const SERVICE_FILTER_DEFAULT: ServiceFilters = {
  categories: [], priceMax: 5000, ratingMin: 0, verifiedOnly: false, modes: [], languages: [],
};
export const TRANSPORT_FILTER_DEFAULT: TransportFilters = {
  vehicleTypes: [], bookingModes: [], priceMax: 100, pricePerHourMax: 0, pricePerDayMax: 0,
  ratingMin: 0, minSeats: 1, languages: [], verifiedOnly: false,
};

export const STAY_AMENITY_OPTIONS = [
  "WiFi", "AC", "Parking", "Kitchen", "Breakfast", "Pool",
  "Pet friendly", "Workspace", "Hot water", "Power backup",
  "Restaurant", "Laundry",
];
export const SERVICE_LANGUAGE_OPTIONS = ["English", "Hindi", "Telugu", "Tamil", "Kannada", "Marathi", "Malayalam"];
export const TRANSPORT_LANGUAGE_OPTIONS = ["English", "Hindi", "Telugu", "Tamil", "Kannada", "Marathi", "Malayalam"];

type FiltersConfig =
  | { kind: "stays"; value: StayFilters; onApply: (v: StayFilters) => void; typeOptions: string[] }
  | { kind: "services"; value: ServiceFilters; onApply: (v: ServiceFilters) => void; categoryOptions: string[] }
  | { kind: "transport"; value: TransportFilters; onApply: (v: TransportFilters) => void; typeOptions: string[]; typeLabels?: Record<string, string> };

export function FiltersButton({ onOpen }: { onOpen: () => void }) {
  const { t } = useLanguage();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex min-h-[46px] items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-[13px] font-bold text-foreground shadow-sm transition-colors hover:bg-muted active:bg-muted/70"
    >
      <SlidersHorizontal className="h-[17px] w-[17px]" /> {t("rd.ctrl.filters", { defaultValue: "Filters" })}
    </button>
  );
}

export function FiltersDialog({ open, onClose, config }: { open: boolean; onClose: () => void; config: FiltersConfig }) {
  const { t } = useLanguage();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // Keep the latest onClose without making it an effect dependency — otherwise a
  // parent re-render (new onClose identity) would tear down + re-run the focus
  // effect, and its cleanup would yank focus back out of the dialog.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Local draft so users can adjust + cancel without dirtying the source state.
  const [draft, setDraft] = useState<any>(config.value);
  useEffect(() => { if (open) setDraft(config.value); }, [open, config.value]);
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);
  // Keyboard-accessible modal: remember the trigger, move focus into the
  // dialog, trap Tab inside it, close on Escape, and restore focus on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    // Move focus into the dialog. Focus the panel itself (tabIndex -1) as a
    // reliable anchor, then hand off to the first real control. A 0ms timer
    // backstops the synchronous focus in case a synthetic open event (e.g. a
    // programmatic click) resolves focus to the trigger after this effect.
    const moveFocusIn = () => {
      if (panelRef.current?.contains(document.activeElement)) return;
      (focusables()[0] ?? panelRef.current)?.focus();
    };
    moveFocusIn();
    const focusTimer = setTimeout(moveFocusIn, 0);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCloseRef.current(); return; }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && (active === first || !panelRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open]);
  if (!open) return null;

  const apply = () => { config.onApply(draft); onClose(); };
  const reset = () => {
    if (config.kind === "stays") setDraft(STAY_FILTER_DEFAULT);
    else if (config.kind === "services") setDraft(SERVICE_FILTER_DEFAULT);
    else setDraft(TRANSPORT_FILTER_DEFAULT);
  };

  return (
    // Offset the overlay top so the dialog never visually collides with the
    // sticky glass navbar (~86px tall incl. safe-area). On mobile we
    // top-align with extra top padding; on sm+ we center vertically inside the
    // remaining viewport so the dialog still feels balanced.
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[120] flex items-start justify-center bg-black/50 px-4 pt-[96px] pb-6 backdrop-blur-sm sm:items-center sm:pt-[110px]"
      onClick={onClose}
    >
      <div ref={panelRef} tabIndex={-1} onClick={(e) => e.stopPropagation()} className="relative grid w-full max-w-[560px] gap-4 overflow-hidden rounded-[20px] border border-white/70 bg-white/95 p-5 shadow-[0_28px_86px_rgba(34,31,39,0.22)] backdrop-blur-2xl outline-none sm:p-6 max-h-[calc(100vh-120px)]">
        <header className="flex items-center justify-between">
          <h3 id={titleId} className="font-display text-lg font-extrabold text-foreground">{t("rd.ctrl.filters", { defaultValue: "Filters" })}</h3>
          <button type="button" onClick={onClose} aria-label={t("rd.ctrl.closeFilters", { defaultValue: "Close filters" })} className="inline-grid h-11 w-11 place-items-center rounded-full border border-border bg-white text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-90 focus-visible:ring-2 focus-visible:ring-primary/40"><X className="h-4 w-4" aria-hidden="true" /></button>
        </header>

        {config.kind === "stays" && (
          <StayFilterBody value={draft} setValue={setDraft} typeOptions={config.typeOptions} />
        )}
        {config.kind === "services" && (
          <ServiceFilterBody value={draft} setValue={setDraft} categoryOptions={config.categoryOptions} />
        )}
        {config.kind === "transport" && (
          <TransportFilterBody value={draft} setValue={setDraft} typeOptions={config.typeOptions} typeLabels={config.typeLabels} />
        )}

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <button type="button" onClick={reset} className="inline-flex h-10 items-center gap-2 rounded-full border border-border bg-white px-4 text-sm font-bold text-muted-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-95">{t("rd.ctrl.reset", { defaultValue: "Reset" })}</button>
          <button type="button" onClick={apply} className="inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-sm font-extrabold text-white shadow-[0_14px_30px_rgba(58,50,71,0.20)]" style={{ background: "linear-gradient(135deg, #2b2436 0%, #7b5244 60%, #8b5e4a 100%)" }}>
            {t("rd.ctrl.applyFilters", { defaultValue: "Apply filters" })}
          </button>
        </footer>
      </div>
    </div>
  );
}

function StayFilterBody({ value, setValue, typeOptions }: { value: StayFilters; setValue: (v: StayFilters) => void; typeOptions: string[] }) {
  const { t } = useLanguage();
  return (
    <div className="grid gap-4 max-h-[60vh] overflow-y-auto pr-1">
      <FilterGroup label={t("rd.ctrl.propertyType", { defaultValue: "Property type" })}>
        {/* Multi-select: tap a chip to add it, tap an active chip to remove it.
            Empty selection ≡ "any property type" (no filter), so we drop the
            previous synthetic "All" chip — selecting nothing IS all. */}
        <MultiChipRow
          options={typeOptions.filter((t) => t !== "All")}
          values={value.types}
          onChange={(types) => setValue({ ...value, types })}
        />
      </FilterGroup>
      <FilterGroup label={t("rd.ctrl.priceUpToNight", { defaultValue: "Price up to ₹{{amount}}/night", amount: value.priceMax.toLocaleString() })}>
        <input type="range" min={500} max={20000} step={100} value={value.priceMax} onChange={(e) => setValue({ ...value, priceMax: Number(e.target.value) })} className="w-full accent-accent" />
      </FilterGroup>
      <FilterGroup label={t("rd.ctrl.minimumRating", { defaultValue: "Minimum rating" })}>
        <RatingRow value={value.ratingMin} onChange={(r) => setValue({ ...value, ratingMin: r })} />
      </FilterGroup>
      <FilterGroup label={t("rd.ctrl.guestsAtLeast", { defaultValue: "Guests: at least {{count}}", count: value.minGuests })}>
        <input type="range" min={1} max={12} step={1} value={value.minGuests} onChange={(e) => setValue({ ...value, minGuests: Number(e.target.value) })} className="w-full accent-accent" />
      </FilterGroup>
      <FilterGroup label={value.minRooms === 0 ? t("rd.ctrl.bedroomsAny", { defaultValue: "Bedrooms: any" }) : t("rd.ctrl.bedroomsMin", { defaultValue: "Bedrooms: {{count}}+", count: value.minRooms })}>
        <input type="range" min={0} max={6} step={1} value={value.minRooms} onChange={(e) => setValue({ ...value, minRooms: Number(e.target.value) })} className="w-full accent-accent" />
      </FilterGroup>
      <FilterGroup label={value.minBaths === 0 ? t("rd.ctrl.bathroomsAny", { defaultValue: "Bathrooms: any" }) : t("rd.ctrl.bathroomsMin", { defaultValue: "Bathrooms: {{count}}+", count: value.minBaths })}>
        <input type="range" min={0} max={6} step={1} value={value.minBaths} onChange={(e) => setValue({ ...value, minBaths: Number(e.target.value) })} className="w-full accent-accent" />
      </FilterGroup>
      <FilterGroup label={t("rd.ctrl.amenities", { defaultValue: "Amenities" })}>
        <MultiChipRow
          options={STAY_AMENITY_OPTIONS}
          values={value.amenities}
          onChange={(amenities) => setValue({ ...value, amenities })}
        />
      </FilterGroup>
      {/* "Verified hosts only" toggle removed from stay filters per product
          feedback — too few listings are verified yet for the toggle to be
          useful, and it was hiding otherwise valid stays. The `verifiedOnly`
          field is still in `StayFilters` so saved-search URLs / tests don't
          break; the filter loop just sees it permanently false. */}
    </div>
  );
}

function ServiceFilterBody({ value, setValue, categoryOptions }: { value: ServiceFilters; setValue: (v: ServiceFilters) => void; categoryOptions: string[] }) {
  const { t } = useLanguage();
  return (
    <div className="grid gap-4 max-h-[60vh] overflow-y-auto pr-1">
      <FilterGroup label={t("rd.ctrl.category", { defaultValue: "Category" })}>
        {/* Multi-select: tap to add, tap an active chip to remove. Empty
            selection = "any category", so the previous "All" chip is
            redundant and dropped from the options. */}
        <MultiChipRow
          options={categoryOptions.filter((c) => c !== "All")}
          values={value.categories}
          onChange={(categories) => setValue({ ...value, categories })}
        />
      </FilterGroup>
      {/* "Service mode" (at home / visit provider / online) chips removed per
          product feedback — redundant with the category + listing detail info.
          The `modes` field stays on `ServiceFilters` so the filter loop and
          saved state don't break; it's just always empty (= "any") from here. */}
      <FilterGroup label={t("rd.ctrl.priceUpTo", { defaultValue: "Price up to ₹{{amount}}", amount: value.priceMax.toLocaleString() })}>
        <input type="range" min={200} max={10000} step={100} value={value.priceMax} onChange={(e) => setValue({ ...value, priceMax: Number(e.target.value) })} className="w-full accent-accent" />
      </FilterGroup>
      <FilterGroup label={t("rd.ctrl.languagesSpoken", { defaultValue: "Languages spoken" })}>
        <MultiChipRow
          options={SERVICE_LANGUAGE_OPTIONS}
          values={value.languages}
          onChange={(languages) => setValue({ ...value, languages })}
        />
      </FilterGroup>
      <FilterGroup label={t("rd.ctrl.minimumRating", { defaultValue: "Minimum rating" })}>
        <RatingRow value={value.ratingMin} onChange={(r) => setValue({ ...value, ratingMin: r })} />
      </FilterGroup>
      {/* "Verified providers only" toggle removed per product feedback —
          parity with the stays filter, and too few service providers are
          verified yet for the toggle to be useful. The `verifiedOnly`
          field stays on `ServiceFilters` so existing callers don't break;
          it's just permanently false from this surface. */}
    </div>
  );
}

function TransportFilterBody({ value, setValue, typeOptions, typeLabels }: { value: TransportFilters; setValue: (v: TransportFilters) => void; typeOptions: string[]; typeLabels?: Record<string, string> }) {
  const { t } = useLanguage();
  return (
    <div className="grid gap-4 max-h-[60vh] overflow-y-auto pr-1">
      <FilterGroup label={t("rd.ctrl.vehicleServiceType", { defaultValue: "Vehicle / service type" })}>
        {/* Multi-select: tap to add, tap an active chip to remove. Empty
            selection = "any type" so the previous "All" chip is dropped
            from the options. */}
        <MultiChipRow
          options={typeOptions.filter((t) => t !== "All")}
          values={value.vehicleTypes}
          onChange={(vehicleTypes) => setValue({ ...value, vehicleTypes })}
          labels={typeLabels}
        />
      </FilterGroup>
      <FilterGroup label={t("rd.ctrl.bookingMode", { defaultValue: "Booking mode" })}>
        <MultiChipRow
          options={["hourly", "day", "package"]}
          labels={{ hourly: t("rd.ctrl.modeHourly", { defaultValue: "Hourly" }), day: t("rd.ctrl.modeDayRental", { defaultValue: "Day rental" }), package: t("rd.ctrl.modeTourPackage", { defaultValue: "Tour package" }) }}
          values={value.bookingModes}
          onChange={(modes) => setValue({ ...value, bookingModes: modes as TransportFilters["bookingModes"] })}
        />
      </FilterGroup>
      {/* Per-km price slider removed per product feedback — most listings
          run on hourly / day / package rates, and the per-km cap was
          quietly filtering out otherwise-valid options. The `priceMax`
          field stays on TransportFilters so saved searches don't break;
          the filter loop now ignores it. */}
      <FilterGroup label={value.pricePerHourMax === 0 ? t("rd.ctrl.perHourPriceAny", { defaultValue: "Per-hour price: any" }) : t("rd.ctrl.perHourPriceUpTo", { defaultValue: "Per-hour price up to ₹{{amount}}", amount: value.pricePerHourMax })}>
        <input type="range" min={0} max={2000} step={50} value={value.pricePerHourMax} onChange={(e) => setValue({ ...value, pricePerHourMax: Number(e.target.value) })} className="w-full accent-accent" />
      </FilterGroup>
      <FilterGroup label={value.pricePerDayMax === 0 ? t("rd.ctrl.perDayPriceAny", { defaultValue: "Per-day price: any" }) : t("rd.ctrl.perDayPriceUpTo", { defaultValue: "Per-day price up to ₹{{amount}}", amount: value.pricePerDayMax.toLocaleString() })}>
        <input type="range" min={0} max={15000} step={500} value={value.pricePerDayMax} onChange={(e) => setValue({ ...value, pricePerDayMax: Number(e.target.value) })} className="w-full accent-accent" />
      </FilterGroup>
      <FilterGroup label={t("rd.ctrl.minimumSeats", { defaultValue: "Minimum seats: {{count}}", count: value.minSeats })}>
        <input type="range" min={1} max={12} step={1} value={value.minSeats} onChange={(e) => setValue({ ...value, minSeats: Number(e.target.value) })} className="w-full accent-accent" />
      </FilterGroup>
      <FilterGroup label={t("rd.ctrl.languagesSpoken", { defaultValue: "Languages spoken" })}>
        <MultiChipRow
          options={TRANSPORT_LANGUAGE_OPTIONS}
          values={value.languages}
          onChange={(languages) => setValue({ ...value, languages })}
        />
      </FilterGroup>
      <FilterGroup label={t("rd.ctrl.minimumRating", { defaultValue: "Minimum rating" })}>
        <RatingRow value={value.ratingMin} onChange={(r) => setValue({ ...value, ratingMin: r })} />
      </FilterGroup>
      {/* "Verified drivers only" toggle removed per product feedback — too
          few drivers are verified yet to justify the toggle. The
          `verifiedOnly` field stays on TransportFilters for backwards
          compat; the filter loop sees it permanently false from this UI. */}
    </div>
  );
}

function MultiChipRow({
  options,
  values,
  onChange,
  labels,
}: {
  options: string[];
  values: string[];
  onChange: (next: string[]) => void;
  labels?: Record<string, string>;
}) {
  const toggle = (o: string) => {
    onChange(values.includes(o) ? values.filter((v) => v !== o) : [...values, o]);
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = values.includes(o);
        return (
          <button
            key={o}
            type="button"
            onClick={() => toggle(o)}
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-bold transition-all ${
              active ? "bg-foreground text-white" : "border border-border bg-muted/50 text-foreground hover:bg-muted active:bg-muted/70"
            }`}
          >
            {labels?.[o] ?? o}
          </button>
        );
      })}
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function ChipRow({ options, value, onChange, labels }: { options: string[]; value: string; onChange: (v: string) => void; labels?: Record<string, string> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-bold transition-all ${
            value === o ? "bg-foreground text-white" : "border border-border bg-muted/50 text-foreground hover:bg-muted active:bg-muted/70"
          }`}
        >
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

function RatingRow({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const { t } = useLanguage();
  return (
    <div className="flex flex-wrap gap-1.5">
      {[0, 3.5, 4, 4.5].map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-bold transition-all ${
            value === r ? "bg-foreground text-white" : "border border-border bg-muted/50 text-foreground hover:bg-muted active:bg-muted/70"
          }`}
        >
          {r === 0 ? t("rd.ctrl.ratingAny", { defaultValue: "Any" }) : (<><Star className="h-3 w-3" /> {r}+</>)}
        </button>
      ))}
    </div>
  );
}

function ToggleRow({ checked, onChange, children }: { checked: boolean; onChange: (b: boolean) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-all ${checked ? "border-foreground bg-foreground text-white" : "border-border bg-muted/50 text-foreground hover:bg-muted active:bg-muted/70"}`}
    >
      <span className="font-semibold">{children}</span>
      <span className={`inline-grid h-5 w-9 place-items-center rounded-full transition-colors ${checked ? "bg-white/30" : "bg-muted"}`}>
        <span className={`h-3.5 w-3.5 rounded-full transition-transform ${checked ? "translate-x-1.5 bg-white" : "-translate-x-1.5 bg-foreground"}`} />
      </span>
    </button>
  );
}

// ───────────────────────────────────────────────── ServiceSlotPicker ──

export function ServiceSlotPicker({
  slots, selected, onSelect,
  activeDate, onActiveDateChange, isSlotBlockedOnDate,
}: {
  slots: string[];
  selected: string;
  onSelect: (slot: string) => void;
  /** ISO date the user has picked (null = "All slots" view). Lifted up so
   *  the parent can resolve the booked slot against the same date. */
  activeDate?: string | null;
  onActiveDateChange?: (iso: string | null) => void;
  /** Per-(slot, date) check so weekday-anchored labels are filtered against
   *  the specific date in `activeDay`, not "the next matching weekday".
   *  Without this, blocking one Monday made every Monday look empty. */
  isSlotBlockedOnDate?: (slotText: string, iso: string) => boolean;
}) {
  const { t } = useLanguage();
  // Build the next 7 days as quick-pick pills. Slots not anchored to a specific
  // day still surface under "All slots" so existing mock data stays usable.
  // Controlled when the parent supplied activeDate; uncontrolled otherwise so
  // existing call sites that don't pass the lift-up props keep working.
  const [internalActiveDay, setInternalActiveDay] = useState<string>("all"); // "all" | iso
  const activeDay = activeDate === undefined ? internalActiveDay : (activeDate ?? "all");
  const setActiveDay = (next: string) => {
    if (activeDate === undefined) setInternalActiveDay(next);
    onActiveDateChange?.(next === "all" ? null : next);
  };
  const [customOpen, setCustomOpen] = useState(false);

  // Derive the set of weekdays the host actually offers from the slot list
  // (slot labels look like "Mon 9:00 AM" / "Tomorrow 11:00 AM"). Used to
  // hide the chip strip dates for off-days (Sat/Sun in the screenshot bug)
  // AND to grey those weekdays out in the calendar picker so a user can't
  // pick a date that has zero slots.
  const enabledWeekdays = useMemo(() => deriveEnabledWeekdays(slots), [slots]);
  const allWeekdaysEnabled = enabledWeekdays.size === 0 || enabledWeekdays.size === 7;

  // Today (IST) — recomputed on every render but its iso is cheap.
  const todayIso = istTodayIso();

  // Week anchor (Monday iso) that drives the strip. Prev/next arrows shift
  // it ±7d; the calendar popover snaps it to the picked date's week. We
  // initialise lazily so the user lands on TODAY's week, not whatever
  // week the strip would otherwise default to during the default-day
  // scan below.
  const [weekAnchor, setWeekAnchor] = useState<string>(() => mondayOfIso(todayIso));

  // Stable 7-cell layout: Mon → Sun of the anchor week. Cells for past
  // dates, host-closed weekdays, or days with zero availability get
  // greyed out in the render — never hidden — so the column alignment
  // stays consistent week to week.
  const weekDays = useMemo(() => {
    const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
    return Array.from({ length: 7 }, (_, i) => {
      const iso = addDaysIso(weekAnchor, i);
      const d = localDateFromIso(iso);
      return {
        iso,
        dow: d.getDay(),
        letter: WEEKDAY_LETTERS[d.getDay()],
        date: d.getDate(),
        isPast: iso < todayIso,
        isToday: iso === todayIso,
      };
    });
  }, [weekAnchor, todayIso]);

  // Month header: "MAY 2026" when the week sits inside one month, or
  // "MAY → JUN 2026" when it straddles. Keeps the user oriented as
  // they navigate week-by-week.
  const monthLabel = useMemo(() => {
    const first = localDateFromIso(weekAnchor);
    const last = localDateFromIso(addDaysIso(weekAnchor, 6));
    const sameMonth = first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear();
    if (sameMonth) {
      return first.toLocaleString("en-IN", { month: "long", year: "numeric" }).toUpperCase();
    }
    const m1 = first.toLocaleString("en-IN", { month: "short" });
    const m2 = last.toLocaleString("en-IN", { month: "short", year: "numeric" });
    return `${m1} → ${m2}`.toUpperCase();
  }, [weekAnchor]);

  // Disable Prev when every day of the prior week is before today —
  // navigating into history serves no one and breaks the "no past dates
  // are bookable" contract enforced downstream.
  const canGoPrev = useMemo(() => {
    const prevSun = addDaysIso(weekAnchor, -1);
    return prevSun >= todayIso;
  }, [weekAnchor, todayIso]);
  const goPrev = () => { if (canGoPrev) setWeekAnchor(addDaysIso(weekAnchor, -7)); };
  const goNext = () => setWeekAnchor(addDaysIso(weekAnchor, 7));

  // Broader rolling-7-day list for the "See every day's slots" view.
  // Independent of the week strip so the all-days list always shows the
  // next batch of days starting today, regardless of where the user has
  // navigated the strip.
  const allDays = useMemo(() => {
    const today = istToday();
    const rows = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(today); d.setDate(today.getDate() + i);
      return { iso: toIso(d), dow: d.getDay(), label: i === 0 ? t("rd.ctrl.today", { defaultValue: "Today" }) : i === 1 ? t("rd.ctrl.tomorrow", { defaultValue: "Tomorrow" }) : d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric" }) };
    });
    const filtered = allWeekdaysEnabled ? rows : rows.filter((r) => enabledWeekdays.has(r.dow));
    return filtered.slice(0, 7);
  }, [allWeekdaysEnabled, enabledWeekdays, t]);

  // Resolve a list of slot labels against a specific ISO date. Same
  // weekday-anchor logic the original `slotsForDay` ran, factored out so
  // (a) single-day view can compute per-day shape + count badges, and
  // (b) the all-days view can render one row per upcoming day.
  //
  // `includeBlocked=true` returns every slot whose weekday matches with a
  // `blocked` flag, so the single-day grid can grey out booked slots
  // instead of hiding them — gives the user a sense of the day's shape.
  const slotsForIso = useCallback(
    (list: string[], iso: string, includeBlocked = false): Array<{ slot: string; blocked: boolean }> => {
      // Parse the chip's YYYY-MM-DD as a LOCAL date. `new Date("2026-05-26")`
      // parses as UTC midnight — in any timezone west of UTC the resulting
      // Date represents the PREVIOUS local calendar day, so getDay() returns
      // the wrong weekday. Local construction is the only safe path.
      const [yy, mm, dd] = iso.split("-").map(Number);
      const dateObj = new Date(yy, (mm || 1) - 1, dd || 1);
      const WEEKDAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
      const dow = WEEKDAY_SHORT[dateObj.getDay()] ?? "";
      const isToday = iso === istTodayIso();
      const isTomorrow = iso === toIso(new Date(istToday().getTime() + 86400000));
      const out: Array<{ slot: string; blocked: boolean }> = [];
      for (const s of list) {
        const lower = s.toLowerCase();
        const dayMatches = (isToday && lower.startsWith("today"))
          || (isTomorrow && lower.startsWith("tomorrow"))
          || (dow ? lower.includes(dow) : false);
        if (!dayMatches) continue;
        // Same-day slots whose time has already passed (or falls within the
        // booking lead-time buffer) are unbookable — drop them entirely so
        // they never render, even in the includeBlocked day-shape grid.
        if (isSlotTooSoon(s, iso)) continue;
        const blocked = isSlotBlockedOnDate ? isSlotBlockedOnDate(s, iso) : false;
        if (blocked && !includeBlocked) continue;
        out.push({ slot: s, blocked });
      }
      return out;
    },
    [isSlotBlockedOnDate],
  );

  // Single-day view: surface EVERY slot whose weekday matches, with a
  // blocked flag so the grid can render greyed-out unavailable chips. The
  // user sees the day's full shape ("ah, mornings are taken — only
  // afternoon/evening left") instead of mystery gaps.
  const dayShape = useMemo(() => {
    if (activeDay === "all") return [] as Array<{ slot: string; blocked: boolean }>;
    return slotsForIso(slots, activeDay, true);
  }, [activeDay, slots, slotsForIso]);
  const slotsForDay = useMemo(() => dayShape.filter((x) => !x.blocked).map((x) => x.slot), [dayShape]);

  // Per-cell availability for the VISIBLE week. Drives the "disabled
  // cell" treatment (no slots = greyed, like host-closed weekdays) so the
  // user never lands on an empty body by clicking a day that has no
  // bookable times for them.
  const weekDayCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const d of weekDays) out[d.iso] = slotsForIso(slots, d.iso, false).length;
    return out;
  }, [weekDays, slots, slotsForIso]);

  // Scan forward from today across up to 8 weeks for the first day with
  // any availability. Used by (a) the default selection on mount and
  // (b) the "Back to single day" toggle so both land on a day the user
  // can actually book, not an arbitrary empty one.
  const findFirstAvailableIso = useCallback((): string | null => {
    for (let offset = 0; offset < 56; offset++) {
      const iso = addDaysIso(todayIso, offset);
      if (slotsForIso(slots, iso, false).length > 0) return iso;
    }
    return null;
  }, [slots, slotsForIso, todayIso]);

  // Default-select the first available day + anchor the strip on its week.
  // One-shot so subsequent renders don't fight the user's manual picks.
  const didDefaultRef = useRef(false);
  useEffect(() => {
    if (didDefaultRef.current) return;
    if (activeDay !== "all") { didDefaultRef.current = true; return; }
    const firstAvailable = findFirstAvailableIso();
    if (firstAvailable) {
      didDefaultRef.current = true;
      setWeekAnchor(mondayOfIso(firstAvailable));
      setActiveDay(firstAvailable);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findFirstAvailableIso]);

  // If the user filters to a day that doesn't include the currently-selected
  // slot, clear the selection. Otherwise the parent keeps the stale slot, the
  // CTA stays enabled, and the user can "Review booking" on a day visibly
  // showing "No slots on this day" — the bug from the screenshot report.
  useEffect(() => {
    if (selected && !slotsForDay.includes(selected)) onSelect("");
  }, [slotsForDay, selected, onSelect]);

  return (
    <div className="grid gap-3">
      {/* Header: prev/next week + month label + jump-to-any-date calendar. */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={goPrev}
            disabled={!canGoPrev}
            aria-label={t("rd.ctrl.previousWeek", { defaultValue: "Previous week" })}
            className="inline-grid h-7 w-7 place-items-center rounded-full border border-foreground/40 bg-[#8b5e4a]/10 text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-foreground/40 disabled:hover:bg-[#8b5e4a]/10 disabled:hover:text-foreground disabled:hover:shadow-sm disabled:active:scale-100"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <p className="px-1 text-[11px] font-extrabold uppercase tracking-wider text-foreground">{monthLabel}</p>
          <button
            type="button"
            onClick={goNext}
            aria-label={t("rd.ctrl.nextWeek", { defaultValue: "Next week" })}
            className="inline-grid h-7 w-7 place-items-center rounded-full border border-foreground/40 bg-[#8b5e4a]/10 text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-90"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setCustomOpen((v) => !v)}
          aria-label={t("rd.ctrl.pickCustomDate", { defaultValue: "Pick a custom date" })}
          className="inline-grid h-7 w-7 place-items-center rounded-full border border-foreground/40 bg-[#8b5e4a]/10 text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-90"
        >
          <CalendarDays className="h-4 w-4" />
        </button>
      </div>
      {customOpen && (
        <InlineDatePopover
          value={activeDay === "all" ? null : activeDay}
          onChange={(iso) => {
            // Snap the strip to the picked date's week so the cell the
            // user just selected is visible in the new view.
            setWeekAnchor(mondayOfIso(iso));
            setActiveDay(iso);
            setCustomOpen(false);
          }}
          onClose={() => setCustomOpen(false)}
          disabledWeekdays={allWeekdaysEnabled ? undefined : enabledWeekdays}
        />
      )}

      {/* Week strip — 7 stable cells, stacked weekday letter + date. */}
      <div className="grid grid-cols-7 gap-1">
        {weekDays.map((d) => {
          const isEnabledWeekday = allWeekdaysEnabled || enabledWeekdays.has(d.dow);
          const isPicked = activeDay === d.iso;
          const noSlots = (weekDayCounts[d.iso] ?? 0) === 0;
          // Disabled covers: past, host-closed weekday, no slots that day.
          // All three render the same muted style; the user can see the
          // day exists but can't pick it.
          const disabled = d.isPast || !isEnabledWeekday || noSlots;
          return (
            <button
              key={d.iso}
              type="button"
              onClick={() => { if (!disabled) setActiveDay(d.iso); }}
              disabled={disabled}
              aria-pressed={isPicked}
              className={`flex flex-col items-center justify-center rounded-xl py-2 text-sm transition-all ${
                isPicked
                  ? "bg-foreground text-white shadow-sm"
                  : disabled
                    ? "border border-transparent bg-transparent text-muted-foreground/50 cursor-not-allowed"
                    : "border border-foreground/30 bg-[#8b5e4a]/10 text-foreground shadow-sm hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-95"
              }`}
            >
              <span className="text-[10px] font-bold uppercase tracking-wide opacity-70">{d.letter}</span>
              <span className="font-display text-base font-extrabold leading-tight">{d.date}</span>
              {d.isToday && (
                <span className={`mt-0.5 inline-block h-1 w-1 rounded-full ${isPicked ? "bg-white" : "bg-foreground/70"}`} />
              )}
            </button>
          );
        })}
      </div>

      {/* Body */}
      {activeDay === "all" ? (
        <AllDaysList
          days={allDays}
          slotsForIso={slotsForIso}
          rawSlots={slots}
          selected={selected}
          onSelect={onSelect}
        />
      ) : dayShape.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          {slots.length === 0
            ? t("rd.ctrl.noBookableHours", { defaultValue: "The provider hasn't set bookable hours yet — message them to confirm a time, or check back soon." })
            : t("rd.ctrl.noSlotsThisDay", { defaultValue: "No slots on this day. Try another day, or see all days below." })}
        </p>
      ) : (
        <SingleDayGroups
          dayShape={dayShape}
          selected={selected}
          onSelect={onSelect}
        />
      )}

      {/* Footer: opt-in to all-days view. */}
      <div className="mt-1 flex items-center justify-end">
        <button
          type="button"
          onClick={() => {
            if (activeDay === "all") {
              const firstAvailable = findFirstAvailableIso();
              if (firstAvailable) {
                setWeekAnchor(mondayOfIso(firstAvailable));
                setActiveDay(firstAvailable);
              } else {
                setActiveDay(todayIso);
              }
            } else {
              setActiveDay("all");
            }
          }}
          className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground underline-offset-2 transition-colors hover:bg-muted hover:text-foreground"
        >
          {activeDay === "all" ? t("rd.ctrl.backToSingleDay", { defaultValue: "Back to single day" }) : t("rd.ctrl.seeEveryDaySlots", { defaultValue: "See every day's slots" })}
        </button>
      </div>
    </div>
  );
}

/** "9:00 AM" out of "Mon 9:00 AM" / "Today 6:30 PM". Keeps the time as-is
 *  when no day prefix is recognised so weirdly-authored labels still render
 *  rather than being silently emptied. */
function stripDayPrefix(slot: string): string {
  return slot.replace(/^(today|tomorrow|sun|mon|tue|wed|thu|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+/i, "").trim();
}

/** Bucket a "9:00 AM" / "1:30 PM" / "Mon 6:00 PM" label by start hour.
 *  Returns 'morning' as a safe default for labels we can't parse so
 *  nothing disappears from the grid. */
type SlotBucket = "morning" | "afternoon" | "evening";
function timeBucket(slot: string): SlotBucket {
  const time = stripDayPrefix(slot);
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(time);
  if (!m) return "morning";
  let hour = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "PM") hour += 12;
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

/** Slot chip used by both single-day and all-days views. No calendar
 *  icon, no day prefix — just the time. Bigger touch target than the
 *  legacy pill so the day's options are easier to tap on mobile. */
function SlotChip({
  label, selected, blocked, onClick,
}: {
  label: string;
  selected: boolean;
  blocked?: boolean;
  onClick: () => void;
}) {
  if (blocked) {
    return (
      <span
        aria-disabled="true"
        className="inline-flex h-10 items-center justify-center rounded-xl border border-dashed border-border bg-muted/40 px-3 text-sm font-semibold text-muted-foreground line-through opacity-70"
      >
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-10 items-center justify-center rounded-xl px-3 text-sm font-bold shadow-sm transition-all ${
        selected
          ? "bg-foreground text-white"
          : "border border-foreground/40 bg-[#8b5e4a]/10 text-foreground hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-95"
      }`}
    >
      {label}
    </button>
  );
}

/** Single-day body — slots grouped under Morning / Afternoon / Evening.
 *  Removes the day prefix from each chip (the day is already implied)
 *  and renders blocked slots greyed so the user can see the day's full
 *  shape. 2 cols mobile, 3 sm, 4 md. */
function SingleDayGroups({
  dayShape, selected, onSelect,
}: {
  dayShape: Array<{ slot: string; blocked: boolean }>;
  selected: string;
  onSelect: (slot: string) => void;
}) {
  const { t } = useLanguage();
  const bucketLabels: Record<SlotBucket, string> = {
    morning: t("rd.ctrl.bucketMorning", { defaultValue: "Morning" }),
    afternoon: t("rd.ctrl.bucketAfternoon", { defaultValue: "Afternoon" }),
    evening: t("rd.ctrl.bucketEvening", { defaultValue: "Evening" }),
  };
  const buckets: SlotBucket[] = ["morning", "afternoon", "evening"];
  return (
    <div className="grid gap-3">
      {buckets.map((bucket) => {
        const items = dayShape.filter((x) => timeBucket(x.slot) === bucket);
        if (items.length === 0) return null;
        return (
          <div key={bucket} className="grid gap-1.5">
            <p className="text-[10px] font-extrabold uppercase tracking-wider text-muted-foreground">
              {bucketLabels[bucket]}
            </p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
              {items.map(({ slot, blocked }) => (
                <SlotChip
                  key={slot}
                  label={stripDayPrefix(slot)}
                  selected={selected === slot}
                  blocked={blocked}
                  onClick={() => onSelect(slot)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** All-days body — one row per upcoming day with the day label as a row
 *  header and that day's available slots wrapped to the right. Replaces
 *  the legacy flat grid where every chip redundantly prefixed the day. */
function AllDaysList({
  days, slotsForIso, rawSlots, selected, onSelect,
}: {
  days: Array<{ iso: string; label: string; dow: number }>;
  slotsForIso: (list: string[], iso: string, includeBlocked?: boolean) => Array<{ slot: string; blocked: boolean }>;
  rawSlots: string[];
  selected: string;
  onSelect: (slot: string) => void;
}) {
  const { t } = useLanguage();
  const rows = days
    .map((d) => ({ d, items: slotsForIso(rawSlots, d.iso, false).map((x) => x.slot) }))
    .filter((r) => r.items.length > 0);
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        {t("rd.ctrl.noUpcomingSlots", { defaultValue: "No upcoming slots are available right now." })}
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      {rows.map(({ d, items }) => (
        <div key={d.iso} className="grid grid-cols-[76px_1fr] items-start gap-3">
          <p className="pt-2.5 text-xs font-extrabold uppercase tracking-wide text-foreground">
            {d.label}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {items.map((slot) => (
              <SlotChip
                key={`${d.iso}-${slot}`}
                label={stripDayPrefix(slot)}
                selected={selected === slot}
                onClick={() => onSelect(slot)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Parse slot labels like "Mon 9:00 AM" / "Today 6:30 PM" into a set of
 *  weekday numbers (0=Sun..6=Sat) the host actually offers. Used to filter
 *  the day-pill strip and grey out off-days in the inline calendar so the
 *  picker can't land on a date with zero slots. Returns an empty set when
 *  none of the labels look weekday-prefixed (legacy free-text slots), in
 *  which case callers should treat "all weekdays" as enabled. */
function deriveEnabledWeekdays(slots: string[]): Set<number> {
  const map: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  };
  const out = new Set<number>();
  const today = istNow();
  for (const slot of slots) {
    const head = (slot || "").trim().toLowerCase().slice(0, 3);
    if (head === "tod") out.add(today.getDay());
    else if (head === "tom") out.add((today.getDay() + 1) % 7);
    else if (head in map) out.add(map[head]);
  }
  return out;
}

/** Themed inline date popover used by ServiceSlotPicker's "Pick date" button.
 *  Matches the warm-neutral palette + glass-tile aesthetic of the rest of the
 *  redesign (the native <input type="date"> styling we replaced was a stark
 *  OS-default white box, and didn't respect day-of-week availability). */
function InlineDatePopover({
  value, onChange, onClose, disabledWeekdays,
}: {
  value: string | null;
  onChange: (iso: string) => void;
  onClose: () => void;
  /** Optional set of weekdays the host offers (0=Sun..6=Sat). When omitted,
   *  every weekday is selectable. */
  disabledWeekdays?: Set<number>;
}) {
  const { t } = useLanguage();
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [onClose]);

  const today = useMemo(() => istToday(), []);
  const todayISO = toIso(today);
  const [view, setView] = useState<Date>(() => {
    const seed = value ? new Date(`${value}T00:00:00`) : today;
    return new Date(seed.getFullYear(), seed.getMonth(), 1);
  });
  const monthLabel = view.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const grid = useMemo(() => {
    const firstOfMonth = new Date(view.getFullYear(), view.getMonth(), 1);
    const leading = firstOfMonth.getDay();
    const startDate = new Date(firstOfMonth);
    startDate.setDate(firstOfMonth.getDate() - leading);
    const cells: Array<{ iso: string; date: Date; inMonth: boolean; isPast: boolean; isSelected: boolean; isToday: boolean; isWeekdayOff: boolean }> = [];
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const iso = toIso(d);
      cells.push({
        iso,
        date: d,
        inMonth: d.getMonth() === view.getMonth(),
        isPast: iso < todayISO,
        isSelected: !!value && iso === value,
        isToday: iso === todayISO,
        isWeekdayOff: disabledWeekdays ? !disabledWeekdays.has(d.getDay()) : false,
      });
    }
    return cells;
  }, [view, value, todayISO, disabledWeekdays]);

  return (
    <div
      ref={rootRef}
      className="w-[300px] rounded-2xl border border-border bg-white p-3 shadow-[0_22px_60px_rgba(34,31,39,0.18)]"
    >
      <header className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setView((v) => new Date(v.getFullYear(), v.getMonth() - 1, 1))}
          className="inline-grid h-7 w-7 place-items-center rounded-full border border-border bg-card text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-90"
          aria-label={t("rd.ctrl.previousMonth", { defaultValue: "Previous month" })}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="text-sm font-extrabold text-foreground">{monthLabel}</span>
        <button
          type="button"
          onClick={() => setView((v) => new Date(v.getFullYear(), v.getMonth() + 1, 1))}
          className="inline-grid h-7 w-7 place-items-center rounded-full border border-border bg-card text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white hover:shadow active:scale-90"
          aria-label={t("rd.ctrl.nextMonth", { defaultValue: "Next month" })}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <span key={`${d}-${i}`} className="py-1">{d}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {grid.map((c) => {
          const disabled = c.isPast || c.isWeekdayOff;
          return (
            <button
              key={c.iso}
              type="button"
              onClick={() => { if (!disabled) onChange(c.iso); }}
              disabled={disabled}
              title={c.isWeekdayOff ? t("rd.ctrl.providerClosedWeekday", { defaultValue: "Provider is closed on this weekday" }) : undefined}
              className={`h-9 rounded-lg text-xs font-semibold transition-colors ${
                c.isSelected
                  ? "bg-foreground text-white shadow-sm"
                  : c.isWeekdayOff
                    ? "bg-muted/40 text-muted-foreground/40 cursor-not-allowed"
                    : c.isPast
                      ? "text-muted-foreground/40 cursor-not-allowed"
                      : !c.inMonth
                        ? "text-muted-foreground/60 hover:bg-muted/60"
                        : c.isToday
                          ? "border border-foreground/40 text-foreground hover:bg-muted"
                          : "text-foreground hover:bg-muted"
              }`}
            >
              {c.date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DayPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-bold transition-all ${
        active ? "text-white shadow-[0_8px_18px_rgba(58,50,71,0.16)] bg-[linear-gradient(135deg,#2b2436_0%,#7b5244_60%,#8b5e4a_100%)]" : "border border-border bg-muted/50 text-foreground hover:bg-muted active:bg-muted/70"
      }`}
    >
      {children}
    </button>
  );
}
