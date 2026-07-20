import { useQuery } from "@tanstack/react-query";
import { adminMetrics, type FunnelTypeRow } from "@/domains/analytics/admin-metrics.service";
import { rangeQuery } from "@/domains/analytics/admin-metrics.service";
import { useAdminRange } from "./AdminLayout";
import { Panel, PageHeading, StateNote, Kpi, fmt, rate, rupees } from "./adminUi";

const TYPE_LABEL: Record<string, string> = { stay: "Stays", service: "Services", transport: "Transport" };

const STAGES: Array<{ key: keyof FunnelTypeRow; label: string }> = [
  { key: "views", label: "Views" },
  { key: "cardClicks", label: "Card clicks" },
  { key: "modalOpens", label: "Booking modal" },
  { key: "paymentStarts", label: "Payment started" },
  { key: "bookings", label: "Booked" },
];

function Funnel({ row }: { row: FunnelTypeRow }) {
  const top = row.views || 1;
  return (
    <div className="space-y-2">
      {STAGES.map((s) => {
        const val = Number(row[s.key]);
        const pct = Math.min(100, Math.round((val / top) * 100));
        return (
          <div key={s.key}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{s.label}</span>
              <span className="tabular-nums font-medium">{fmt(val)}</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function AdminConversion() {
  const range = useAdminRange();
  const { data, isLoading, error } = useQuery({ queryKey: ["admin-funnel", rangeQuery(range)], queryFn: () => adminMetrics.funnel(range) });

  if (isLoading) return <StateNote>Loading…</StateNote>;
  if (error || !data) return <StateNote>Couldn’t load metrics.</StateNote>;

  const byType = data.byType;
  const totalViews = byType.reduce((s, r) => s + r.views, 0);
  const totalBookings = byType.reduce((s, r) => s + r.bookings, 0);
  const totalPayments = byType.reduce((s, r) => s + r.paymentStarts, 0);
  const totalRevenue = byType.reduce((s, r) => s + r.revenuePaise, 0);

  return (
    <>
      <PageHeading title="Conversion" subtitle="Discovery → booking funnel per category" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="View → booking" value={rate(totalBookings, totalViews)} />
        <Kpi label="Payment → booking" value={rate(totalBookings, totalPayments)} />
        <Kpi label="Total bookings" value={fmt(totalBookings)} />
        <Kpi label="Revenue" value={rupees(totalRevenue)} />
      </div>

      {byType.length === 0 ? (
        <div className="mt-6"><StateNote>No funnel activity in this range yet.</StateNote></div>
      ) : (
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {byType.map((row) => (
            <Panel key={row.listingType} title={TYPE_LABEL[row.listingType] ?? row.listingType} subtitle={`${rate(row.bookings, row.views)} view→booking · ${rupees(row.revenuePaise)}`}>
              <Funnel row={row} />
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
