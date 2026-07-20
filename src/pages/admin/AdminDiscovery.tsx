import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { X } from "lucide-react";
import { adminMetrics, type OverviewRow } from "@/domains/analytics/admin-metrics.service";
import { rangeQuery } from "@/domains/analytics/admin-metrics.service";
import { useAdminRange } from "./AdminLayout";
import { Panel, PageHeading, StateNote, fmt, rate, rupees } from "./adminUi";

const TYPE_LABEL: Record<string, string> = { stay: "Stays", service: "Services", transport: "Transport" };

const VIEWS_COLOR = "hsl(239, 84%, 67%)";   // indigo — matches the views bars
const CLICKS_COLOR = "hsl(160, 60%, 45%)";  // emerald — matches the card-click bars

const dayTick = (d: string) => d.slice(5); // MM-DD

// Per-category daily views live on the overview series under these keys.
const VIEWS_KEY: Record<string, keyof OverviewRow> = {
  stay: "listing_views_stay",
  service: "listing_views_service",
  transport: "listing_views_transport",
};

/** Search-term rollups predate the singular listing_type spelling, so both
 *  "stays" and "stay" exist in the data — normalize before filtering. */
const normCat = (c: string) => (c === "stays" ? "stay" : c === "services" ? "service" : c);

export default function AdminDiscovery() {
  const range = useAdminRange();
  const [selected, setSelected] = useState<string | null>(null);
  const funnelQ = useQuery({ queryKey: ["admin-funnel", rangeQuery(range)], queryFn: () => adminMetrics.funnel(range) });
  const termsQ = useQuery({ queryKey: ["admin-terms", rangeQuery(range)], queryFn: () => adminMetrics.searchTerms(range, 20) });
  // Powers the selected category's views-over-time chart. Same query key as
  // the Overview page, so the cache is shared; only fetched once drilled in.
  const overviewQ = useQuery({
    queryKey: ["admin-overview", rangeQuery(range)],
    queryFn: () => adminMetrics.overview(range),
    enabled: selected != null,
  });

  if (funnelQ.isLoading || termsQ.isLoading) return <StateNote>Loading…</StateNote>;
  if (funnelQ.error || !funnelQ.data) return <StateNote>Couldn’t load metrics.</StateNote>;

  const byType = funnelQ.data.byType.map((r) => ({ ...r, label: TYPE_LABEL[r.listingType] ?? r.listingType }));
  const terms = termsQ.data?.terms ?? [];

  const toggle = (t: string) => setSelected((cur) => (cur === t ? null : t));
  const handleBarClick = (d: unknown) => {
    const t = (d as { payload?: { listingType?: string } })?.payload?.listingType;
    if (t) toggle(t);
  };

  // Range changes can drop the selected category's row — fall back to closed.
  const sel = selected ? byType.find((r) => r.listingType === selected) ?? null : null;
  const selLabel = sel?.label ?? "";

  const stages = sel
    ? [
        { label: "Listing views", value: sel.views },
        { label: "Card clicks", value: sel.cardClicks },
        { label: "Booking opens", value: sel.modalOpens },
        { label: "Payment starts", value: sel.paymentStarts },
        { label: "Bookings", value: sel.bookings },
      ]
    : [];
  const stageMax = Math.max(...stages.map((s) => s.value), 1);

  const viewsSeries = sel
    ? (overviewQ.data?.series ?? []).map((r) => ({ day: r.day, views: Number(r[VIEWS_KEY[sel.listingType]] ?? 0) }))
    : [];
  const selTerms = sel ? terms.filter((t) => normCat(t.category) === sel.listingType) : [];

  return (
    <>
      <PageHeading title="Discovery" subtitle="How people browse and search" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Listing views by category" subtitle="Views vs. card clicks — click a category to break it down">
          {sel && (
            <button
              onClick={() => setSelected(null)}
              className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary"
            >
              {selLabel}
              <X className="h-3 w-3" />
            </button>
          )}
          {byType.length === 0 ? (
            <StateNote>No views in this range yet.</StateNote>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byType} margin={{ top: 5, right: 12, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="views" name="Views" fill={VIEWS_COLOR} radius={[6, 6, 0, 0]} cursor="pointer" onClick={handleBarClick}>
                    {byType.map((r) => (
                      <Cell key={r.listingType} fillOpacity={!selected || selected === r.listingType ? 1 : 0.35} />
                    ))}
                  </Bar>
                  <Bar dataKey="cardClicks" name="Card clicks" fill={CLICKS_COLOR} radius={[6, 6, 0, 0]} cursor="pointer" onClick={handleBarClick}>
                    {byType.map((r) => (
                      <Cell key={r.listingType} fillOpacity={!selected || selected === r.listingType ? 1 : 0.35} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="mt-4 grid grid-cols-3 gap-3">
            {byType.map((r) => (
              <button
                key={r.listingType}
                onClick={() => toggle(r.listingType)}
                className={`rounded-xl p-3 text-center transition-colors ${
                  selected === r.listingType ? "bg-primary/10 ring-1 ring-primary/40" : "bg-muted/40 hover:bg-muted/70"
                }`}
              >
                <p className="text-xs text-muted-foreground">{r.label} CTR</p>
                <p className="font-display text-lg font-bold">{rate(r.cardClicks, r.views)}</p>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="Top search terms" subtitle="Most searched keywords">
          {terms.length === 0 ? (
            <StateNote>No search terms in this range yet.</StateNote>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">Term</th>
                    <th className="pb-2 font-medium">Category</th>
                    <th className="pb-2 text-right font-medium">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {terms.map((tr, i) => (
                    <tr key={`${tr.category}-${tr.term}-${i}`} className="border-t border-border/60">
                      <td className="py-2 font-medium">{tr.term}</td>
                      <td className="py-2 capitalize text-muted-foreground">{tr.category}</td>
                      <td className="py-2 text-right tabular-nums">{fmt(tr.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {sel && (
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Panel title={`${selLabel} journey`} subtitle="Each step's share, with conversion from the previous step">
            <div className="space-y-2.5">
              {stages.map((s, i) => {
                const pct = Math.min(100, Math.round((s.value / stageMax) * 100));
                const prev = i > 0 ? stages[i - 1].value : 0;
                return (
                  <div key={s.label}>
                    <div className="mb-1 flex items-baseline justify-between text-xs">
                      <span className="text-muted-foreground">{s.label}</span>
                      <span className="tabular-nums font-medium">
                        {fmt(s.value)}
                        {i > 0 && <span className="ml-1.5 font-normal text-muted-foreground">{rate(s.value, prev)} of prev.</span>}
                      </span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex items-center justify-between rounded-xl bg-muted/40 p-3 text-sm">
              <span className="text-muted-foreground">View → booking</span>
              <span className="font-semibold tabular-nums">{rate(sel.bookings, sel.views)}</span>
            </div>
            <div className="mt-2 flex items-center justify-between rounded-xl bg-muted/40 p-3 text-sm">
              <span className="text-muted-foreground">Revenue</span>
              <span className="font-semibold tabular-nums">{rupees(sel.revenuePaise)}</span>
            </div>
          </Panel>

          <Panel title="Views over time" subtitle={`Daily ${selLabel.toLowerCase()} listing views`}>
            {overviewQ.isLoading ? (
              <StateNote>Loading…</StateNote>
            ) : viewsSeries.length === 0 ? (
              <StateNote>No daily data in this range yet.</StateNote>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={viewsSeries} margin={{ top: 5, right: 12, left: -12, bottom: 0 }}>
                    <defs>
                      <linearGradient id="discViewsFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={VIEWS_COLOR} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={VIEWS_COLOR} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={dayTick} tick={{ fontSize: 11 }} minTickGap={24} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Area type="monotone" dataKey="views" name="Views" stroke={VIEWS_COLOR} strokeWidth={2} fill="url(#discViewsFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Panel>

          <Panel title={`What people search for`} subtitle={`Top ${selLabel.toLowerCase()} search terms`}>
            {selTerms.length === 0 ? (
              <StateNote>No searches recorded for {selLabel} in this range.</StateNote>
            ) : (
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {selTerms.map((tr, i) => (
                      <tr key={`${tr.term}-${i}`} className="border-t border-border/60 first:border-t-0">
                        <td className="py-2 font-medium">{tr.term}</td>
                        <td className="py-2 text-right tabular-nums">{fmt(tr.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}
