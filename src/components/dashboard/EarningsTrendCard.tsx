// Shared Overview earnings chart for the three partner dashboards (host /
// provider / transport).
//
// Client-derived on purpose: the series is computed from the SAME type-scoped
// bookings array + amountFor() that the dashboard's "Total Earnings" tile
// uses, so the tile and the chart can never disagree — the "All" range total
// IS the tile number by construction. (The previous version fetched
// /api/providers/me/earnings without a vertical filter, which mixed every
// listing type under the provider profile — a cab+salon owner's services
// dashboard trend included cab money its own tile didn't count.)
//
// Chart shape follows the stock-app convention: one line, date on the x-axis,
// ₹ earned per day (per month on long ranges) on the y-axis, with a range
// toggle that rescales both axes.
import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useLanguage } from "@/contexts/LanguageContext";
import type { Booking } from "@/types/domain";

type RangeId = "30d" | "90d" | "365d" | "all";
const RANGE_DAYS: Record<Exclude<RangeId, "all">, number> = { "30d": 30, "90d": 90, "365d": 365 };

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMs = 86400000;
const atMidnight = (d: Date) => { const c = new Date(d); c.setHours(0, 0, 0, 0); return c; };
const inr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;
// Compact ₹ for axis ticks — Indian units (K / L) so long ranges stay legible.
const inrCompact = (v: number) =>
  v >= 100000 ? `₹${(v / 100000).toFixed(1).replace(/\.0$/, "")}L`
  : v >= 1000 ? `₹${(v / 1000).toFixed(1).replace(/\.0$/, "")}K`
  : `₹${Math.round(v)}`;

interface TrendPoint {
  label: string; // sparse axis tick ("5 Jul" daily, "Jul 25" monthly)
  full: string;  // tooltip heading ("5 Jul 2026" / "July 2026")
  earnings: number;
}

export function EarningsTrendCard({
  completed,
  amountFor,
  accrualDate,
  className,
}: {
  /** Completed bookings, ALREADY scoped to this dashboard's vertical — the same array the Total Earnings tile sums. */
  completed: Booking[];
  /** Same amount rule as the tile (paid total, else agreed price, …). */
  amountFor: (b: Booking) => number;
  /** When the earnings accrued — checkout day for stays, scheduled day for services/transport. */
  accrualDate: (b: Booking) => Date;
  /** Outer card classes — host passes its glassy tile styling. */
  className?: string;
}) {
  const { t } = useLanguage();
  const [range, setRange] = useState<RangeId>("30d");

  const ranges: Array<{ id: RangeId; label: string }> = [
    { id: "30d", label: t("dash.earnTrend.range.30d", { defaultValue: "30 days" }) },
    { id: "90d", label: t("dash.earnTrend.range.90d", { defaultValue: "90 days" }) },
    { id: "365d", label: t("dash.earnTrend.range.365d", { defaultValue: "1 year" }) },
    { id: "all", label: t("dash.earnTrend.range.all", { defaultValue: "All" }) },
  ];

  const { points, total, count, windowLabel } = useMemo(() => {
    const today = atMidnight(new Date());
    const dated = completed
      .map((b) => ({ d: atMidnight(accrualDate(b)), amt: amountFor(b) }))
      .filter((x) => !Number.isNaN(x.d.getTime()));

    // Window: rolling N days ending today, or first-accrual → today for All.
    const end = today;
    const start = range === "all"
      ? dated.reduce((min, x) => (x.d < min ? x.d : min), today)
      : new Date(today.getTime() - (RANGE_DAYS[range] - 1) * dayMs);
    const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / dayMs) + 1);
    // Daily points up to ~4 months, calendar-month buckets beyond — mirrors
    // the backend series so web and mobile draw the same shape.
    const monthly = spanDays > 120;

    const keyOf = (d: Date) => monthly
      ? `${d.getFullYear()}-${d.getMonth()}`
      : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const sums = new Map<string, number>();
    let total = 0, count = 0;
    for (const x of dated) {
      if (x.d < start || x.d > end) continue;
      sums.set(keyOf(x.d), (sums.get(keyOf(x.d)) || 0) + x.amt);
      total += x.amt; count += 1;
    }

    // Zero-filled, continuous axis.
    const points: TrendPoint[] = [];
    if (monthly) {
      const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
      while (cursor <= end) {
        points.push({
          label: `${MON[cursor.getMonth()]} ${String(cursor.getFullYear()).slice(2)}`,
          full: cursor.toLocaleDateString("en-IN", { month: "long", year: "numeric" }),
          earnings: sums.get(keyOf(cursor)) || 0,
        });
        cursor.setMonth(cursor.getMonth() + 1);
      }
    } else {
      for (let ts = start.getTime(); ts <= end.getTime(); ts += dayMs) {
        const d = atMidnight(new Date(ts)); // re-anchor in case of DST elsewhere
        points.push({
          label: `${d.getDate()} ${MON[d.getMonth()]}`,
          full: d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
          earnings: sums.get(keyOf(d)) || 0,
        });
      }
    }

    const windowLabel = `${start.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} – ${end.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;
    return { points, total, count, windowLabel };
  }, [completed, range, amountFor, accrualDate]);

  return (
    <div className={className ?? "bg-card rounded-2xl border border-border p-5 sm:p-6"}>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h3 className="font-display font-semibold">{t("dash.earnTrend.title", { defaultValue: "Earnings trend" })}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {windowLabel} · <span className="font-medium text-foreground">{inr(total)}</span> {t("dash.earnTrend.earned", { defaultValue: "earned" })} · {t("dash.earnTrend.completedCount", { defaultValue: "{{count}} completed", count })}
          </p>
        </div>
        <div className="flex gap-2">
          {ranges.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                range === r.id ? "bg-primary text-primary-foreground shadow-sm" : "bg-card border border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {count === 0 ? (
        <p className="text-sm text-muted-foreground py-12 text-center">{t("dash.earnTrend.noData", { defaultValue: "No earnings in this range yet." })}</p>
      ) : (
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 5, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="earningsTrendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={28} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={inrCompact} width={56} tickLine={false} axisLine={false} />
              <Tooltip
                formatter={(value: number | string) => [inr(Number(value)), t("dash.earnTrend.earnings", { defaultValue: "Earnings" })]}
                labelFormatter={(_label, payload) => (payload?.[0]?.payload as TrendPoint | undefined)?.full ?? String(_label)}
              />
              <Area
                type="monotone"
                dataKey="earnings"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#earningsTrendFill)"
                activeDot={{ r: 3.5 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
