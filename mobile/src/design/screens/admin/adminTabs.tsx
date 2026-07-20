// The mobile admin analytics tabs — parity with the web dashboard pages.
import React, { useState } from "react";
import { View, Text, Pressable, Modal, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  fetchOverview, fetchFunnel, fetchGeo, fetchSearchTerms, fetchEngagement, fetchAcquisition,
  fetchCustomers, fetchLanguages, fetchOrigins, fetchOriginDest, fetchPaymentFailures, fetchCancelReasons,
  fetchRevenueBreakdown, fetchRevenueSeries, fetchRevenueListings, fetchRevenueSummary,
  fetchFilteredBookings, fetchFilteredProviders, adminFilterActive, filterQ, EMPTY_ADMIN_FILTER,
  rangeKey, type AdminMetricFilter, type AdminRange, type TopCustomer, type RevenueDim, type RevenueSegment,
} from "../../api/adminMetrics";
import { font } from "../../theme";
import { Kpi, KpiDelta, KpiGrid, Card, SecTitle, Empty, Loading, Bar, fmt, rupees, rate, s } from "./adminUi";
import { TrendChart, BarsChart } from "./charts";
import { T } from "../../theme";

const C1 = T.aubergine;
const C2 = "#bd8752"; // saffron — secondary series

const TYPE_LABEL: Record<string, string> = { stay: "Stays", service: "Services", transport: "Transport" };
const PLATFORM_LABEL: Record<string, string> = { web: "Web", mobile: "Mobile", server: "Server" };
const CHANNEL_LABEL: Record<string, string> = { direct: "Direct", app: "Mobile app" };
const chLabel = (c: string) => CHANNEL_LABEL[c] ?? c;

function Row({ label, value, divider }: { label: string; value: string; divider?: boolean }) {
  return (
    <View style={[s.rowBetween, { paddingVertical: 8 }, divider && s.divider]}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.rowMuted}>{value}</Text>
    </View>
  );
}

function Legend({ items }: { items: Array<[string, string]> }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, marginBottom: 8 }}>
      {items.map(([label, color]) => (
        <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: color }} />
          <Text style={s.rowMuted}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

// Tag shown on tiles/sections the listing filter can't narrow (rollup-backed).
const PW = "Platform-wide";

export function OverviewTab({ range, filter = EMPTY_ADMIN_FILTER }: { range: AdminRange; filter?: AdminMetricFilter }) {
  const active = adminFilterActive(filter);
  const fkey = filterQ(filter);
  const { data, isLoading, error } = useQuery({ queryKey: ["m-admin-ov", rangeKey(range)], queryFn: () => fetchOverview(range) });
  const acqQ = useQuery({ queryKey: ["m-admin-acq", rangeKey(range)], queryFn: () => fetchAcquisition(range, 8) });
  // Money from the payments source of truth (rollups undercount revenue).
  const sumQ = useQuery({ queryKey: ["m-admin-rev-sum", rangeKey(range), fkey], queryFn: () => fetchRevenueSummary(range, filter) });
  // Bookings tile + chart re-source live from bookings⨝listings when filtered
  // (the rollup can't be sliced by listing dimension).
  const fbQ = useQuery({
    queryKey: ["m-admin-fb", rangeKey(range), fkey],
    queryFn: () => fetchFilteredBookings(range, filter),
    enabled: active,
  });
  if (isLoading) return <Loading />;
  if (error || !data) return <Empty>Couldn’t load metrics.</Empty>;
  const channels = acqQ.data?.channels ?? [];
  const t = data.totals;
  const pt = data.prevTotals;
  const money = sumQ.data?.totals;
  const prevMoney = sumQ.data?.prevTotals;
  const platform = (data.platform ?? []).filter((p) => p.platform !== "server");
  const maxEv = Math.max(1, ...platform.map((p) => p.events));
  const series: any[] = data.series ?? [];
  // Previous period aligned to the current one by day offset (series aren't
  // densified, so a missing prev rollup row simply means 0 that day).
  const days = data.range?.days ?? 30;
  const prevByDay = new Map<string, any>((data.prevSeries ?? []).map((r: any) => [String(r.day).slice(0, 10), r]));
  const shiftDay = (day: string) =>
    new Date(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  const prevBookings = series.map((r: any) => Number(prevByDay.get(shiftDay(String(r.day)))?.bookings_confirmed ?? 0));

  // Filtered Bookings tile + chart (live source) — swap in when a filter is on.
  const fb = fbQ.data;
  const fbPrevByDay = new Map((fb?.prevSeries ?? []).map((r) => [r.day, r]));
  const fbVals = (fb?.series ?? []).map((r) => r.bookings);
  const fbPrevVals = (fb?.series ?? []).map((r) => fbPrevByDay.get(shiftDay(r.day))?.bookings ?? 0);
  const bookingsCurrent = active ? (fb?.totals.bookings ?? 0) : t.bookings_confirmed;
  const bookingsPrevious = active ? (fb?.prevTotals.bookings ?? 0) : pt?.bookings_confirmed ?? 0;
  const bookingsValue = active && !fb ? "…" : fmt(bookingsCurrent);
  const bookingsSub = active
    ? (fb ? `${rupees(fb.totals.revenuePaise)} agreed value` : undefined)
    : `${rate(t.bookings_confirmed, t.listing_views_total)} of views`;
  const bookingVals = active ? fbVals : series.map((r) => Number(r.bookings_confirmed) || 0);
  const bookingPrevVals = active ? fbPrevVals : prevBookings;

  return (
    <>
      <KpiGrid>
        <Kpi label="Revenue (GMV)" value={money ? rupees(money.grossPaise) : "…"} sub={money ? `${rupees(money.aovPaise)} avg order` : undefined}
          delta={money && prevMoney ? <KpiDelta current={money.grossPaise} previous={prevMoney.grossPaise} /> : undefined} />
        <Kpi label="Bookings" value={bookingsValue} sub={bookingsSub}
          delta={<KpiDelta current={bookingsCurrent} previous={bookingsPrevious} />} />
        <Kpi label="Active users" value={fmt(t.active_users)} sub={`${fmt(t.logins)} logins`} tag={active ? PW : undefined}
          delta={pt ? <KpiDelta current={t.active_users} previous={pt.active_users} /> : undefined} />
        <Kpi label="New signups" value={fmt(t.new_signups)} tag={active ? PW : undefined}
          delta={pt ? <KpiDelta current={t.new_signups} previous={pt.new_signups} /> : undefined} />
        <Kpi label="Listing views" value={fmt(t.listing_views_total)} sub={`${fmt(t.searches)} searches`} tag={active ? PW : undefined}
          delta={pt ? <KpiDelta current={t.listing_views_total} previous={pt.listing_views_total} /> : undefined} />
        <Kpi label="Contact clicks" value={fmt(t.call_clicks + t.message_clicks)} sub={`${fmt(t.call_clicks)} calls · ${fmt(t.message_clicks)} msgs`} tag={active ? PW : undefined}
          delta={pt ? <KpiDelta current={t.call_clicks + t.message_clicks} previous={pt.call_clicks + pt.message_clicks} /> : undefined} />
      </KpiGrid>
      <SecTitle tag={active ? PW : undefined}>Active users & views</SecTitle>
      <Card>
        {series.length === 0 ? <Empty>No trend in this range yet.</Empty> : (
          <>
            <Legend items={[["Active users", C1], ["Listing views", C2]]} />
            <TrendChart values={series.map((r) => Number(r.active_users) || 0)} values2={series.map((r) => Number(r.listing_views_total) || 0)} color={C1} color2={C2} />
          </>
        )}
      </Card>
      <SecTitle>Bookings</SecTitle>
      <Card>
        {active && !fb ? <Loading /> : bookingVals.length === 0 ? <Empty>No bookings in this range yet.</Empty> : (
          <>
            <Legend items={[["Bookings", C2], ["Previous period", T.muted]]} />
            <TrendChart values={bookingVals} values2={bookingPrevVals} color={C2} color2={T.muted} dashed2 />
          </>
        )}
      </Card>
      <SecTitle tag={active ? PW : undefined}>Web vs. mobile</SecTitle>
      <Card>
        {platform.length === 0 ? <Empty>No platform data yet.</Empty> : platform.map((p, i) => (
          <View key={p.platform} style={{ marginBottom: i < platform.length - 1 ? 12 : 0 }}>
            <View style={s.rowBetween}><Text style={s.rowLabel}>{PLATFORM_LABEL[p.platform] ?? p.platform}</Text><Text style={s.rowMuted}>{fmt(p.events)} events</Text></View>
            <Bar value={p.events} max={maxEv} />
          </View>
        ))}
      </Card>
      <SecTitle tag={active ? PW : undefined}>Acquisition</SecTitle>
      <Card>
        {channels.length === 0 ? <Empty>No acquisition data yet.</Empty> : channels.map((c, i) => (
          <Row key={c.channel} label={chLabel(c.channel)} value={`${fmt(c.sessions)} sessions · ${fmt(c.signups)} signups`} divider={i < channels.length - 1} />
        ))}
      </Card>
    </>
  );
}

// "driver-cab" → "Driver Cab" for breakdown labels; type keys get the marketplace names.
const labelize = (v: string) => v.replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
const segLabel = (dim: RevenueDim, key: string) => (dim === "type" ? TYPE_LABEL[key] ?? labelize(key) : labelize(key));

const REV = "#3f8f6e"; // emerald — total revenue (matches the trend chart)
const REVENUE_DIMS: Array<{ dim: RevenueDim; label: string }> = [
  { dim: "type", label: "Type" },
  { dim: "category", label: "Category" },
  { dim: "city", label: "City" },
  { dim: "state", label: "State" },
  { dim: "host", label: "Host" },
];

export function RevenueTab({ range }: { range: AdminRange }) {
  const [dim, setDim] = useState<RevenueDim>("type");
  const [segKey, setSegKey] = useState<string | null>(null);
  const segment: RevenueSegment | null = segKey ? { dim, key: segKey } : null;

  const sum = useQuery({ queryKey: ["m-admin-rev-sum", rangeKey(range)], queryFn: () => fetchRevenueSummary(range) });
  const bd = useQuery({ queryKey: ["m-admin-rev-bd", rangeKey(range), dim], queryFn: () => fetchRevenueBreakdown(range, dim) });
  const sr = useQuery({
    queryKey: ["m-admin-rev-sr", rangeKey(range), dim, segKey ?? ""],
    queryFn: () => fetchRevenueSeries(range, segment),
  });
  const tl = useQuery({
    queryKey: ["m-admin-rev-tl", rangeKey(range), dim, segKey ?? ""],
    queryFn: () => fetchRevenueListings(range, segment, 8),
  });

  if (sum.isLoading) return <Loading />;
  if (sum.error || !sum.data) return <Empty>Couldn't load metrics.</Empty>;
  const t = sum.data.totals;
  const pt = sum.data.prevTotals;

  const breakdown = bd.data?.rows ?? [];
  const maxGross = Math.max(1, ...breakdown.map((r) => r.grossPaise));
  const series = sr.data?.series ?? [];
  const listings = tl.data?.listings ?? [];
  const selectedLabel = segment ? segLabel(segment.dim, segment.key) : null;
  // Both windows are densified server-side to the same length, so the
  // previous period aligns by index. Hidden while a segment is selected.
  const prevVals = (sr.data?.prevSeries ?? []).map((r) => (Number(r.grossPaise) || 0) / 100);
  const showPrev = !segment && prevVals.length > 0;
  // Days without paid bookings are skipped (no misleading ₹0 dips); the chart
  // has no x labels, so the gap is invisible.
  const aovVals = series.filter((r) => Number(r.bookings) > 0).map((r) => Math.round(Number(r.grossPaise) / Number(r.bookings)) / 100);

  // Reconciliation ledger — exact rupees, no ₹L/₹Cr compaction, so rows add up.
  const inr = (paise: number) => `${paise < 0 ? "−" : ""}₹${fmt(Math.abs(Math.round(paise / 100)))}`;
  const ledger = [
    { label: "Booking value (before discounts)", paise: t.grossPaise + (t.discountPaise ?? 0) },
    { label: "Discounts", paise: -(t.discountPaise ?? 0) },
    { label: "Gross charged (GMV)", paise: t.grossPaise, strong: true },
    { label: "Refunds", paise: -t.refundPaise },
    { label: "Net revenue", paise: t.netPaise, strong: true },
  ];
  const composition = [
    { label: "Partner subtotal", paise: t.subtotalPaise ?? 0 },
    { label: "Platform fees", paise: t.platformFeePaise ?? 0 },
    { label: "GST", paise: t.taxesPaise ?? 0 },
    { label: "Trip protection", paise: t.insurancePaise ?? 0 },
  ];

  return (
    <>
      <KpiGrid>
        <Kpi label="Gross (GMV)" value={rupees(t.grossPaise)} sub={`${fmt(t.bookings)} paid bookings`}
          delta={pt ? <KpiDelta current={t.grossPaise} previous={pt.grossPaise} /> : undefined} />
        <Kpi label="Avg order value" value={rupees(t.aovPaise)}
          delta={pt ? <KpiDelta current={t.aovPaise} previous={pt.aovPaise} /> : undefined} />
        <Kpi label="Refunds" value={rupees(t.refundPaise)} sub={`${fmt(t.refundedBookings)} refunded`}
          delta={pt ? <KpiDelta current={t.refundPaise} previous={pt.refundPaise} invert /> : undefined} />
        <Kpi label="Net revenue" value={rupees(t.netPaise)} sub="after refunds"
          delta={pt ? <KpiDelta current={t.netPaise} previous={pt.netPaise} /> : undefined} />
      </KpiGrid>

      <SecTitle>Revenue trend (₹)</SecTitle>
      <Card>
        {sr.isLoading ? <Loading /> : series.length === 0 ? <Empty>No revenue yet.</Empty> : (
          <>
            {segment ? (
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <Legend items={[["All revenue", REV], [selectedLabel ?? "Segment", C1]]} />
                <Pressable onPress={() => setSegKey(null)} hitSlop={8}>
                  <Text style={{ fontSize: 12, fontFamily: font.head, color: T.aubergine }}>Clear ×</Text>
                </Pressable>
              </View>
            ) : showPrev ? (
              <Legend items={[["This period", REV], ["Previous period", T.muted]]} />
            ) : null}
            <TrendChart
              values={series.map((r) => (Number(r.grossPaise) || 0) / 100)}
              values2={segment ? series.map((r) => (Number(r.segmentPaise) || 0) / 100) : showPrev ? prevVals : undefined}
              color={REV}
              color2={segment ? C1 : T.muted}
              dashed2={!segment}
            />
          </>
        )}
      </Card>

      <SecTitle>Avg order value (₹)</SecTitle>
      <Card>
        {sr.isLoading ? <Loading /> : aovVals.length === 0 ? <Empty>No paid bookings in this range yet.</Empty> : (
          <>
            <TrendChart values={aovVals} color={C1} />
            <Text style={[s.rowMuted, { marginTop: 6 }]}>Daily average order value — days without paid bookings are skipped.</Text>
          </>
        )}
      </Card>

      <SecTitle>Revenue breakdown</SecTitle>
      <Card>
        {ledger.map((row, i) => (
          <View key={row.label} style={[s.rowBetween, { paddingVertical: 8 }, i < ledger.length - 1 && s.divider]}>
            <Text style={row.strong ? s.rowLabel : s.rowMuted}>{row.label}</Text>
            <Text style={[s.rowLabel, { fontSize: 13 }]}>{inr(row.paise)}</Text>
          </View>
        ))}
        <Text style={[s.rowMuted, { marginTop: 12, marginBottom: 2, textTransform: "uppercase", letterSpacing: 0.4, fontSize: 10.5 }]}>
          Composition of the charged amount
        </Text>
        {composition.map((row, i) => (
          <View key={row.label} style={[s.rowBetween, { paddingVertical: 8 }, i < composition.length - 1 && s.divider]}>
            <Text style={s.rowMuted}>{row.label}</Text>
            <Text style={[s.rowLabel, { fontSize: 13 }]}>{inr(row.paise)}</Text>
          </View>
        ))}
        <Text style={[s.rowMuted, { marginTop: 8 }]}>
          Composition uses per-payment snapshots; older payments without one count as ₹0, so it can total less than gross.
        </Text>
      </Card>

      <SecTitle>Where revenue comes from</SecTitle>
      <Card>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {REVENUE_DIMS.map((d) => {
            const on = dim === d.dim;
            return (
              <Pressable
                key={d.dim}
                onPress={() => { setDim(d.dim); setSegKey(null); }}
                style={({ pressed }) => [
                  rv.dimChip,
                  on && rv.dimChipOn,
                  pressed && !on && { backgroundColor: "rgba(58,50,71,0.08)", borderColor: T.aubergine },
                ]}
              >
                <Text style={[rv.dimChipTxt, on && rv.dimChipTxtOn]}>{d.label}</Text>
              </Pressable>
            );
          })}
        </View>
        {bd.isLoading ? <Loading /> : breakdown.length === 0 ? <Empty>No paid revenue in this range yet.</Empty> : (
          breakdown.map((row, i) => {
            const on = segKey === row.key;
            return (
              <Pressable
                key={row.key}
                onPress={() => setSegKey((cur) => (cur === row.key ? null : row.key))}
                style={({ pressed }) => [
                  rv.segRow,
                  i < breakdown.length - 1 && { marginBottom: 10 },
                  on && rv.segRowOn,
                  pressed && !on && { backgroundColor: "rgba(58,50,71,0.05)" },
                ]}
              >
                <View style={s.rowBetween}>
                  <Text style={[s.rowLabel, on && { color: T.aubergine }]} numberOfLines={1}>{segLabel(dim, row.key)}</Text>
                  <Text style={[s.rowLabel, { fontSize: 13 }]}>{rupees(row.grossPaise)}</Text>
                </View>
                <Bar value={row.grossPaise} max={maxGross} color={on ? C1 : REV} />
                <Text style={[s.rowMuted, { marginTop: 4 }]}>
                  {fmt(row.bookings)} bookings{row.refundPaise > 0 ? ` · ${rupees(row.refundPaise)} refunded` : ""}
                </Text>
              </Pressable>
            );
          })
        )}
        {breakdown.length > 0 && <Text style={[s.rowMuted, { marginTop: 8 }]}>Tap a segment to see its trend and top listings.</Text>}
      </Card>

      <SecTitle>{selectedLabel ? `Top listings — ${selectedLabel}` : "Top listings"}</SecTitle>
      <Card>
        {tl.isLoading ? <Loading /> : listings.length === 0 ? (
          <Empty>No paid bookings {selectedLabel ? `for ${selectedLabel} ` : ""}in this range.</Empty>
        ) : (
          listings.map((l, i) => (
            <View key={l.listingId} style={[{ paddingVertical: 9 }, i < listings.length - 1 && s.divider]}>
              <View style={s.rowBetween}>
                <Text style={s.rowLabel} numberOfLines={1}>{l.name}</Text>
                <Text style={[s.rowLabel, { fontSize: 13 }]}>{rupees(l.grossPaise)}</Text>
              </View>
              <Text style={s.rowMuted}>
                {(l.listingType ? TYPE_LABEL[l.listingType] ?? labelize(l.listingType) : "—")}
                {l.city ? ` · ${l.city}` : ""} · {fmt(l.bookings)} bookings
                {l.refundPaise > 0 ? ` · net ${rupees(l.grossPaise - l.refundPaise)}` : ""}
              </Text>
            </View>
          ))
        )}
      </Card>
    </>
  );
}

const rv = StyleSheet.create({
  dimChip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  dimChipOn: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  dimChipTxt: { fontSize: 12, fontFamily: font.head, color: T.muted },
  dimChipTxtOn: { color: "#fff" },
  segRow: { borderRadius: 12, padding: 8, marginHorizontal: -8 },
  segRowOn: { backgroundColor: "rgba(58,50,71,0.07)" },
});

// Per-category daily views live on the overview series under these keys.
const VIEWS_KEY: Record<string, string> = {
  stay: "listing_views_stay",
  service: "listing_views_service",
  transport: "listing_views_transport",
};

/** Search-term rollups predate the singular listing_type spelling, so both
 *  "stays" and "stay" exist in the data — normalize before filtering. */
const normCat = (c: string) => (c === "stays" ? "stay" : c === "services" ? "service" : c);

export function DiscoveryTab({ range }: { range: AdminRange }) {
  const [selected, setSelected] = useState<string | null>(null);
  const fn = useQuery({ queryKey: ["m-admin-fn", rangeKey(range)], queryFn: () => fetchFunnel(range) });
  const tm = useQuery({ queryKey: ["m-admin-tm", rangeKey(range)], queryFn: () => fetchSearchTerms(range, 15) });
  // Powers the drill-down's views-over-time chart. Same key as OverviewTab so
  // the cache is shared; only fetched once a category is selected.
  const ov = useQuery({ queryKey: ["m-admin-ov", rangeKey(range)], queryFn: () => fetchOverview(range), enabled: selected != null });
  if (fn.isLoading || tm.isLoading) return <Loading />;
  if (fn.error || !fn.data) return <Empty>Couldn’t load metrics.</Empty>;
  const byType = fn.data.byType;
  const terms = tm.data?.terms ?? [];

  const toggle = (t: string) => setSelected((cur) => (cur === t ? null : t));
  // Range changes can drop the selected category's row — fall back to closed.
  const sel = selected ? byType.find((r) => r.listingType === selected) ?? null : null;
  const selLabel = sel ? TYPE_LABEL[sel.listingType] ?? sel.listingType : "";
  const stages = sel
    ? [
        { label: "Listing views", value: sel.views },
        { label: "Card clicks", value: sel.cardClicks },
        { label: "Booking opens", value: sel.modalOpens },
        { label: "Payment starts", value: sel.paymentStarts },
        { label: "Bookings", value: sel.bookings },
      ]
    : [];
  const stageMax = Math.max(1, ...stages.map((x) => x.value));
  const viewsSeries = sel ? (ov.data?.series ?? []).map((r: any) => Number(r[VIEWS_KEY[sel.listingType]] ?? 0)) : [];
  const selTerms = sel ? terms.filter((tr) => normCat(tr.category) === sel.listingType) : [];

  return (
    <>
      <SecTitle>Listing views by category</SecTitle>
      <Card>
        {byType.length === 0 ? <Empty>No views yet.</Empty> : (
          <>
            <BarsChart bars={byType.map((r) => ({ label: TYPE_LABEL[r.listingType] ?? r.listingType, value: r.views }))} />
            <View style={{ marginTop: 6 }}>
              {byType.map((r) => {
                const on = selected === r.listingType;
                return (
                  <Pressable
                    key={r.listingType}
                    onPress={() => toggle(r.listingType)}
                    style={({ pressed }) => [rv.segRow, { marginBottom: 4 }, on && rv.segRowOn, pressed && !on && { backgroundColor: "rgba(58,50,71,0.05)" }]}
                  >
                    <View style={s.rowBetween}>
                      <Text style={[s.rowLabel, on && { color: T.aubergine }]}>{TYPE_LABEL[r.listingType] ?? r.listingType}</Text>
                      <Text style={s.rowMuted}>{fmt(r.views)} views · {rate(r.cardClicks, r.views)} CTR</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[s.rowMuted, { marginTop: 4 }]}>Tap a category to break it down; tap again to clear.</Text>
          </>
        )}
      </Card>

      {sel && (
        <>
          <SecTitle>{selLabel} journey</SecTitle>
          <Card>
            {stages.map((st, i) => (
              <View key={st.label} style={{ marginBottom: i < stages.length - 1 ? 10 : 0 }}>
                <View style={s.rowBetween}>
                  <Text style={s.rowMuted}>{st.label}</Text>
                  <Text style={s.rowLabel}>
                    {fmt(st.value)}
                    {i > 0 && <Text style={s.rowMuted}>  · {rate(st.value, stages[i - 1].value)} of prev.</Text>}
                  </Text>
                </View>
                <Bar value={st.value} max={stageMax} />
              </View>
            ))}
            <View style={[s.rowBetween, { marginTop: 14 }]}>
              <Text style={s.rowMuted}>View → booking</Text>
              <Text style={s.rowLabel}>{rate(sel.bookings, sel.views)}</Text>
            </View>
            <View style={[s.rowBetween, { marginTop: 6 }]}>
              <Text style={s.rowMuted}>Revenue</Text>
              <Text style={s.rowLabel}>{rupees(sel.revenuePaise)}</Text>
            </View>
          </Card>

          <SecTitle>Views over time</SecTitle>
          <Card>
            {ov.isLoading ? <Loading /> : viewsSeries.length === 0 ? <Empty>No daily data in this range yet.</Empty> : (
              <TrendChart values={viewsSeries} color={C1} />
            )}
          </Card>

          <SecTitle>What people search for</SecTitle>
          <Card>
            {selTerms.length === 0 ? <Empty>No searches recorded for {selLabel} in this range.</Empty> : selTerms.map((tr, i) => (
              <Row key={`${tr.term}-${i}`} label={tr.term} value={fmt(tr.count)} divider={i < selTerms.length - 1} />
            ))}
          </Card>
        </>
      )}

      <SecTitle>Top search terms</SecTitle>
      <Card>
        {terms.length === 0 ? <Empty>No search terms yet.</Empty> : terms.map((tr, i) => (
          <Row key={`${tr.category}-${tr.term}-${i}`} label={tr.term} value={`${tr.category} · ${fmt(tr.count)}`} divider={i < terms.length - 1} />
        ))}
      </Card>
    </>
  );
}

export function ConversionTab({ range }: { range: AdminRange }) {
  const { data, isLoading, error } = useQuery({ queryKey: ["m-admin-fn", rangeKey(range)], queryFn: () => fetchFunnel(range) });
  if (isLoading) return <Loading />;
  if (error || !data) return <Empty>Couldn’t load metrics.</Empty>;
  const byType = data.byType;
  const totalViews = byType.reduce((a, r) => a + r.views, 0);
  const totalBookings = byType.reduce((a, r) => a + r.bookings, 0);
  const totalPayments = byType.reduce((a, r) => a + r.paymentStarts, 0);
  const STAGES: Array<[keyof typeof byType[number], string]> = [["views", "Views"], ["cardClicks", "Card clicks"], ["modalOpens", "Booking modal"], ["paymentStarts", "Payment"], ["bookings", "Booked"]];
  return (
    <>
      <KpiGrid>
        <Kpi label="View → booking" value={rate(totalBookings, totalViews)} />
        <Kpi label="Payment → booking" value={rate(totalBookings, totalPayments)} />
        <Kpi label="Total bookings" value={fmt(totalBookings)} />
        <Kpi label="Total views" value={fmt(totalViews)} />
      </KpiGrid>
      {byType.map((r) => {
        const top = Math.max(1, r.views);
        return (
          <React.Fragment key={r.listingType}>
            <SecTitle>{TYPE_LABEL[r.listingType] ?? r.listingType} · {rate(r.bookings, r.views)}</SecTitle>
            <Card>
              {STAGES.map(([k, lb], i) => (
                <View key={String(k)} style={{ marginBottom: i < STAGES.length - 1 ? 10 : 0 }}>
                  <View style={s.rowBetween}><Text style={s.rowMuted}>{lb}</Text><Text style={s.rowLabel}>{fmt(r[k] as number)}</Text></View>
                  <Bar value={r[k] as number} max={top} />
                </View>
              ))}
            </Card>
          </React.Fragment>
        );
      })}
      {byType.length === 0 && <Card><Empty>No funnel activity yet.</Empty></Card>}
    </>
  );
}

export function EngagementTab({ range }: { range: AdminRange }) {
  const en = useQuery({ queryKey: ["m-admin-en", rangeKey(range)], queryFn: () => fetchEngagement(range) });
  const ov = useQuery({ queryKey: ["m-admin-ov", rangeKey(range)], queryFn: () => fetchOverview(range) });
  if (en.isLoading || ov.isLoading) return <Loading />;
  if (en.error || !en.data || !ov.data) return <Empty>Couldn’t load metrics.</Empty>;
  const t = ov.data.totals;
  const avg = t.reviews_submitted > 0 ? (t.reviews_rating_sum / t.reviews_submitted).toFixed(2) : "—";
  const series = en.data.series ?? [];
  const hasContact = series.some((r) => r.callClicks > 0 || r.messageClicks > 0);
  return (
    <>
      <KpiGrid>
        <Kpi label="Call clicks" value={fmt(en.data.totals.callClicks)} />
        <Kpi label="Message clicks" value={fmt(en.data.totals.messageClicks)} />
        <Kpi label="Reviews" value={fmt(t.reviews_submitted)} sub={`★ ${avg} avg`} />
        <Kpi label="Cancellations" value={fmt(t.bookings_cancelled)} sub={`${rupees(t.refund_paise)} refunded`} />
        <Kpi label="Coupons applied" value={fmt(t.coupons_applied)} sub={`${rupees(t.discount_paise)} off · ${fmt(t.coupons_failed)} failed`} />
        <Kpi label="Wishlist saves" value={fmt(t.wishlist_adds)} sub={`${fmt(t.wishlist_removes)} removed`} />
        <Kpi label="Cancel rate" value={rate(t.bookings_cancelled, t.bookings_confirmed + t.bookings_cancelled)} />
        <Kpi label="Coupon success" value={rate(t.coupons_applied, t.coupons_applied + t.coupons_failed)} />
        <Kpi label="AI messages" value={fmt(t.ai_messages)} sub="assistant turns" />
        <Kpi label="Fraud signals" value={fmt(t.fraud_signals)} sub={`${fmt(t.fraud_critical)} high/critical`} />
      </KpiGrid>
      <SecTitle>Contact clicks</SecTitle>
      <Card>
        {!hasContact ? <Empty>No contact activity yet.</Empty> : (
          <>
            <Legend items={[["Calls", C1], ["Messages", C2]]} />
            <TrendChart values={series.map((r) => Number(r.callClicks) || 0)} values2={series.map((r) => Number(r.messageClicks) || 0)} color={C1} color2={C2} />
          </>
        )}
      </Card>
    </>
  );
}

export function ProvidersTab({ range, filter = EMPTY_ADMIN_FILTER }: { range: AdminRange; filter?: AdminMetricFilter }) {
  const active = adminFilterActive(filter);
  const { data, isLoading, error } = useQuery({ queryKey: ["m-admin-ov", rangeKey(range)], queryFn: () => fetchOverview(range), enabled: !active });
  // All four tiles re-source live from bookings/listings/reviews when a
  // listing filter is on (the day-keyed rollup can't be sliced).
  const fpQ = useQuery({
    queryKey: ["m-admin-fp", rangeKey(range), filterQ(filter)],
    queryFn: () => fetchFilteredProviders(range, filter),
    enabled: active,
  });

  if (active) {
    if (fpQ.isLoading) return <Loading />;
    if (fpQ.error || !fpQ.data) return <Empty>Couldn’t load metrics.</Empty>;
    const ft = fpQ.data.totals;
    const favg = ft.reviews > 0 ? (ft.reviewsRatingSum / ft.reviews).toFixed(2) : undefined;
    return (
      <KpiGrid>
        <Kpi label="New listings" value={fmt(ft.newListings)} />
        <Kpi label="Active providers" value={fmt(ft.activeProviders)} sub="with bookings in range" />
        <Kpi label="Provider revenue" value={rupees(ft.providerRevenuePaise)} sub={`${fmt(ft.bookings)} bookings`} />
        <Kpi label="Reviews received" value={fmt(ft.reviews)} sub={favg ? `★ ${favg} avg` : undefined} />
      </KpiGrid>
    );
  }

  if (isLoading) return <Loading />;
  if (error || !data) return <Empty>Couldn’t load metrics.</Empty>;
  const t = data.totals;
  const peak = (data.series ?? []).reduce((m: number, r: any) => Math.max(m, Number(r.active_providers ?? 0)), 0);
  const avg = t.reviews_submitted > 0 ? (t.reviews_rating_sum / t.reviews_submitted).toFixed(2) : undefined;
  return (
    <KpiGrid>
      <Kpi label="New listings" value={fmt(t.new_listings)} />
      <Kpi label="Active providers" value={fmt(peak)} sub="peak / day" />
      <Kpi label="Provider revenue" value={rupees(t.revenue_paise)} sub={`${fmt(t.bookings_confirmed)} bookings`} />
      <Kpi label="Reviews received" value={fmt(t.reviews_submitted)} sub={avg ? `★ ${avg} avg` : undefined} />
    </KpiGrid>
  );
}

// Fixed display order + labels for the AOV histogram bands the backend emits.
const AOV_BANDS: Array<[string, string]> = [
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

export function CustomersTab({ range, filter = EMPTY_ADMIN_FILTER }: { range: AdminRange; filter?: AdminMetricFilter }) {
  const active = adminFilterActive(filter);
  // Booking-backed panels (new/returning, AOV bands, crossover, top customers)
  // respond to the filter; the event-rollup panels stay platform-wide (tagged).
  const cQ = useQuery({ queryKey: ["m-admin-cust", rangeKey(range), filterQ(filter)], queryFn: () => fetchCustomers(range, 10, filter) });
  const langQ = useQuery({ queryKey: ["m-admin-lang", rangeKey(range)], queryFn: () => fetchLanguages(range) });
  const orgQ = useQuery({ queryKey: ["m-admin-org", rangeKey(range)], queryFn: () => fetchOrigins(range, 10) });
  const odQ = useQuery({ queryKey: ["m-admin-od", rangeKey(range)], queryFn: () => fetchOriginDest(range, 10) });
  const pfQ = useQuery({ queryKey: ["m-admin-pf", rangeKey(range)], queryFn: () => fetchPaymentFailures(range) });
  const crQ = useQuery({ queryKey: ["m-admin-cr", rangeKey(range)], queryFn: () => fetchCancelReasons(range) });
  // Tap a top-customer row → identity popup (id + name + email + phone).
  const [selected, setSelected] = useState<TopCustomer | null>(null);

  if (cQ.isLoading) return <Loading />;
  if (cQ.error || !cQ.data) return <Empty>Couldn’t load metrics.</Empty>;

  const c = cQ.data;
  const failures = pfQ.data?.reasons ?? [];
  const cancels = crQ.data?.reasons ?? [];
  const languages = langQ.data?.languages ?? [];
  const origins = orgQ.data?.origins ?? [];
  const pairs = odQ.data?.pairs ?? [];
  const newTotal = c.newVsReturning.reduce((a, r) => a + r.newBookers, 0);
  const returningTotal = c.newVsReturning.reduce((a, r) => a + r.returningBookers, 0);
  const failureTotal = failures.reduce((a, r) => a + r.count, 0);
  const bands = AOV_BANDS.map(([key, label]) => ({ label, value: c.aovBands.find((b) => b.band === key)?.bookings ?? 0 }));
  const hasTrend = c.newVsReturning.length > 0 && (newTotal > 0 || returningTotal > 0);

  return (
    <>
      <KpiGrid>
        <Kpi label="New / returning" value={`${fmt(newTotal)} / ${fmt(returningTotal)}`} sub="bookers in range" />
        <Kpi label="Repeat rate" value={c.repeat.bookers > 0 ? `${(c.repeat.repeatRate * 100).toFixed(1)}%` : "—"} sub={`${fmt(c.repeat.repeatBookers)} of ${fmt(c.repeat.bookers)} all-time`} tag={active ? PW : undefined} />
        <Kpi label="Time to 2nd booking" value={c.repeat.medianDaysToSecond == null ? "—" : `${Math.round(c.repeat.medianDaysToSecond)}d`} sub="median" tag={active ? PW : undefined} />
        <Kpi label="Payment failures" value={fmt(failureTotal)} sub="failed or abandoned" tag={active ? PW : undefined} />
      </KpiGrid>

      <SecTitle>New vs returning bookers</SecTitle>
      <Card>
        {!hasTrend ? <Empty>No bookings in this range yet.</Empty> : (
          <>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, marginBottom: 8 }}>
              {([["New", C1], ["Returning", C2]] as Array<[string, string]>).map(([label, color]) => (
                <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: color }} />
                  <Text style={s.rowMuted}>{label}</Text>
                </View>
              ))}
            </View>
            <TrendChart values={c.newVsReturning.map((r) => r.newBookers)} values2={c.newVsReturning.map((r) => r.returningBookers)} color={C1} color2={C2} />
          </>
        )}
      </Card>

      <SecTitle>Booking value</SecTitle>
      <Card>
        {bands.every((b) => b.value === 0) ? <Empty>No bookings in this range yet.</Empty> : <BarsChart bars={bands} />}
      </Card>

      <SecTitle>Category crossover</SecTitle>
      <Card>
        {c.crossover.length === 0 ? <Empty>No booking history yet.</Empty> : c.crossover.map((r, i) => (
          <Row key={r.combo} label={COMBO_LABELS[r.combo] ?? r.combo} value={`${fmt(r.customers)} customers`} divider={i < c.crossover.length - 1} />
        ))}
      </Card>

      <SecTitle tag={active ? PW : undefined}>Language mix</SecTitle>
      <Card>
        {languages.length === 0 ? <Empty>No language-tagged events yet.</Empty> : languages.map((l, i) => (
          <Row key={l.language} label={l.language.toUpperCase()} value={`${fmt(l.activeUsers)} users · ${fmt(l.events)} events`} divider={i < languages.length - 1} />
        ))}
      </Card>

      <SecTitle tag={active ? PW : undefined}>Customer origins</SecTitle>
      <Card>
        {origins.length === 0 ? <Empty>No origin-tagged sessions yet.</Empty> : origins.map((o, i) => (
          <Row key={`${o.originCity}|${o.originState}`} label={o.originState ? `${o.originCity}, ${o.originState}` : o.originCity} value={`${fmt(o.activeUsers)} users · ${fmt(o.searches)} searches`} divider={i < origins.length - 1} />
        ))}
      </Card>

      <SecTitle tag={active ? PW : undefined}>Origin → destination</SecTitle>
      <Card>
        {pairs.length === 0 ? <Empty>No origin→destination pairs yet.</Empty> : pairs.map((p, i) => (
          <Row key={`${p.originCity}→${p.destCity}`} label={`${p.originCity} → ${p.destCity}`} value={`${fmt(p.modalOpens)} opens · ${fmt(p.paymentStarts)} payments`} divider={i < pairs.length - 1} />
        ))}
      </Card>

      <SecTitle tag={active ? PW : undefined}>Cancellation reasons</SecTitle>
      <Card>
        {cancels.length === 0 ? <Empty>No cancellations in this range.</Empty> : cancels.map((r, i) => (
          <Row key={r.reason} label={r.reason.replace(/_/g, " ")} value={fmt(r.count)} divider={i < cancels.length - 1} />
        ))}
      </Card>

      <SecTitle tag={active ? PW : undefined}>Payment failure reasons</SecTitle>
      <Card>
        {failures.length === 0 ? <Empty>No payment failures in this range.</Empty> : failures.map((r, i) => (
          <Row key={r.reasonCode} label={r.reasonCode.replace(/_/g, " ")} value={fmt(r.count)} divider={i < failures.length - 1} />
        ))}
      </Card>

      <SecTitle>Top customers</SecTitle>
      <Card>
        {c.topCustomers.length === 0 ? <Empty>No customer profiles yet — the nightly rollup populates this.</Empty> : c.topCustomers.map((u, i) => (
          <Pressable
            key={u.userId}
            onPress={() => setSelected(u)}
            style={({ pressed }) => [cs.custRow, i < c.topCustomers.length - 1 && s.divider, pressed && { backgroundColor: "rgba(58,50,71,0.05)" }]}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.rowLabel} numberOfLines={1}>{u.displayName || `${u.userId.slice(0, 10)}…`}</Text>
              <Text style={s.rowMuted}>
                {fmt(u.bookingsTotal)} bookings · {fmt(u.cancelledTotal)} cancelled{u.favoriteCategory ? ` · ${u.favoriteCategory}` : ""}
              </Text>
            </View>
            <Text style={cs.custValue}>{rupees(u.revenuePaiseTotal)}</Text>
          </Pressable>
        ))}
      </Card>

      {/* Identity popup for the tapped top-customer row. */}
      <Modal visible={!!selected} transparent animationType="fade" onRequestClose={() => setSelected(null)}>
        <Pressable style={cs.overlay} onPress={() => setSelected(null)}>
          <Pressable style={cs.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={cs.sheetTitle}>{selected?.displayName || "Customer"}</Text>
            {selected && ([
              ["Customer ID", selected.userId],
              ["Name", selected.displayName ?? "—"],
              ["Email", selected.email ?? "—"],
              ["Phone", selected.phone ?? "—"],
            ] as Array<[string, string]>).map(([label, value], i, arr) => (
              <View key={label} style={[cs.detailRow, i < arr.length - 1 && s.divider]}>
                <Text style={s.rowMuted}>{label}</Text>
                <Text style={[cs.detailValue, label === "Customer ID" && cs.mono]} selectable>{value}</Text>
              </View>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const cs = StyleSheet.create({
  custRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  custValue: { fontSize: 14, fontFamily: font.head, color: T.ink },
  overlay: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(23,22,28,0.4)", padding: 24 },
  sheet: { width: "100%", maxWidth: 400, backgroundColor: "#fff", borderRadius: 20, padding: 20 },
  sheetTitle: { fontSize: 17, fontFamily: font.head, color: T.ink, marginBottom: 8 },
  detailRow: { paddingVertical: 10, gap: 3 },
  detailValue: { fontSize: 14, fontFamily: font.head, color: T.ink },
  mono: { fontSize: 12, fontFamily: font.body },
});

export function GeographicTab({ range, filter = EMPTY_ADMIN_FILTER }: { range: AdminRange; filter?: AdminMetricFilter }) {
  const active = adminFilterActive(filter);
  const { data, isLoading, error } = useQuery({
    queryKey: ["m-admin-geo", rangeKey(range), filterQ(filter)],
    queryFn: () => fetchGeo(range, 12, filter),
  });
  if (isLoading) return <Loading />;
  if (error || !data) return <Empty>Couldn’t load metrics.</Empty>;
  const cities = data.cities;
  return (
    <>
      <SecTitle>Top cities by bookings</SecTitle>
      <Card>
        {/* Filtered path groups by the LISTING's city (the rollup has no listing dims). */}
        {active && <Text style={[s.rowMuted, { marginBottom: 8 }]}>By listing city, narrowed to the current filters.</Text>}
        {cities.length === 0 ? <Empty>No city-tagged bookings yet.</Empty> : (
          <>
            <BarsChart bars={cities.slice(0, 6).map((c) => ({ label: c.city, value: c.bookings }))} />
            <View style={{ marginTop: 6 }}>
              {cities.map((c, i) => (
                <Row key={c.city} label={c.city} value={`${fmt(c.bookings)} · ${rupees(c.revenuePaise)}`} divider={i < cities.length - 1} />
              ))}
            </View>
          </>
        )}
      </Card>
    </>
  );
}
