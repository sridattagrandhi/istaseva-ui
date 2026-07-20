import { useQuery } from "@tanstack/react-query";
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { adminMetrics } from "@/domains/analytics/admin-metrics.service";
import { adminFilterActive, filterQuery, rangeQuery } from "@/domains/analytics/admin-metrics.service";
import { useAdminFilter, useAdminRange } from "./AdminLayout";
import { Kpi, KpiDelta, Panel, PageHeading, PlatformWide, StateNote, fmt, rate, rupees } from "./adminUi";

const PLATFORM_LABEL: Record<string, string> = { web: "Web", mobile: "Mobile", server: "Server" };

const dayTick = (d: string) => d.slice(5); // MM-DD

const CHANNEL_LABEL: Record<string, string> = { direct: "Direct", app: "Mobile app" };
const chLabel = (c: string) => CHANNEL_LABEL[c] ?? c;

export default function AdminOverview() {
  const range = useAdminRange();
  const filter = useAdminFilter();
  const active = adminFilterActive(filter);
  const fkey = filterQuery(filter);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-overview", rangeQuery(range)],
    queryFn: () => adminMetrics.overview(range),
  });
  const acqQ = useQuery({ queryKey: ["admin-acq", rangeQuery(range)], queryFn: () => adminMetrics.acquisition(range, 10) });
  // Money comes from the payments source of truth (the event rollups undercount
  // revenue — see the Revenue tab); behavioral tiles stay rollup-based.
  const sumQ = useQuery({ queryKey: ["admin-rev-summary", rangeQuery(range), fkey], queryFn: () => adminMetrics.revenueSummary(range, filter) });
  // Bookings tile + chart re-source live from bookings⨝listings when filtered
  // (the rollup can't be sliced by listing dimension).
  const bookingsQ = useQuery({
    queryKey: ["admin-bookings-filtered", rangeQuery(range), fkey],
    queryFn: () => adminMetrics.filteredBookings(range, filter),
    enabled: active,
  });

  if (isLoading) return <StateNote>Loading…</StateNote>;
  if (error || !data) return <StateNote>Couldn’t load metrics.</StateNote>;

  const t = data.totals;
  const pt = data.prevTotals;
  // Delta pills compare against the equal-length window just before this one.
  const vsLabel = `vs ${data.prevRange.from} → ${data.prevRange.to}`;
  const money = sumQ.data?.totals;
  const prevMoney = sumQ.data?.prevTotals;
  const platformData = (data.platform ?? [])
    .filter((p) => p.platform !== "server")
    .map((p) => ({ ...p, label: PLATFORM_LABEL[p.platform] ?? p.platform }));
  const channels = acqQ.data?.channels ?? [];

  // Overlay the previous period on the bookings chart: each current day maps
  // to the day exactly one window-length earlier (series aren't densified, so
  // a missing prev rollup row simply means 0 that day).
  const shiftDay = (day: string) =>
    new Date(Date.parse(`${day}T00:00:00Z`) - data.range.days * 86_400_000).toISOString().slice(0, 10);
  const prevByDay = new Map(data.prevSeries.map((r) => [r.day, r]));
  const rollupBookingsSeries = data.series.map((r) => ({
    day: r.day,
    bookings_confirmed: r.bookings_confirmed,
    prev_bookings: prevByDay.get(shiftDay(r.day))?.bookings_confirmed ?? 0,
  }));

  // When filtered, the Bookings tile + chart come from the live endpoint.
  const fb = bookingsQ.data;
  const fbPrevByDay = new Map((fb?.prevSeries ?? []).map((r) => [r.day, r]));
  const filteredBookingsSeries = (fb?.series ?? []).map((r) => ({
    day: r.day,
    bookings_confirmed: r.bookings,
    prev_bookings: fbPrevByDay.get(shiftDay(r.day))?.bookings ?? 0,
  }));
  const bookingsSeries = active ? filteredBookingsSeries : rollupBookingsSeries;
  const bookingsCurrent = active ? (fb?.totals.bookings ?? 0) : t.bookings_confirmed;
  const bookingsPrevious = active ? (fb?.prevTotals.bookings ?? 0) : pt.bookings_confirmed;
  const bookingsValue = active && !fb ? "…" : fmt(bookingsCurrent);
  const bookingsSub = active
    ? (fb ? `${rupees(fb.totals.revenuePaise)} agreed value` : undefined)
    : `${rate(t.bookings_confirmed, t.listing_views_total)} of views`;

  return (
    <>
      <PageHeading title="Overview" subtitle={`Platform activity · ${data.range.from} → ${data.range.to} · deltas ${vsLabel}`} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Kpi
          label="Revenue (GMV)"
          value={money ? rupees(money.grossPaise) : "…"}
          sub={money ? `${rupees(money.aovPaise)} avg order` : undefined}
          delta={money && prevMoney ? <KpiDelta current={money.grossPaise} previous={prevMoney.grossPaise} title={vsLabel} /> : undefined}
        />
        <Kpi label="Bookings" value={bookingsValue} sub={bookingsSub}
          delta={<KpiDelta current={bookingsCurrent} previous={bookingsPrevious} title={vsLabel} />} />
        <PlatformWide active={active}>
          <Kpi label="Active users" value={fmt(t.active_users)} sub={`${fmt(t.logins)} logins`}
            delta={<KpiDelta current={t.active_users} previous={pt.active_users} title={vsLabel} />} />
        </PlatformWide>
        <PlatformWide active={active}>
          <Kpi label="New signups" value={fmt(t.new_signups)}
            delta={<KpiDelta current={t.new_signups} previous={pt.new_signups} title={vsLabel} />} />
        </PlatformWide>
        <PlatformWide active={active}>
          <Kpi label="Listing views" value={fmt(t.listing_views_total)} sub={`${fmt(t.searches)} searches`}
            delta={<KpiDelta current={t.listing_views_total} previous={pt.listing_views_total} title={vsLabel} />} />
        </PlatformWide>
        <PlatformWide active={active}>
          <Kpi label="Contact clicks" value={fmt(t.call_clicks + t.message_clicks)} sub={`${fmt(t.call_clicks)} calls · ${fmt(t.message_clicks)} msgs`}
            delta={<KpiDelta current={t.call_clicks + t.message_clicks} previous={pt.call_clicks + pt.message_clicks} title={vsLabel} />} />
        </PlatformWide>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <PlatformWide active={active}>
          <Panel title="Active users & views" subtitle="Daily trend">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.series} margin={{ top: 5, right: 12, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="day" tickFormatter={dayTick} tick={{ fontSize: 11 }} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Line type="monotone" dataKey="active_users" name="Active users" stroke="hsl(239, 84%, 67%)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="listing_views_total" name="Listing views" stroke="hsl(160, 60%, 45%)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </PlatformWide>

        <Panel title="Bookings" subtitle="Confirmed per day — dashed line is the previous period">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={bookingsSeries} margin={{ top: 5, right: 12, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="adminBookingsFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(24, 90%, 55%)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="hsl(24, 90%, 55%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="day" tickFormatter={dayTick} tick={{ fontSize: 11 }} minTickGap={24} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Line type="monotone" dataKey="prev_bookings" name="Previous period" stroke="hsl(var(--muted-foreground))" strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
                <Area type="monotone" dataKey="bookings_confirmed" name="Bookings" stroke="hsl(24, 90%, 55%)" strokeWidth={2} fill="url(#adminBookingsFill)" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <PlatformWide active={active}>
        <Panel title="Web vs. mobile" subtitle="Events by platform">
          {platformData.length === 0 ? (
            <StateNote>No platform data in this range yet.</StateNote>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={platformData} layout="vertical" margin={{ top: 5, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="label" tick={{ fontSize: 12 }} width={64} />
                  <Tooltip />
                  <Bar dataKey="events" name="Events" fill="hsl(239, 84%, 67%)" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
        </PlatformWide>

        <PlatformWide active={active}>
        <Panel title="Acquisition" subtitle="Where visitors come from">
          {channels.length === 0 ? (
            <StateNote>No acquisition data in this range yet.</StateNote>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Channel</th>
                  <th className="pb-2 text-right font-medium">Sessions</th>
                  <th className="pb-2 text-right font-medium">Signups</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.channel} className="border-t border-border/60">
                    <td className="py-2 font-medium">{chLabel(c.channel)}</td>
                    <td className="py-2 text-right tabular-nums">{fmt(c.sessions)}</td>
                    <td className="py-2 text-right tabular-nums">{fmt(c.signups)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        </PlatformWide>
      </div>
    </>
  );
}
