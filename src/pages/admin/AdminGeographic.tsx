import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { adminMetrics } from "@/domains/analytics/admin-metrics.service";
import { adminFilterActive, filterQuery, rangeQuery } from "@/domains/analytics/admin-metrics.service";
import { useAdminFilter, useAdminRange } from "./AdminLayout";
import { Panel, PageHeading, StateNote, fmt, rupees } from "./adminUi";

export default function AdminGeographic() {
  const range = useAdminRange();
  const filter = useAdminFilter();
  const active = adminFilterActive(filter);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-geo", rangeQuery(range), filterQuery(filter)],
    queryFn: () => adminMetrics.geo(range, 15, filter),
  });

  if (isLoading) return <StateNote>Loading…</StateNote>;
  if (error || !data) return <StateNote>Couldn’t load metrics.</StateNote>;

  const cities = data.cities;
  const chart = cities.slice(0, 10).map((c) => ({ city: c.city, bookings: c.bookings }));

  return (
    <>
      <PageHeading title="Geographic" subtitle={active ? "Where demand is coming from (by listing city, filtered)" : "Where demand is coming from (by booking city)"} />

      {cities.length === 0 ? (
        <StateNote>No city-tagged bookings in this range yet.</StateNote>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Top cities" subtitle="Bookings by city">
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} layout="vertical" margin={{ top: 5, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="city" tick={{ fontSize: 12 }} width={96} />
                  <Tooltip />
                  <Bar dataKey="bookings" name="Bookings" fill="hsl(239, 84%, 67%)" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel title="City breakdown" subtitle="Bookings & revenue">
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">City</th>
                    <th className="pb-2 text-right font-medium">Bookings</th>
                    <th className="pb-2 text-right font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {cities.map((c) => (
                    <tr key={c.city} className="border-t border-border/60">
                      <td className="py-2 font-medium">{c.city}</td>
                      <td className="py-2 text-right tabular-nums">{fmt(c.bookings)}</td>
                      <td className="py-2 text-right tabular-nums">{rupees(c.revenuePaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}
