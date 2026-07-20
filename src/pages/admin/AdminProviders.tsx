import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { adminMetrics } from "@/domains/analytics/admin-metrics.service";
import { adminFilterActive, filterQuery, rangeQuery } from "@/domains/analytics/admin-metrics.service";
import { useAdminFilter, useAdminRange } from "./AdminLayout";
import { Kpi, Panel, PageHeading, StateNote, fmt, rupees } from "./adminUi";

const dayTick = (d: string) => d.slice(5);

export default function AdminProviders() {
  const range = useAdminRange();
  const filter = useAdminFilter();
  const active = adminFilterActive(filter);
  const fkey = filterQuery(filter);
  const { data, isLoading, error } = useQuery({ queryKey: ["admin-overview", rangeQuery(range)], queryFn: () => adminMetrics.overview(range) });
  // When a listing filter is active, all four tiles + the chart re-source live
  // from bookings/listings/reviews (the day-keyed rollup can't be sliced).
  const providersQ = useQuery({
    queryKey: ["admin-providers-filtered", rangeQuery(range), fkey],
    queryFn: () => adminMetrics.filteredProviders(range, filter),
    enabled: active,
  });

  if (isLoading) return <StateNote>Loading…</StateNote>;
  if (error || !data) return <StateNote>Couldn’t load metrics.</StateNote>;

  const t = data.totals;
  const fp = providersQ.data;
  const loadingFiltered = active && !fp;

  // Distinct providers can't be summed across days without double-counting;
  // unfiltered shows the peak single-day figure, filtered shows distinct
  // providers with a booking in the window.
  const peakActiveProviders = data.series.reduce((m, r) => Math.max(m, r.active_providers), 0);

  const newListings = active ? (fp?.totals.newListings ?? 0) : t.new_listings;
  const activeProviders = active ? (fp?.totals.activeProviders ?? 0) : peakActiveProviders;
  const providerRevenue = active ? (fp?.totals.providerRevenuePaise ?? 0) : t.revenue_paise;
  const providerBookings = active ? (fp?.totals.bookings ?? 0) : t.bookings_confirmed;
  const reviews = active ? (fp?.totals.reviews ?? 0) : t.reviews_submitted;
  const ratingSum = active ? (fp?.totals.reviewsRatingSum ?? 0) : t.reviews_rating_sum;
  const listingSeries = active
    ? (fp?.series ?? []).map((r) => ({ day: r.day, listings: r.listings }))
    : data.series.map((r) => ({ day: r.day, listings: r.new_listings }));
  const val = (n: number) => (loadingFiltered ? "…" : fmt(n));

  return (
    <>
      <PageHeading title="Providers" subtitle="Supply-side activity" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="New listings" value={val(newListings)} />
        <Kpi label="Active providers" value={val(activeProviders)} sub={active ? "with bookings in range" : "peak / day"} />
        <Kpi label="Provider revenue" value={loadingFiltered ? "…" : rupees(providerRevenue)} sub={`${fmt(providerBookings)} bookings`} />
        <Kpi label="Reviews received" value={val(reviews)} sub={reviews > 0 ? `★ ${(ratingSum / reviews).toFixed(2)} avg` : undefined} />
      </div>

      <div className="mt-6">
        <Panel title="New listings" subtitle="Listings created per day">
          {newListings === 0 ? (
            <StateNote>{loadingFiltered ? "Loading…" : "No new listings in this range yet."}</StateNote>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={listingSeries} margin={{ top: 5, right: 12, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="day" tickFormatter={dayTick} tick={{ fontSize: 11 }} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="listings" name="New listings" fill="hsl(239, 84%, 67%)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
