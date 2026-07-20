import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { adminMetrics, adminFilterActive, filterQuery, rangeQuery, type CustomersResponse } from "@/domains/analytics/admin-metrics.service";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAdminFilter, useAdminRange } from "./AdminLayout";
import { Kpi, Panel, PageHeading, PlatformWide, StateNote, fmt, rupees } from "./adminUi";

type TopCustomer = CustomersResponse["topCustomers"][number];

// Fixed display order + labels for the booking-value histogram bands the
// backend emits (paise edges live in admin-metrics.repository.ts aovBands).
const AOV_BANDS: Array<[key: string, label: string]> = [
  ["under_500", "< ₹500"],
  ["500_1k", "₹500–1K"],
  ["1k_2_5k", "₹1K–2.5K"],
  ["2_5k_5k", "₹2.5K–5K"],
  ["5k_plus", "₹5K+"],
];

const COMBO_LABELS: Record<string, string> = {
  stay: "Stays only",
  service: "Services only",
  transport: "Transport only",
  "service+stay": "Stays + services",
  "stay+transport": "Stays + transport",
  "service+transport": "Services + transport",
  "service+stay+transport": "All three",
};

export default function AdminCustomers() {
  const range = useAdminRange();
  const filter = useAdminFilter();
  const active = adminFilterActive(filter);
  // Click-through detail for a top-customer row: id + name + email + phone.
  // Contact fields live in the popup only, keeping the table itself scannable.
  const [selected, setSelected] = useState<TopCustomer | null>(null);
  // Booking-backed panels (new/returning, AOV bands, crossover, top customers)
  // respond to the filter; the event-rollup panels below stay platform-wide.
  const customersQ = useQuery({ queryKey: ["admin-customers", rangeQuery(range), filterQuery(filter)], queryFn: () => adminMetrics.customers(range, 10, filter) });
  const languagesQ = useQuery({ queryKey: ["admin-languages", rangeQuery(range)], queryFn: () => adminMetrics.languages(range) });
  const originsQ = useQuery({ queryKey: ["admin-origins", rangeQuery(range)], queryFn: () => adminMetrics.origins(range, 15) });
  const originDestQ = useQuery({ queryKey: ["admin-origin-dest", rangeQuery(range)], queryFn: () => adminMetrics.originDest(range, 15) });
  const failuresQ = useQuery({ queryKey: ["admin-payment-failures", rangeQuery(range)], queryFn: () => adminMetrics.paymentFailures(range) });
  const cancelsQ = useQuery({ queryKey: ["admin-cancel-reasons", rangeQuery(range)], queryFn: () => adminMetrics.cancelReasons(range) });

  if (customersQ.isLoading) return <StateNote>Loading…</StateNote>;
  if (customersQ.error || !customersQ.data) return <StateNote>Couldn’t load metrics.</StateNote>;

  const c = customersQ.data;
  const failures = failuresQ.data?.reasons ?? [];
  const failureTotal = failures.reduce((s, r) => s + r.count, 0);
  const newTotal = c.newVsReturning.reduce((s, r) => s + r.newBookers, 0);
  const returningTotal = c.newVsReturning.reduce((s, r) => s + r.returningBookers, 0);
  const bands = AOV_BANDS.map(([key, label]) => ({
    band: label,
    bookings: c.aovBands.find((b) => b.band === key)?.bookings ?? 0,
  }));

  return (
    <>
      <PageHeading title="Customers" subtitle="Who books, how often they come back, and where they travel" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="New vs returning"
          value={`${fmt(newTotal)} / ${fmt(returningTotal)}`}
          sub="Bookers in range (first-ever vs repeat)"
        />
        <PlatformWide active={active}>
          <Kpi
            label="Repeat rate"
            value={c.repeat.bookers > 0 ? `${(c.repeat.repeatRate * 100).toFixed(1)}%` : "—"}
            sub={`${fmt(c.repeat.repeatBookers)} of ${fmt(c.repeat.bookers)} customers booked again (all-time)`}
          />
        </PlatformWide>
        <PlatformWide active={active}>
          <Kpi
            label="Time to 2nd booking"
            value={c.repeat.medianDaysToSecond == null ? "—" : `${Math.round(c.repeat.medianDaysToSecond)}d`}
            sub="Median days between first and second booking"
          />
        </PlatformWide>
        <PlatformWide active={active}>
          <Kpi
            label="Payment failures"
            value={fmt(failureTotal)}
            sub="Failed or abandoned payments in range"
          />
        </PlatformWide>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="New vs returning bookers" subtitle="Daily bookers, split by first-ever vs repeat">
          {c.newVsReturning.length === 0 ? (
            <StateNote>No bookings in this range yet.</StateNote>
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={c.newVsReturning} margin={{ top: 5, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="newBookers" name="New" stackId="a" fill="hsl(239, 84%, 67%)" />
                  <Bar dataKey="returningBookers" name="Returning" stackId="a" fill="hsl(160, 60%, 45%)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel title="Booking value" subtitle="Bookings by order value (agreed price)">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bands} margin={{ top: 5, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="band" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="bookings" name="Bookings" fill="hsl(27, 87%, 60%)" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Category crossover" subtitle="What combinations customers book (all-time)">
          {c.crossover.length === 0 ? (
            <StateNote>No booking history yet.</StateNote>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Combination</th>
                  <th className="pb-2 text-right font-medium">Customers</th>
                </tr>
              </thead>
              <tbody>
                {c.crossover.map((r) => (
                  <tr key={r.combo} className="border-t border-border/60">
                    <td className="py-2 font-medium">{COMBO_LABELS[r.combo] ?? r.combo}</td>
                    <td className="py-2 text-right tabular-nums">{fmt(r.customers)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <PlatformWide active={active}>
        <Panel title="Language mix" subtitle="Active users by UI language">
          {(languagesQ.data?.languages?.length ?? 0) === 0 ? (
            <StateNote>No language-tagged events in this range yet.</StateNote>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Language</th>
                  <th className="pb-2 text-right font-medium">Active users (peak day)</th>
                  <th className="pb-2 text-right font-medium">Events</th>
                </tr>
              </thead>
              <tbody>
                {languagesQ.data!.languages.map((l) => (
                  <tr key={l.language} className="border-t border-border/60">
                    <td className="py-2 font-medium uppercase">{l.language}</td>
                    <td className="py-2 text-right tabular-nums">{fmt(l.activeUsers)}</td>
                    <td className="py-2 text-right tabular-nums">{fmt(l.events)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        </PlatformWide>

        <PlatformWide active={active}>
        <Panel title="Customer origins" subtitle="Where customers browse from (granted location only)">
          {(originsQ.data?.origins?.length ?? 0) === 0 ? (
            <StateNote>No origin-tagged sessions in this range yet.</StateNote>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">City</th>
                    <th className="pb-2 text-right font-medium">Active users (peak day)</th>
                    <th className="pb-2 text-right font-medium">Searches</th>
                  </tr>
                </thead>
                <tbody>
                  {originsQ.data!.origins.map((o) => (
                    <tr key={`${o.originCity}|${o.originState}`} className="border-t border-border/60">
                      <td className="py-2 font-medium">{o.originCity}{o.originState ? `, ${o.originState}` : ""}</td>
                      <td className="py-2 text-right tabular-nums">{fmt(o.activeUsers)}</td>
                      <td className="py-2 text-right tabular-nums">{fmt(o.searches)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        </PlatformWide>

        <PlatformWide active={active}>
        <Panel title="Origin → destination" subtitle="Booking-funnel city pairs (modal opens / payment starts)">
          {(originDestQ.data?.pairs?.length ?? 0) === 0 ? (
            <StateNote>No origin→destination pairs in this range yet.</StateNote>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">Route</th>
                    <th className="pb-2 text-right font-medium">Modal opens</th>
                    <th className="pb-2 text-right font-medium">Payment starts</th>
                  </tr>
                </thead>
                <tbody>
                  {originDestQ.data!.pairs.map((p) => (
                    <tr key={`${p.originCity}→${p.destCity}`} className="border-t border-border/60">
                      <td className="py-2 font-medium">{p.originCity} → {p.destCity}</td>
                      <td className="py-2 text-right tabular-nums">{fmt(p.modalOpens)}</td>
                      <td className="py-2 text-right tabular-nums">{fmt(p.paymentStarts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        </PlatformWide>

        <PlatformWide active={active}>
        <Panel title="Cancellation reasons" subtitle="Why guests cancel ('unspecified' = host/assistant cancels)">
          {(cancelsQ.data?.reasons?.length ?? 0) === 0 ? (
            <StateNote>No cancellations in this range.</StateNote>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Reason</th>
                  <th className="pb-2 text-right font-medium">Cancellations</th>
                </tr>
              </thead>
              <tbody>
                {cancelsQ.data!.reasons.map((r) => (
                  <tr key={r.reason} className="border-t border-border/60">
                    <td className="py-2 font-medium">{r.reason.replace(/_/g, " ")}</td>
                    <td className="py-2 text-right tabular-nums">{fmt(r.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        </PlatformWide>

        <PlatformWide active={active}>
        <Panel title="Payment failure reasons" subtitle="Razorpay error codes + user dismissals">
          {failures.length === 0 ? (
            <StateNote>No payment failures in this range.</StateNote>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Reason code</th>
                  <th className="pb-2 text-right font-medium">Count</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((r) => (
                  <tr key={r.reasonCode} className="border-t border-border/60">
                    <td className="py-2 font-medium">{r.reasonCode.replace(/_/g, " ")}</td>
                    <td className="py-2 text-right tabular-nums">{fmt(r.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        </PlatformWide>
      </div>

      <div className="mt-4">
        <Panel title="Top customers" subtitle={active ? "By revenue in range for the filtered listings — click a row for contact details" : "By lifetime revenue (nightly rollup) — click a row for contact details"}>
          {c.topCustomers.length === 0 ? (
            <StateNote>No customer profiles yet — the nightly rollup populates this.</StateNote>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">Customer</th>
                    <th className="pb-2 text-right font-medium">Bookings</th>
                    <th className="pb-2 text-right font-medium">Cancelled</th>
                    <th className="pb-2 text-right font-medium">Lifetime value</th>
                    <th className="pb-2 font-medium">Favorite</th>
                    <th className="pb-2 font-medium">Home city</th>
                    <th className="pb-2 font-medium">Lang</th>
                    <th className="pb-2 font-medium">Channel</th>
                    <th className="pb-2 font-medium">Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {c.topCustomers.map((u) => (
                    <tr
                      key={u.userId}
                      onClick={() => setSelected(u)}
                      className="cursor-pointer border-t border-border/60 hover:bg-muted/50"
                    >
                      <td className="py-2 font-medium">{u.displayName || <span className="font-mono text-xs">{u.userId.slice(0, 10)}…</span>}</td>
                      <td className="py-2 text-right tabular-nums">{fmt(u.bookingsTotal)}</td>
                      <td className="py-2 text-right tabular-nums">{fmt(u.cancelledTotal)}</td>
                      <td className="py-2 text-right tabular-nums">{rupees(u.revenuePaiseTotal)}</td>
                      <td className="py-2">{u.favoriteCategory ?? "—"}</td>
                      <td className="py-2">{u.homeCity ?? "—"}</td>
                      <td className="py-2 uppercase">{u.language ?? "—"}</td>
                      <td className="py-2">{u.acquisitionChannel ?? "—"}</td>
                      <td className="py-2 tabular-nums">{u.lastActiveDay ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{selected?.displayName || "Customer"}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-0 text-sm">
              {[
                ["Customer ID", selected.userId],
                ["Name", selected.displayName ?? "—"],
                ["Email", selected.email ?? "—"],
                ["Phone", selected.phone ?? "—"],
              ].map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-4 border-b border-border/60 py-2.5 last:border-0">
                  <span className="shrink-0 text-muted-foreground">{label}</span>
                  <span className={`text-right ${label === "Customer ID" ? "break-all font-mono text-xs" : "font-medium"}`}>{value}</span>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
