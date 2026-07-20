// Shared metric/analytics building blocks. Originally lived in
// src/pages/admin/adminUi.tsx; extracted so the partner dashboards (host /
// provider / transport Insights) can render the same KPI-tile + panel look
// without importing from the admin pages. adminUi.tsx re-exports everything
// here, so admin pages keep their existing imports.
import { ReactNode } from "react";
import type { DateRange } from "react-day-picker";
import { Calendar } from "@/components/ui/calendar";

const nf = new Intl.NumberFormat("en-IN");
export const fmt = (n: number | undefined | null) => nf.format(Number(n ?? 0));

// Paise → compact ₹ (₹1.2L / ₹3.4Cr) for KPI tiles.
export function rupees(paise: number | undefined | null): string {
  const r = Number(paise ?? 0) / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(2)}Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(2)}L`;
  if (r >= 1e3) return `₹${(r / 1e3).toFixed(1)}K`;
  return `₹${nf.format(Math.round(r))}`;
}

/** Headline KPI tile. `delta` renders right of the value (see KpiDelta). */
export function Kpi({ label, value, sub, delta }: { label: string; value: ReactNode; sub?: ReactNode; delta?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <p className="font-display text-2xl font-bold tabular-nums">{value}</p>
        {delta}
      </div>
      {sub != null && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

/**
 * Period-over-period pill for a KPI tile: % change of `current` vs the
 * previous equal-length window. Renders "—" when there's no prior baseline.
 * `invert` marks metrics where an increase is bad (refunds, cancellations).
 */
export function KpiDelta({ current, previous, invert, title }: { current: number; previous: number; invert?: boolean; title?: string }) {
  if (!(previous > 0)) {
    return <span className="text-xs text-muted-foreground" title={title}>—</span>;
  }
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.05) {
    return <span className="text-xs font-semibold tabular-nums text-muted-foreground" title={title}>0%</span>;
  }
  const up = pct > 0;
  const good = invert ? !up : up;
  const magnitude = Math.abs(pct) >= 100 ? fmt(Math.round(Math.abs(pct))) : Math.abs(pct).toFixed(1);
  return (
    <span
      className={`shrink-0 text-xs font-semibold tabular-nums ${good ? "text-emerald-600" : "text-red-600"}`}
      title={title}
    >
      {up ? "▲" : "▼"} {magnitude}%
    </span>
  );
}

/** Titled content panel (a chart, table, etc.). */
export function Panel({ title, subtitle, children, className }: { title: string; subtitle?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-border bg-card p-5 ${className ?? ""}`}>
      <div className="mb-4">
        <h2 className="font-display text-base font-semibold">{title}</h2>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

export function PageHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h1 className="font-display text-2xl font-bold">{title}</h1>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}

export function StateNote({ children }: { children: ReactNode }) {
  return <div className="py-12 text-center text-sm text-muted-foreground">{children}</div>;
}

/** Conversion-rate helper (e.g. bookings / views), guards divide-by-zero. */
export const rate = (num: number, den: number) => (den > 0 ? `${((num / den) * 100).toFixed(1)}%` : "—");

export const ymdLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The app's Calendar in range mode with the warm-brown (`accent`/terra)
 * range styling — shared by the admin ops filter bars (AdminDateRange) and
 * the analytics period pickers (admin layout + partner Insights) so all of
 * them look identical.
 *
 * Styling notes: solid brown endpoints + a soft terra connecting bar. The
 * CELL paints the continuous bar; middle day buttons are forced transparent
 * so it shows through (else day_selected's bg would paint the whole range
 * solid). The `!` on text colours keeps numbers visible over the ghost
 * button's `text-muted-foreground` (same fix as the coupon calendar).
 */
export function AdminRangeCalendar({
  selected,
  onSelect,
  disabled,
}: {
  selected: DateRange | undefined;
  onSelect: (range: DateRange | undefined) => void;
  disabled?: React.ComponentProps<typeof Calendar>["disabled"];
}) {
  return (
    <Calendar
      mode="range"
      numberOfMonths={1}
      selected={selected}
      onSelect={onSelect}
      disabled={disabled}
      classNames={{
        cell: "h-9 w-9 text-center text-sm p-0 relative [&:has([aria-selected].day-range-end)]:rounded-r-md [&:has([aria-selected].day-outside)]:bg-accent/10 [&:has([aria-selected])]:bg-accent/15 first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md focus-within:relative focus-within:z-20",
        day_range_start: "day-range-start bg-accent !text-accent-foreground hover:bg-accent hover:!text-accent-foreground rounded-l-md",
        day_range_end: "day-range-end bg-accent !text-accent-foreground hover:bg-accent hover:!text-accent-foreground rounded-r-md",
        day_range_middle: "aria-selected:!bg-transparent aria-selected:!text-foreground rounded-none",
        day_selected: "bg-accent !text-accent-foreground hover:bg-accent hover:!text-accent-foreground focus:bg-accent focus:!text-accent-foreground",
        day_today: "bg-accent/15 !text-foreground font-semibold rounded-md",
      }}
    />
  );
}
