import { useQuery } from "@tanstack/react-query";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { adminMetrics } from "@/domains/analytics/admin-metrics.service";
import { rangeQuery } from "@/domains/analytics/admin-metrics.service";
import { useAdminRange } from "./AdminLayout";
import { Kpi, Panel, PageHeading, StateNote, fmt, rupees, rate } from "./adminUi";

const dayTick = (d: string) => d.slice(5);

export default function AdminEngagement() {
  const range = useAdminRange();
  const engQ = useQuery({ queryKey: ["admin-engagement", rangeQuery(range)], queryFn: () => adminMetrics.engagement(range) });
  const ovQ = useQuery({ queryKey: ["admin-overview", rangeQuery(range)], queryFn: () => adminMetrics.overview(range) });

  if (engQ.isLoading || ovQ.isLoading) return <StateNote>Loading…</StateNote>;
  if (engQ.error || !engQ.data || !ovQ.data) return <StateNote>Couldn’t load metrics.</StateNote>;

  const eng = engQ.data;
  const t = ovQ.data.totals;
  const avgRating = t.reviews_submitted > 0 ? (t.reviews_rating_sum / t.reviews_submitted).toFixed(2) : "—";
  const hasContact = eng.series.some((r) => r.callClicks > 0 || r.messageClicks > 0);

  return (
    <>
      <PageHeading title="Engagement & activity" subtitle="Contact, reviews, cancellations, coupons and saves" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Call clicks" value={fmt(eng.totals.callClicks)} />
        <Kpi label="Message clicks" value={fmt(eng.totals.messageClicks)} />
        <Kpi label="Reviews" value={fmt(t.reviews_submitted)} sub={`★ ${avgRating} avg`} />
        <Kpi label="Cancellations" value={fmt(t.bookings_cancelled)} sub={`${rupees(t.refund_paise)} refunded`} />
        <Kpi label="Coupons applied" value={fmt(t.coupons_applied)} sub={`${rupees(t.discount_paise)} off · ${fmt(t.coupons_failed)} failed`} />
        <Kpi label="Wishlist saves" value={fmt(t.wishlist_adds)} sub={`${fmt(t.wishlist_removes)} removed`} />
        <Kpi label="Cancel rate" value={rate(t.bookings_cancelled, t.bookings_confirmed + t.bookings_cancelled)} />
        <Kpi label="Coupon success" value={rate(t.coupons_applied, t.coupons_applied + t.coupons_failed)} />
        <Kpi label="AI messages" value={fmt(t.ai_messages)} sub="assistant turns" />
        <Kpi label="Fraud signals" value={fmt(t.fraud_signals)} sub={`${fmt(t.fraud_critical)} high/critical`} />
      </div>

      <div className="mt-6">
        <Panel title="Contact clicks" subtitle="Daily calls vs. messages">
          {!hasContact ? (
            <StateNote>No contact activity in this range yet.</StateNote>
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={eng.series} margin={{ top: 5, right: 12, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="day" tickFormatter={dayTick} tick={{ fontSize: 11 }} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Line type="monotone" dataKey="callClicks" name="Calls" stroke="hsl(239, 84%, 67%)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="messageClicks" name="Messages" stroke="hsl(160, 60%, 45%)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
