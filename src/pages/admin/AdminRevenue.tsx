import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { X } from "lucide-react";
import {
  adminMetrics,
  rangeQuery,
  type RevenueDim,
  type RevenueSegment,
} from "@/domains/analytics/admin-metrics.service";
import { useAdminRange } from "./AdminLayout";
import { Kpi, KpiDelta, Panel, PageHeading, StateNote, labelizeCategory, labelizeType, rupees, fmt } from "./adminUi";

const dayTick = (d: string) => d.slice(5);

// Chart palette shared with the other admin tabs.
const ALL_COLOR = "hsl(160, 60%, 45%)";      // emerald — total revenue
const SEGMENT_COLOR = "hsl(239, 84%, 67%)";  // indigo — selected segment

const DIM_TABS: Array<{ dim: RevenueDim; label: string }> = [
  { dim: "type", label: "Type" },
  { dim: "category", label: "Category" },
  { dim: "city", label: "City" },
  { dim: "state", label: "State" },
  { dim: "host", label: "Host" },
];

/** Human label for a segment key ("driver-cab" → "Driver Cab", "stay" → "Stays"). */
const segLabel = (dim: RevenueDim, key: string) => (dim === "type" ? labelizeType(key) : labelizeCategory(key));

export default function AdminRevenue() {
  const range = useAdminRange();
  const [dim, setDim] = useState<RevenueDim>("type");
  const [segKey, setSegKey] = useState<string | null>(null);
  const segment: RevenueSegment | null = segKey ? { dim, key: segKey } : null;

  const sumQ = useQuery({ queryKey: ["admin-rev-summary", rangeQuery(range)], queryFn: () => adminMetrics.revenueSummary(range) });
  const bdQ = useQuery({
    queryKey: ["admin-rev-breakdown", rangeQuery(range), dim],
    queryFn: () => adminMetrics.revenueBreakdown(range, dim),
  });
  const seriesQ = useQuery({
    queryKey: ["admin-rev-series", rangeQuery(range), segment?.dim ?? "", segment?.key ?? ""],
    queryFn: () => adminMetrics.revenueSeries(range, segment),
  });
  const listQ = useQuery({
    queryKey: ["admin-rev-listings", rangeQuery(range), segment?.dim ?? "", segment?.key ?? ""],
    queryFn: () => adminMetrics.revenueListings(range, segment, 10),
  });

  if (sumQ.isLoading) return <StateNote>Loading…</StateNote>;
  if (sumQ.error || !sumQ.data) return <StateNote>Couldn’t load metrics.</StateNote>;

  const t = sumQ.data.totals;
  const pt = sumQ.data.prevTotals;
  const vsLabel = `vs ${sumQ.data.prevRange.from} → ${sumQ.data.prevRange.to}`;

  const pickDim = (d: RevenueDim) => { setDim(d); setSegKey(null); };
  const toggleSeg = (key: string) => setSegKey((cur) => (cur === key ? null : key));

  const breakdown = bdQ.data?.rows ?? [];
  const maxGross = Math.max(...breakdown.map((r) => r.grossPaise), 1);
  // Both windows are densified server-side to the same length, so the previous
  // period aligns with the current one by index. The prev overlay is hidden
  // while a segment is selected (three lines gets unreadable).
  const prevSeries = seriesQ.data?.prevSeries ?? [];
  const series = (seriesQ.data?.series ?? []).map((r, i) => ({
    day: r.day,
    all: r.grossPaise / 100,
    segment: r.segmentPaise == null ? undefined : r.segmentPaise / 100,
    prev: segment ? undefined : (prevSeries[i]?.grossPaise ?? 0) / 100,
    aov: r.bookings > 0 ? Math.round(r.grossPaise / r.bookings) / 100 : null,
  }));
  const listings = listQ.data?.listings ?? [];
  const selectedLabel = segment ? segLabel(segment.dim, segment.key) : null;

  // Exact rupees (no ₹L/₹Cr compaction) — the breakdown is a reconciliation
  // ledger, so the rows must visibly add up.
  const inr = (paise: number) => `${paise < 0 ? "−" : ""}₹${fmt(Math.abs(Math.round(paise / 100)))}`;
  const ledger = [
    { label: "Booking value (before discounts)", paise: t.grossPaise + t.discountPaise },
    { label: "Discounts", paise: -t.discountPaise },
    { label: "Gross charged (GMV)", paise: t.grossPaise, strong: true },
    { label: "Refunds", paise: -t.refundPaise },
    { label: "Net revenue", paise: t.netPaise, strong: true },
  ];
  const composition = [
    { label: "Partner subtotal", paise: t.subtotalPaise },
    { label: "Platform fees", paise: t.platformFeePaise },
    { label: "GST", paise: t.taxesPaise },
    { label: "Trip protection", paise: t.insurancePaise },
  ];

  return (
    <>
      <PageHeading title="Revenue" subtitle={`Paid GMV & earnings · ${sumQ.data.range.from} → ${sumQ.data.range.to} · deltas ${vsLabel}`} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Gross (GMV)" value={rupees(t.grossPaise)} sub={`${fmt(t.bookings)} paid bookings`}
          delta={<KpiDelta current={t.grossPaise} previous={pt.grossPaise} title={vsLabel} />} />
        <Kpi label="Avg order value" value={rupees(t.aovPaise)}
          delta={<KpiDelta current={t.aovPaise} previous={pt.aovPaise} title={vsLabel} />} />
        <Kpi label="Refunds" value={rupees(t.refundPaise)} sub={`${fmt(t.refundedBookings)} bookings refunded`}
          delta={<KpiDelta current={t.refundPaise} previous={pt.refundPaise} invert title={vsLabel} />} />
        <Kpi label="Net revenue" value={rupees(t.netPaise)} sub={`after refunds`}
          delta={<KpiDelta current={t.netPaise} previous={pt.netPaise} title={vsLabel} />} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Panel
          title="Revenue trend"
          subtitle={selectedLabel ? `Daily paid GMV — ${selectedLabel} vs all (₹)` : "Daily paid GMV (₹) — dashed line is the previous period"}
        >
          {selectedLabel && (
            <button
              onClick={() => setSegKey(null)}
              className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary"
            >
              {selectedLabel}
              <X className="h-3 w-3" />
            </button>
          )}
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={series} margin={{ top: 5, right: 12, left: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id="revAllFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ALL_COLOR} stopOpacity={segment ? 0.12 : 0.35} />
                    <stop offset="100%" stopColor={ALL_COLOR} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="revSegFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={SEGMENT_COLOR} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={SEGMENT_COLOR} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="day" tickFormatter={dayTick} tick={{ fontSize: 11 }} minTickGap={24} />
                <YAxis tick={{ fontSize: 11 }} width={52} />
                <Tooltip formatter={(v: number) => `₹${fmt(Math.round(v))}`} />
                {!segment && (
                  <Line
                    type="monotone" dataKey="prev" name="Previous period"
                    stroke="hsl(var(--muted-foreground))" strokeWidth={1.5} strokeDasharray="4 4" dot={false}
                  />
                )}
                <Area
                  type="monotone" dataKey="all" name="All revenue"
                  stroke={ALL_COLOR} strokeWidth={segment ? 1.5 : 2}
                  strokeOpacity={segment ? 0.5 : 1} fill="url(#revAllFill)"
                />
                {segment && (
                  <Area
                    type="monotone" dataKey="segment" name={selectedLabel ?? "Segment"}
                    stroke={SEGMENT_COLOR} strokeWidth={2} fill="url(#revSegFill)"
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Where revenue comes from" subtitle="Paid GMV by segment — click a row to drill in">
          <div className="mb-3 inline-flex rounded-xl border border-border bg-background p-0.5">
            {DIM_TABS.map((tab) => (
              <button
                key={tab.dim}
                onClick={() => pickDim(tab.dim)}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                  dim === tab.dim ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {bdQ.isLoading ? (
            <StateNote>Loading…</StateNote>
          ) : breakdown.length === 0 ? (
            <StateNote>No paid revenue in this range yet.</StateNote>
          ) : (
            <div className="space-y-1">
              {breakdown.map((row) => {
                const active = segKey === row.key;
                return (
                  <button
                    key={row.key}
                    onClick={() => toggleSeg(row.key)}
                    className={`block w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
                      active ? "bg-primary/10" : "hover:bg-muted/60"
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className={`truncate font-medium ${active ? "text-primary" : ""}`}>{segLabel(dim, row.key)}</span>
                      <span className="shrink-0 tabular-nums font-semibold">{rupees(row.grossPaise)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.max((row.grossPaise / maxGross) * 100, 2)}%`,
                            backgroundColor: active ? SEGMENT_COLOR : ALL_COLOR,
                          }}
                        />
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {fmt(row.bookings)} bookings{row.refundPaise > 0 ? ` · ${rupees(row.refundPaise)} refunded` : ""}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Revenue breakdown" subtitle="How gross becomes net, and what the charge is made of">
          <table className="w-full text-sm">
            <tbody>
              {ledger.map((row) => (
                <tr key={row.label} className="border-t border-border/60 first:border-t-0">
                  <td className={`py-2 ${row.strong ? "font-semibold" : ""}`}>{row.label}</td>
                  <td className={`py-2 text-right tabular-nums ${row.strong ? "font-semibold" : ""}`}>{inr(row.paise)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2} className="pt-4 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Composition of the charged amount
                </td>
              </tr>
              {composition.map((row) => (
                <tr key={row.label} className="border-t border-border/60">
                  <td className="py-2 text-muted-foreground">{row.label}</td>
                  <td className="py-2 text-right tabular-nums">{inr(row.paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            Composition comes from per-payment snapshots; payments made before snapshots existed count as ₹0 there, so it can total less than gross.
          </p>
        </Panel>

        <Panel title="Avg order value over time" subtitle="Daily AOV (₹) — gaps are days without paid bookings">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 5, right: 12, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="day" tickFormatter={dayTick} tick={{ fontSize: 11 }} minTickGap={24} />
                <YAxis tick={{ fontSize: 11 }} width={52} />
                <Tooltip formatter={(v: number) => `₹${fmt(Math.round(v))}`} />
                <Line
                  type="monotone" dataKey="aov" name="Avg order value"
                  stroke={SEGMENT_COLOR} strokeWidth={2} dot={false} connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <div className="mt-4">
        <Panel
          title="Top listings"
          subtitle={selectedLabel ? `By paid GMV — ${selectedLabel}` : "By paid GMV across the marketplace"}
        >
          {listQ.isLoading ? (
            <StateNote>Loading…</StateNote>
          ) : listings.length === 0 ? (
            <StateNote>No paid bookings {selectedLabel ? `for ${selectedLabel} ` : ""}in this range.</StateNote>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">Listing</th>
                    <th className="pb-2 pr-4 font-medium">Type · City</th>
                    <th className="pb-2 pr-4 text-right font-medium">Bookings</th>
                    <th className="pb-2 pr-4 text-right font-medium">Gross</th>
                    <th className="pb-2 pr-4 text-right font-medium">Refunds</th>
                    <th className="pb-2 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {listings.map((l) => (
                    <tr key={l.listingId} className="border-t border-border/60">
                      <td className="max-w-[18rem] truncate py-2 pr-4 font-medium">{l.name}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {l.listingType ? labelizeType(l.listingType) : "—"}
                        {l.city ? ` · ${l.city}` : ""}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{fmt(l.bookings)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums font-semibold">{rupees(l.grossPaise)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                        {l.refundPaise > 0 ? rupees(l.refundPaise) : "—"}
                      </td>
                      <td className="py-2 text-right tabular-nums">{rupees(l.grossPaise - l.refundPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
