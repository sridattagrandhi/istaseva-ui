// Partner-facing analytics tab, shared by the Host / Provider / Transport
// dashboards. Renders the admin-style Kpi/Panel look over the partner-scoped
// /api/providers/me/insights endpoint — everything here is the caller's own
// data except the category search-demand panel (platform-level by design).
//
// KPI tiles are clickable: each opens a breakdown strip below the row (status
// mix, cancellation reasons, repeat detail, lead-time detail). Deltas compare
// against the equal-length previous window the endpoint returns.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { X } from "lucide-react";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import { Kpi, KpiDelta, Panel, StateNote, fmt, rate } from "./metric-ui";
import { MetricRangePicker, type MetricRange } from "./MetricRangePicker";

export type InsightsCategory = "stay" | "service" | "transport";

interface InsightsData {
  from: string;
  to: string;
  series: Array<{ day: string; bookings: number; cancelled: number }>;
  statusMix: Array<{ status: string; count: number }>;
  cancelReasons: Array<{ reason: string; count: number }>;
  paymentFailures: Array<{ reason: string; count: number }>;
  repeat: { bookers: number; repeatBookers: number; repeatRate: number | null; medianDaysToSecond: number | null };
  leadTime: { medianDays: number | null; avgDays: number | null };
  searchDemand: Array<{ term: string; count: number }>;
  /** 'niche' = terms narrowed to this partner's own listings; 'category' = platform-wide fallback. */
  searchDemandScope?: "niche" | "category";
  /** Searched places (from place-picked searches) within the partner's operating cities/states. */
  searchPlaces?: Array<{ regionType: "city" | "state"; region: string; count: number }>;
  funnel: {
    totals: { views: number; cardClicks: number; modalOpens: number; paymentStarts: number; bookings: number };
    byListing: Array<{ listingId: string; name: string; views: number; cardClicks: number; modalOpens: number; paymentStarts: number; bookings: number }>;
  };
  /** Equal-length window immediately before [from, to] — deltas + chart overlay. */
  prev?: {
    from: string;
    to: string;
    series: Array<{ day: string; bookings: number; cancelled: number }>;
    repeat: { repeatRate: number | null };
    leadTime: { medianDays: number | null };
  };
  heatmap?: Array<{ dow: number; hour: number | null; count: number }>;
  stay?: null | {
    rooms: number;
    series: Array<{ day: string; roomNights: number; revenuePaise: number }>;
    totals: { roomNights: number; occupancyPct: number | null; adrPaise: number | null };
    prevTotals: { occupancyPct: number | null; adrPaise: number | null };
  };
  transport?: null | {
    pickups: Array<{ label: string; count: number }>;
    modes: Array<{ mode: string; count: number }>;
  };
}

const rangeQuery = (r: MetricRange) => ("days" in r ? `days=${r.days}` : `from=${r.from}&to=${r.to}`);

/** Count list rendered as label + proportional bar — cancel reasons, failures, search terms. */
function CountBars({ rows, empty }: { rows: Array<{ label: string; count: number }>; empty: string }) {
  if (rows.length === 0) return <StateNote>{empty}</StateNote>;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <span className="w-40 shrink-0 truncate text-xs capitalize text-muted-foreground" title={r.label}>
            {r.label.replace(/[_-]+/g, " ")}
          </span>
          <div className="h-5 flex-1 overflow-hidden rounded-md bg-muted/50">
            <div className="h-full rounded-md bg-primary/70" style={{ width: `${(r.count / max) * 100}%` }} />
          </div>
          <span className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums">{fmt(r.count)}</span>
        </div>
      ))}
    </div>
  );
}

/** Readable date for chart tooltips: "Mon, 14 Jul" from a YYYY-MM-DD day key. */
const fmtDay = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? day
    : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
};

/** Styled tooltip shared by the insights charts: date header + swatched rows. */
function ChartTip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color?: string; stroke?: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-[10rem] rounded-lg border border-border bg-background px-3 py-2 text-xs shadow-lg">
      <p className="mb-1.5 font-semibold">{fmtDay(String(label))}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2 py-0.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: p.color ?? p.stroke }} />
          <span className="text-muted-foreground">{p.name}</span>
          <span className="ml-auto font-semibold tabular-nums">{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Demand heatmap: ISO day-of-week rows × 2-hour columns (night folded) ──
const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOUR_COLS = ["6–8a", "8–10a", "10–12", "12–2p", "2–4p", "4–6p", "6–8p", "8–10p", "Night"];
const hourBucket = (hour: number) => (hour < 6 || hour >= 22 ? 8 : Math.floor((hour - 6) / 2));

/** Cell shade for a count against the grid max — shared by cells and the legend key. */
const heatColor = (n: number, max: number) =>
  n > 0 ? `hsla(239, 84%, 67%, ${0.15 + 0.85 * (n / max)})` : "hsl(var(--muted) / 0.4)";

function DemandHeatmap({ rows }: { rows: Array<{ dow: number; hour: number | null; count: number }> }) {
  const { t } = useLanguage();
  const grid: number[][] = Array.from({ length: 7 }, () => Array(9).fill(0));
  for (const r of rows) {
    if (r.hour == null || r.dow < 1 || r.dow > 7) continue;
    grid[r.dow - 1][hourBucket(r.hour)] += r.count;
  }
  const max = Math.max(1, ...grid.flat());
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[560px]">
        <div className="grid gap-1" style={{ gridTemplateColumns: "2.5rem repeat(9, minmax(0, 1fr))" }}>
          <div />
          {HOUR_COLS.map((c) => (
            <div key={c} className="pb-1 text-center text-[10px] text-muted-foreground">{c}</div>
          ))}
          {grid.map((row, d) => (
            <div key={DOW_SHORT[d]} className="contents">
              <div className="flex items-center text-[11px] text-muted-foreground">{DOW_SHORT[d]}</div>
              {row.map((n, c) => (
                <div
                  key={c}
                  title={`${DOW_SHORT[d]} ${HOUR_COLS[c]} · ${fmt(n)}`}
                  className="h-7 rounded-md"
                  style={{ backgroundColor: heatColor(n, max) }}
                />
              ))}
            </div>
          ))}
        </div>
        {/* Color key: same ramp the cells use, from empty to the busiest slot. */}
        <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
          <span>{t("partner.insights.heatKeyFewer", { defaultValue: "Fewer" })}</span>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span key={f} className="h-3 w-3 rounded-[3px]" style={{ backgroundColor: heatColor(f * max, max) }} />
          ))}
          <span>{t("partner.insights.heatKeyMore", { defaultValue: "More" })}</span>
        </div>
      </div>
    </div>
  );
}

const MODE_LABELS: Record<string, string> = { cab: "Point-to-point", hourly: "Hourly", day: "Full day", package: "Package" };

type KpiKey = "bookings" | "cancel" | "repeat" | "lead";

export function InsightsPanel({ category }: { category: InsightsCategory }) {
  const { t } = useLanguage();
  const [range, setRange] = useState<MetricRange>({ days: 30 });
  const [detail, setDetail] = useState<KpiKey | null>(null);
  // Previous-period overlay on the bookings chart — off by default so the
  // first glance is just this period's bars.
  const [showPrev, setShowPrev] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["partner-insights", category, range],
    staleTime: 60_000,
    queryFn: async () => {
      const result = await apiRequest<{ data: InsightsData }>(
        `/api/providers/me/insights?category=${category}&${rangeQuery(range)}`,
        { headers: getJsonHeaders(false) },
      );
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load insights");
      return result.data.data;
    },
  });

  const totalBookings = (data?.series ?? []).reduce((s, r) => s + r.bookings, 0);
  const totalCancelled = (data?.series ?? []).reduce((s, r) => s + r.cancelled, 0);
  const prevBookings = (data?.prev?.series ?? []).reduce((s, r) => s + r.bookings, 0);
  const prevCancelled = (data?.prev?.series ?? []).reduce((s, r) => s + r.cancelled, 0);
  const cancelPct = totalBookings > 0 ? (totalCancelled / totalBookings) * 100 : 0;
  const prevCancelPct = prevBookings > 0 ? (prevCancelled / prevBookings) * 100 : 0;
  const vsLabel = data?.prev ? `vs ${data.prev.from} → ${data.prev.to}` : undefined;

  // Overlay the previous period on the bookings chart: each current day maps
  // to the day one window-length earlier (series aren't densified, so a
  // missing prev row simply means 0 that day).
  const spanDays = data ? Math.round((Date.parse(`${data.to}T00:00:00Z`) - Date.parse(`${data.from}T00:00:00Z`)) / 86_400_000) + 1 : 0;
  const prevByDay = new Map((data?.prev?.series ?? []).map((r) => [r.day, r]));
  const chartData = (data?.series ?? []).map((r) => ({
    ...r,
    prev: prevByDay.get(new Date(Date.parse(`${r.day}T00:00:00Z`) - spanDays * 86_400_000).toISOString().slice(0, 10))?.bookings ?? 0,
  }));

  const funnelTotals = data?.funnel.totals;
  const hasFunnel = Boolean(
    funnelTotals && (funnelTotals.views || funnelTotals.cardClicks || funnelTotals.modalOpens || funnelTotals.paymentStarts || funnelTotals.bookings),
  );
  const funnelSteps = funnelTotals
    ? [
        { label: t("partner.insights.views", { defaultValue: "Views" }), value: funnelTotals.views },
        { label: t("partner.insights.cardClicks", { defaultValue: "Card clicks" }), value: funnelTotals.cardClicks },
        { label: t("partner.insights.modalOpens", { defaultValue: "Booking opens" }), value: funnelTotals.modalOpens },
        { label: t("partner.insights.paymentStarts", { defaultValue: "Payment starts" }), value: funnelTotals.paymentStarts },
        { label: t("partner.insights.bookings", { defaultValue: "Bookings" }), value: funnelTotals.bookings },
      ]
    : [];
  const funnelMax = Math.max(...funnelSteps.map((s) => s.value), 1);

  const heatmapRows = data?.heatmap ?? [];
  const hasHeatmap = heatmapRows.some((r) => r.hour != null && r.count > 0);
  // Stays have no start hour — show which weekdays check-ins land on instead.
  const checkinDays = DOW_SHORT.map((label, i) => ({
    label,
    count: heatmapRows.filter((r) => r.dow === i + 1).reduce((s, r) => s + r.count, 0),
  }));

  const stay = data?.stay;
  const occupancySeries = (stay?.series ?? []).map((r) => ({
    day: r.day,
    pct: stay && stay.rooms > 0 ? Math.round((r.roomNights / stay.rooms) * 1000) / 10 : 0,
  }));
  const transport = data?.transport;

  const toggleDetail = (k: KpiKey) => setDetail((cur) => (cur === k ? null : k));
  const kpiBtn = (k: KpiKey, node: React.ReactNode) => (
    <button
      type="button"
      onClick={() => toggleDetail(k)}
      className={`w-full rounded-2xl text-left transition-shadow ${detail === k ? "ring-2 ring-primary/50" : "hover:ring-1 hover:ring-primary/25"}`}
    >
      {node}
    </button>
  );

  const DETAIL_TITLES: Record<KpiKey, string> = {
    bookings: t("partner.insights.detailBookings", { defaultValue: "Bookings by status" }),
    cancel: t("partner.insights.detailCancel", { defaultValue: "Top cancellation reasons" }),
    repeat: t("partner.insights.detailRepeat", { defaultValue: "Repeat customers" }),
    lead: t("partner.insights.detailLead", { defaultValue: "Booking lead time" }),
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">{t("partner.insights.title", { defaultValue: "Insights" })}</h2>
        <MetricRangePicker value={range} onChange={setRange} />
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-2xl bg-muted/40" />
      ) : isError || !data ? (
        <StateNote>{t("partner.insights.error", { defaultValue: "Couldn't load insights. Please try again." })}</StateNote>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {kpiBtn("bookings",
              <Kpi
                label={t("partner.insights.kpiBookings", { defaultValue: "Bookings received" })}
                value={fmt(totalBookings)}
                sub={t("partner.insights.kpiBookingsSub", { defaultValue: "created in this period" })}
                delta={<KpiDelta current={totalBookings} previous={prevBookings} title={vsLabel} />}
              />,
            )}
            {kpiBtn("cancel",
              <Kpi
                label={t("partner.insights.kpiCancelRate", { defaultValue: "Cancellation rate" })}
                value={rate(totalCancelled, totalBookings)}
                sub={t("partner.insights.kpiCancelRateSub", { defaultValue: "{{count}} cancelled", count: totalCancelled })}
                delta={<KpiDelta current={cancelPct} previous={prevCancelPct} invert title={vsLabel} />}
              />,
            )}
            {kpiBtn("repeat",
              <Kpi
                label={t("partner.insights.kpiRepeatRate", { defaultValue: "Repeat customers" })}
                value={data.repeat.repeatRate != null ? `${data.repeat.repeatRate}%` : "—"}
                sub={
                  data.repeat.medianDaysToSecond != null
                    ? t("partner.insights.kpiRepeatSub", { defaultValue: "~{{days}} days to second booking", days: data.repeat.medianDaysToSecond })
                    : t("partner.insights.kpiRepeatSubEmpty", { defaultValue: "{{repeat}} of {{total}} customers", repeat: data.repeat.repeatBookers, total: data.repeat.bookers })
                }
                delta={
                  data.repeat.repeatRate != null && data.prev?.repeat.repeatRate != null ? (
                    <KpiDelta current={data.repeat.repeatRate} previous={data.prev.repeat.repeatRate} title={vsLabel} />
                  ) : undefined
                }
              />,
            )}
            {kpiBtn("lead",
              <Kpi
                label={t("partner.insights.kpiLeadTime", { defaultValue: "Booking lead time" })}
                value={data.leadTime.medianDays != null ? t("partner.insights.daysCount", { defaultValue: "{{count}} days", count: data.leadTime.medianDays }) : "—"}
                sub={t("partner.insights.kpiLeadTimeSub", { defaultValue: "median days booked in advance" })}
              />,
            )}
          </div>

          {detail && (
            <div className="rounded-2xl border border-primary/20 bg-primary/[0.03] p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">{DETAIL_TITLES[detail]}</h3>
                <button onClick={() => setDetail(null)} className="rounded-full p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
                  <X className="h-4 w-4" />
                </button>
              </div>
              {detail === "bookings" && (
                <>
                  <CountBars
                    rows={data.statusMix.map((r) => ({ label: r.status, count: r.count }))}
                    empty={t("partner.insights.noBookings", { defaultValue: "No bookings in this period yet." })}
                  />
                  {data.prev && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {t("partner.insights.prevBookingsNote", { defaultValue: "Previous period ({{from}} → {{to}}): {{count}} bookings", from: data.prev.from, to: data.prev.to, count: fmt(prevBookings) })}
                    </p>
                  )}
                </>
              )}
              {detail === "cancel" && (
                <>
                  <CountBars
                    rows={data.cancelReasons.slice(0, 5).map((r) => ({ label: r.reason, count: r.count }))}
                    empty={t("partner.insights.noCancels", { defaultValue: "No cancellations in this period." })}
                  />
                  {data.prev && prevBookings > 0 && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {t("partner.insights.prevCancelNote", { defaultValue: "Previous period cancellation rate: {{rate}}", rate: rate(prevCancelled, prevBookings) })}
                    </p>
                  )}
                </>
              )}
              {detail === "repeat" && (
                <div className="space-y-2 text-sm">
                  <p>
                    {t("partner.insights.repeatDetail", { defaultValue: "{{repeat}} of {{total}} customers booked with you more than once in this period.", repeat: fmt(data.repeat.repeatBookers), total: fmt(data.repeat.bookers) })}
                  </p>
                  {data.repeat.medianDaysToSecond != null && (
                    <p className="text-muted-foreground">
                      {t("partner.insights.repeatGap", { defaultValue: "Typical gap between first and second booking: ~{{days}} days.", days: data.repeat.medianDaysToSecond })}
                    </p>
                  )}
                  {data.prev?.repeat.repeatRate != null && (
                    <p className="text-xs text-muted-foreground">
                      {t("partner.insights.prevRepeatNote", { defaultValue: "Previous period repeat rate: {{rate}}%", rate: data.prev.repeat.repeatRate })}
                    </p>
                  )}
                </div>
              )}
              {detail === "lead" && (
                <div className="space-y-2 text-sm">
                  <p>
                    {t("partner.insights.leadDetail", { defaultValue: "Median {{median}} days · average {{avg}} days booked in advance.", median: data.leadTime.medianDays ?? "—", avg: data.leadTime.avgDays ?? "—" })}
                  </p>
                  {data.prev?.leadTime.medianDays != null && (
                    <p className="text-xs text-muted-foreground">
                      {t("partner.insights.prevLeadNote", { defaultValue: "Previous period median: {{days}} days", days: data.prev.leadTime.medianDays })}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t("partner.insights.leadHint", { defaultValue: "Longer lead times mean customers plan ahead — keep your calendar open further out to capture them." })}
                  </p>
                </div>
              )}
            </div>
          )}

          <Panel
            title={t("partner.insights.bookingsOverTime", { defaultValue: "Bookings over time" })}
            subtitle={
              showPrev
                ? t("partner.insights.bookingsOverTimeSubPrev", { defaultValue: "Bookings received per day, with cancellations — dashed line is the previous period" })
                : t("partner.insights.bookingsOverTimeSub", { defaultValue: "Bookings received per day, with cancellations" })
            }
          >
            {data.series.length === 0 ? (
              <StateNote>{t("partner.insights.noBookings", { defaultValue: "No bookings in this period yet." })}</StateNote>
            ) : (
              <>
                {data.prev && (
                  <div className="mb-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => setShowPrev((v) => !v)}
                      aria-pressed={showPrev}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                        showPrev
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-muted/60"
                      }`}
                    >
                      {t("partner.insights.comparePrev", { defaultValue: "Compare with previous period" })}
                    </button>
                  </div>
                )}
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 5, right: 16, left: 0, bottom: 0 }} barGap={1} barCategoryGap="22%">
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="day" tickFormatter={(v: string) => v.slice(5)} tick={{ fontSize: 11 }} minTickGap={24} tickLine={false} axisLine={false} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={36} />
                      <Tooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted) / 0.4)" }} />
                      <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                      <Bar
                        dataKey="bookings"
                        name={t("partner.insights.bookings", { defaultValue: "Bookings" })}
                        fill="hsl(239, 84%, 67%)"
                        radius={[3, 3, 0, 0]}
                        maxBarSize={28}
                      />
                      <Bar
                        dataKey="cancelled"
                        name={t("partner.insights.cancelled", { defaultValue: "Cancelled" })}
                        fill="hsl(0, 72%, 51%)"
                        radius={[3, 3, 0, 0]}
                        maxBarSize={28}
                      />
                      {showPrev && (
                        <Line
                          type="monotone"
                          dataKey="prev"
                          name={t("partner.insights.prevPeriod", { defaultValue: "Previous period" })}
                          stroke="hsl(var(--muted-foreground))"
                          strokeWidth={1.5}
                          strokeDasharray="4 4"
                          dot={false}
                        />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </Panel>

          {category === "stay" && stay && (
            <div className="grid gap-5 lg:grid-cols-2">
              <Panel
                title={t("partner.insights.occupancy", { defaultValue: "Occupancy & nightly rate" })}
                subtitle={t("partner.insights.occupancySub", { defaultValue: "{{rooms}} sellable rooms across your listings", rooms: stay.rooms })}
              >
                {stay.rooms === 0 ? (
                  <StateNote>{t("partner.insights.occupancyNoRooms", { defaultValue: "Add room types to your listings to see occupancy." })}</StateNote>
                ) : (
                  <>
                    <div className="mb-3 flex flex-wrap gap-6">
                      <div>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("partner.insights.occupancyRate", { defaultValue: "Occupancy" })}</p>
                        <p className="flex items-baseline gap-2 font-display text-xl font-bold tabular-nums">
                          {stay.totals.occupancyPct != null ? `${stay.totals.occupancyPct}%` : "—"}
                          {stay.totals.occupancyPct != null && stay.prevTotals.occupancyPct != null && (
                            <KpiDelta current={stay.totals.occupancyPct} previous={stay.prevTotals.occupancyPct} title={vsLabel} />
                          )}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("partner.insights.adr", { defaultValue: "Avg nightly rate" })}</p>
                        <p className="flex items-baseline gap-2 font-display text-xl font-bold tabular-nums">
                          {stay.totals.adrPaise != null ? `₹${fmt(Math.round(stay.totals.adrPaise / 100))}` : "—"}
                          {stay.totals.adrPaise != null && stay.prevTotals.adrPaise != null && (
                            <KpiDelta current={stay.totals.adrPaise} previous={stay.prevTotals.adrPaise} title={vsLabel} />
                          )}
                        </p>
                      </div>
                    </div>
                    {occupancySeries.length === 0 ? (
                      <StateNote>{t("partner.insights.occupancyEmpty", { defaultValue: "No stays in this period yet." })}</StateNote>
                    ) : (
                      <div className="h-44 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <ComposedChart data={occupancySeries} margin={{ top: 5, right: 16, left: 0, bottom: 0 }}>
                            <defs>
                              <linearGradient id="insightsOccFill" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="hsl(160, 60%, 45%)" stopOpacity={0.35} />
                                <stop offset="100%" stopColor="hsl(160, 60%, 45%)" stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                            <XAxis dataKey="day" tickFormatter={(v: string) => v.slice(5)} tick={{ fontSize: 11 }} minTickGap={24} />
                            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${v}%`} width={44} />
                            <Tooltip formatter={(v: number) => `${v}%`} />
                            <Area
                              type="monotone"
                              dataKey="pct"
                              name={t("partner.insights.occupancyRate", { defaultValue: "Occupancy" })}
                              stroke="hsl(160, 60%, 45%)"
                              strokeWidth={2}
                              fill="url(#insightsOccFill)"
                            />
                          </ComposedChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </>
                )}
              </Panel>
              <Panel
                title={t("partner.insights.checkinDays", { defaultValue: "Check-in days" })}
                subtitle={t("partner.insights.checkinDaysSub", { defaultValue: "Which weekdays your stays begin on" })}
              >
                <CountBars
                  rows={checkinDays}
                  empty={t("partner.insights.noBookings", { defaultValue: "No bookings in this period yet." })}
                />
              </Panel>
            </div>
          )}

          {category !== "stay" && (
            <div className={transport ? "grid gap-5 lg:grid-cols-2" : ""}>
              <Panel
                title={t("partner.insights.heatmap", { defaultValue: "When demand lands" })}
                subtitle={t("partner.insights.heatmapSub", { defaultValue: "Booked slots by weekday and hour — use it to set your working hours" })}
              >
                {!hasHeatmap ? (
                  <StateNote>{t("partner.insights.heatmapEmpty", { defaultValue: "No scheduled bookings in this period yet." })}</StateNote>
                ) : (
                  <DemandHeatmap rows={heatmapRows} />
                )}
              </Panel>
              {transport && (
                <Panel
                  title={t("partner.insights.tripDemand", { defaultValue: "Where trips start" })}
                  subtitle={t("partner.insights.tripDemandSub", { defaultValue: "Your top pickup areas and trip types" })}
                >
                  <CountBars
                    rows={transport.pickups.map((p) => ({ label: p.label, count: p.count }))}
                    empty={t("partner.insights.noPickups", { defaultValue: "No pickup locations recorded in this period." })}
                  />
                  {transport.modes.length > 0 && (
                    <div className="mt-5 border-t border-border/60 pt-4">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t("partner.insights.tripMix", { defaultValue: "Trip mix" })}
                      </p>
                      <CountBars
                        rows={transport.modes.map((m) => ({ label: MODE_LABELS[m.mode] ?? m.mode, count: m.count }))}
                        empty=""
                      />
                    </div>
                  )}
                </Panel>
              )}
            </div>
          )}

          <Panel
            title={t("partner.insights.funnel", { defaultValue: "Discovery → booking funnel" })}
            subtitle={t("partner.insights.funnelSub", { defaultValue: "How customers move from seeing your listings to booking" })}
          >
            {!hasFunnel ? (
              <StateNote>{t("partner.insights.funnelEmpty", { defaultValue: "No funnel data for this period yet — views and clicks are counted from listing activity." })}</StateNote>
            ) : (
              <>
                <div className="space-y-2">
                  {funnelSteps.map((s) => (
                    <div key={s.label} className="flex items-center gap-3">
                      <span className="w-32 shrink-0 text-xs text-muted-foreground">{s.label}</span>
                      <div className="h-6 flex-1 overflow-hidden rounded-md bg-muted/50">
                        <div
                          className="flex h-full items-center justify-end rounded-md bg-gradient-to-r from-primary to-primary/70 pr-2"
                          style={{ width: `${Math.max((s.value / funnelMax) * 100, s.value > 0 ? 4 : 0)}%` }}
                        >
                          {s.value > 0 && <span className="whitespace-nowrap text-[10px] font-bold text-primary-foreground">{fmt(s.value)}</span>}
                        </div>
                      </div>
                      <span className="w-12 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">
                        {rate(s.value, funnelMax)}
                      </span>
                    </div>
                  ))}
                </div>
                {data.funnel.byListing.length > 1 && (
                  <div className="mt-5 border-t border-border/60 pt-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("partner.insights.byListing", { defaultValue: "By listing" })}
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                            <th className="py-1.5 pr-3 font-medium">{t("partner.insights.listing", { defaultValue: "Listing" })}</th>
                            <th className="py-1.5 pr-3 text-right font-medium">{t("partner.insights.views", { defaultValue: "Views" })}</th>
                            <th className="py-1.5 pr-3 text-right font-medium">{t("partner.insights.cardClicks", { defaultValue: "Card clicks" })}</th>
                            <th className="py-1.5 pr-3 text-right font-medium">{t("partner.insights.modalOpens", { defaultValue: "Booking opens" })}</th>
                            <th className="py-1.5 text-right font-medium">{t("partner.insights.bookings", { defaultValue: "Bookings" })}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.funnel.byListing.map((l) => (
                            <tr key={l.listingId} className="border-t border-border/40">
                              <td className="max-w-[14rem] truncate py-2 pr-3 font-medium">{l.name}</td>
                              <td className="py-2 pr-3 text-right tabular-nums">{fmt(l.views)}</td>
                              <td className="py-2 pr-3 text-right tabular-nums">{fmt(l.cardClicks)}</td>
                              <td className="py-2 pr-3 text-right tabular-nums">{fmt(l.modalOpens)}</td>
                              <td className="py-2 text-right font-semibold tabular-nums">{fmt(l.bookings)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </Panel>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel
              title={t("partner.insights.cancelReasons", { defaultValue: "Cancellation reasons" })}
              subtitle={t("partner.insights.cancelReasonsSub", { defaultValue: "Why bookings were cancelled in this period" })}
            >
              <CountBars
                rows={data.cancelReasons.map((r) => ({ label: r.reason, count: r.count }))}
                empty={t("partner.insights.noCancels", { defaultValue: "No cancellations in this period." })}
              />
            </Panel>
            <Panel
              title={t("partner.insights.paymentFailures", { defaultValue: "Payment failures" })}
              subtitle={t("partner.insights.paymentFailuresSub", { defaultValue: "Failed payment attempts on your bookings" })}
            >
              <CountBars
                rows={data.paymentFailures.map((r) => ({ label: r.reason, count: r.count }))}
                empty={t("partner.insights.noFailures", { defaultValue: "No failed payments in this period." })}
              />
            </Panel>
          </div>

          <Panel
            title={t("partner.insights.searchDemand", { defaultValue: "What customers search for" })}
            subtitle={
              data.searchDemandScope === "niche"
                ? t("partner.insights.searchDemandNicheSub", { defaultValue: "Marketplace searches matching your listings" })
                : t("partner.insights.searchDemandSub", { defaultValue: "Top searches in your category across the marketplace" })
            }
          >
            <CountBars
              rows={data.searchDemand.map((r) => ({ label: r.term, count: r.count }))}
              empty={t("partner.insights.noSearches", { defaultValue: "No search data in this period." })}
            />
            {(data.searchPlaces ?? []).length > 0 && (
              <div className="mt-5 border-t border-border/60 pt-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("partner.insights.searchPlaces", { defaultValue: "Where customers are searching" })}
                </p>
                <p className="mb-3 text-xs text-muted-foreground">
                  {t("partner.insights.searchPlacesSub", { defaultValue: "Searches in the places you operate" })}
                </p>
                <CountBars
                  rows={(data.searchPlaces ?? []).map((r) => ({ label: r.region, count: r.count }))}
                  empty=""
                />
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
