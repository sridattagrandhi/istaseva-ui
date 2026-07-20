// dash/DashInsights.tsx — partner-scoped Insights tab (mirrors the web
// dashboards' InsightsPanel): bookings/cancellations trend with a dashed
// previous-period overlay, tappable KPI tiles that open a breakdown card,
// category extras (stay occupancy/ADR + check-in days, service/transport
// demand heatmap, transport pickup hotspots + trip mix), discovery→booking
// funnel, cancellation reasons, payment failures and category search demand,
// all from /api/providers/me/insights. Everything except search demand is the
// signed-in partner's own data, scoped server-side.
import React, { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Icon } from "../../Icon";
import { T, font } from "../../theme";
import { useInsights } from "../../api/hooks";
import { PairedBarsChart, TrendChart } from "../admin/charts";
import { KpiDelta } from "../admin/adminUi";
import { useLanguage } from "@/contexts/LanguageContext";

const CATEGORY_FOR: Record<string, "stay" | "service" | "transport"> = {
  host: "stay",
  provider: "service",
  transport: "transport",
};

const RANGES: [number, string][] = [[7, "7d"], [30, "30d"], [90, "90d"]];

const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOUR_COLS = ["6a", "8a", "10a", "12p", "2p", "4p", "6p", "8p", "Nt"];
const hourBucket = (hour: number) => (hour < 6 || hour >= 22 ? 8 : Math.floor((hour - 6) / 2));
const MODE_LABELS: Record<string, string> = { cab: "Point-to-point", hourly: "Hourly", day: "Full day", package: "Package" };

/** Label + proportional horizontal bar + count (reasons, failures, terms, funnel). */
function HBars({ rows, empty }: { rows: { label: string; count: number }[]; empty: string }) {
  if (!rows.length) return <Text style={s.empty}>{empty}</Text>;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <View style={{ gap: 8, marginTop: 12 }}>
      {rows.map((r, i) => (
        <View key={`${r.label}-${i}`} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={s.hbLabel} numberOfLines={1}>{r.label.replace(/[_-]+/g, " ")}</Text>
          <View style={s.hbTrack}><View style={[s.hbFill, { width: `${(r.count / max) * 100}%` }]} /></View>
          <Text style={s.hbN}>{r.count}</Text>
        </View>
      ))}
    </View>
  );
}

/** Cell shade for a count against the grid max — shared by cells and the legend key. */
const heatColor = (n: number, max: number) => (n > 0 ? `rgba(58,50,71,${0.15 + 0.85 * (n / max)})` : "rgba(23,22,28,0.05)");

/** Weekday × 2-hour demand grid (night folded into one trailing column). */
function HeatGrid({ rows }: { rows: { dow: number; hour: number | null; count: number }[] }) {
  const { t } = useLanguage();
  const grid: number[][] = Array.from({ length: 7 }, () => Array(9).fill(0));
  for (const r of rows) {
    if (r.hour == null || r.dow < 1 || r.dow > 7) continue;
    grid[r.dow - 1][hourBucket(r.hour)] += r.count;
  }
  const max = Math.max(1, ...grid.flat());
  return (
    <View style={{ marginTop: 12, gap: 3 }}>
      <View style={{ flexDirection: "row", gap: 3 }}>
        <View style={{ width: 30 }} />
        {HOUR_COLS.map((c) => (
          <Text key={c} style={hg.colLbl}>{c}</Text>
        ))}
      </View>
      {grid.map((row, d) => (
        <View key={DOW_SHORT[d]} style={{ flexDirection: "row", gap: 3, alignItems: "center" }}>
          <Text style={hg.rowLbl}>{DOW_SHORT[d]}</Text>
          {row.map((n, c) => (
            <View key={c} style={[hg.cell, { backgroundColor: heatColor(n, max) }]} />
          ))}
        </View>
      ))}
      {/* Color key: same ramp the cells use, from empty to the busiest slot. */}
      <View style={hg.keyRow}>
        <Text style={hg.keyLbl}>{t("m.insights.heatKeyFewer", { defaultValue: "Fewer" })}</Text>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <View key={f} style={[hg.keySwatch, { backgroundColor: heatColor(f * max, max) }]} />
        ))}
        <Text style={hg.keyLbl}>{t("m.insights.heatKeyMore", { defaultValue: "More" })}</Text>
      </View>
    </View>
  );
}

/** Bucket the daily series into ≤10 bars so 90-day ranges stay readable. */
function bucketSeries(series: { day: string; bookings: number; cancelled: number; prev: number }[], nBuckets = 10) {
  if (series.length <= nBuckets) return series.map((r) => ({ label: r.day.slice(5), bookings: r.bookings, cancelled: r.cancelled, prev: r.prev }));
  const per = Math.ceil(series.length / nBuckets);
  const out: { label: string; bookings: number; cancelled: number; prev: number }[] = [];
  for (let i = 0; i < series.length; i += per) {
    const chunk = series.slice(i, i + per);
    out.push({
      label: chunk[0].day.slice(5),
      bookings: chunk.reduce((a, r) => a + r.bookings, 0),
      cancelled: chunk.reduce((a, r) => a + r.cancelled, 0),
      prev: chunk.reduce((a, r) => a + r.prev, 0),
    });
  }
  return out;
}

type KpiKey = "bookings" | "cancel" | "repeat" | "lead";

export function DashInsights({ role }: { role: string }) {
  const { t } = useLanguage();
  const [days, setDays] = useState(30);
  const [detail, setDetail] = useState<KpiKey | null>(null);
  // Compare mode swaps the bars for the line chart with the dashed
  // previous-period overlay — off by default so the first glance is clean.
  const [comparePrev, setComparePrev] = useState(false);
  const category = CATEGORY_FOR[role] ?? "service";
  const { insights, loading, error } = useInsights(category, days);

  const totalBookings = (insights?.series ?? []).reduce((a, r) => a + r.bookings, 0);
  const totalCancelled = (insights?.series ?? []).reduce((a, r) => a + r.cancelled, 0);
  const prevBookings = (insights?.prev?.series ?? []).reduce((a, r) => a + r.bookings, 0);
  const prevCancelled = (insights?.prev?.series ?? []).reduce((a, r) => a + r.cancelled, 0);
  const cancelRate = totalBookings > 0 ? `${((totalCancelled / totalBookings) * 100).toFixed(1)}%` : "—";
  const cancelPct = totalBookings > 0 ? (totalCancelled / totalBookings) * 100 : 0;
  const prevCancelPct = prevBookings > 0 ? (prevCancelled / prevBookings) * 100 : 0;

  // Previous period aligned to the current one by day offset, then bucketed
  // together so the dashed overlay tracks the same x positions.
  const buckets = useMemo(() => {
    const prevByDay = new Map((insights?.prev?.series ?? []).map((r) => [r.day, r]));
    const merged = (insights?.series ?? []).map((r) => ({
      ...r,
      prev: prevByDay.get(new Date(Date.parse(`${r.day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10))?.bookings ?? 0,
    }));
    return bucketSeries(merged);
  }, [insights?.series, insights?.prev?.series, days]);
  const hasPrev = (insights?.prev?.series ?? []).length > 0;

  const funnelTotals = insights?.funnel.totals;
  const hasFunnel = !!funnelTotals && (funnelTotals.views > 0 || funnelTotals.cardClicks > 0 || funnelTotals.modalOpens > 0 || funnelTotals.paymentStarts > 0 || funnelTotals.bookings > 0);
  const funnelRows = funnelTotals
    ? [
        { label: t("m.insights.views", { defaultValue: "Views" }), count: funnelTotals.views },
        { label: t("m.insights.cardClicks", { defaultValue: "Card clicks" }), count: funnelTotals.cardClicks },
        { label: t("m.insights.modalOpens", { defaultValue: "Booking opens" }), count: funnelTotals.modalOpens },
        { label: t("m.insights.paymentStarts", { defaultValue: "Payment starts" }), count: funnelTotals.paymentStarts },
        { label: t("m.insights.bookings", { defaultValue: "Bookings" }), count: funnelTotals.bookings },
      ]
    : [];

  const heatRows = insights?.heatmap ?? [];
  const hasHeat = heatRows.some((r) => r.hour != null && r.count > 0);
  const checkinDays = DOW_SHORT.map((label, i) => ({
    label,
    count: heatRows.filter((r) => r.dow === i + 1).reduce((a, r) => a + r.count, 0),
  }));
  const stay = insights?.stay;
  const occupancyVals = (stay?.series ?? []).map((r) => (stay && stay.rooms > 0 ? Math.round((r.roomNights / stay.rooms) * 1000) / 10 : 0));
  const transport = insights?.transport;

  const kpis: Array<{ key: KpiKey; v: string; l: string; ic: string; bg: string; fg: string; delta?: React.ReactNode }> = [
    {
      key: "bookings",
      v: String(totalBookings), l: t("m.insights.kpiBookings", { defaultValue: "Bookings received" }),
      ic: "calendar", bg: "rgba(139,94,74,0.14)", fg: "#8b5e4a",
      delta: <KpiDelta current={totalBookings} previous={prevBookings} />,
    },
    {
      key: "cancel",
      v: cancelRate, l: t("m.insights.kpiCancelRate", { defaultValue: "Cancellation rate" }),
      ic: "x", bg: "rgba(164,93,98,0.14)", fg: "#a45d62",
      delta: <KpiDelta current={cancelPct} previous={prevCancelPct} invert />,
    },
    {
      key: "repeat",
      v: insights?.repeat.repeatRate != null ? `${insights.repeat.repeatRate}%` : "—",
      l: t("m.insights.kpiRepeatRate", { defaultValue: "Repeat customers" }),
      ic: "users", bg: "rgba(47,125,85,0.12)", fg: "#2f7d55",
      delta:
        insights?.repeat.repeatRate != null && insights?.prev?.repeat.repeatRate != null ? (
          <KpiDelta current={insights.repeat.repeatRate} previous={insights.prev.repeat.repeatRate} />
        ) : undefined,
    },
    {
      key: "lead",
      v: insights?.leadTime.medianDays != null ? t("m.insights.daysCount", { defaultValue: "{{count}} days", count: insights.leadTime.medianDays }) : "—",
      l: t("m.insights.kpiLeadTime", { defaultValue: "Booking lead time" }),
      ic: "clock", bg: "rgba(97,122,146,0.16)", fg: "#617a92",
    },
  ];

  const DETAIL_TITLES: Record<KpiKey, string> = {
    bookings: t("m.insights.detailBookings", { defaultValue: "Bookings by status" }),
    cancel: t("m.insights.detailCancel", { defaultValue: "Top cancellation reasons" }),
    repeat: t("m.insights.detailRepeat", { defaultValue: "Repeat customers" }),
    lead: t("m.insights.detailLead", { defaultValue: "Booking lead time" }),
  };

  return (
    <View style={{ marginTop: 16 }}>
      <Text style={s.secTitle}>{t("m.insights.title", { defaultValue: "Insights" })}</Text>
      <View style={s.rangeRow}>
        {RANGES.map(([k, lb]) => (
          <Pressable key={k} style={[s.rangePill, days === k && s.rangePillActive]} onPress={() => setDays(k)}>
            <Text style={[s.rangePillTxt, days === k && { color: "#fff" }]}>{lb}</Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <Text style={s.empty}>{t("m.insights.loading", { defaultValue: "Loading insights…" })}</Text>
      ) : error || !insights ? (
        <Text style={s.empty}>{t("m.insights.error", { defaultValue: "Couldn't load insights. Please try again." })}</Text>
      ) : (
        <>
          <View style={s.kpiGrid}>
            {kpis.map((k) => (
              <Pressable
                key={k.key}
                onPress={() => setDetail((cur) => (cur === k.key ? null : k.key))}
                style={({ pressed }) => [s.kpi, detail === k.key && s.kpiOn, pressed && detail !== k.key && { opacity: 0.85 }]}
              >
                <View style={[s.kpiIco, { backgroundColor: k.bg }]}><Icon name={k.ic} size={17} color={k.fg} /></View>
                <View style={s.kpiValRow}>
                  <Text style={s.kpiVal}>{k.v}</Text>
                  {k.delta}
                </View>
                <Text style={s.kpiLbl}>{k.l}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.tapHint}>{t("m.insights.tapHint", { defaultValue: "Tap a tile for its breakdown." })}</Text>

          {detail && (
            <View style={s.detailCard}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Text style={s.cardTitle}>{DETAIL_TITLES[detail]}</Text>
                <Pressable onPress={() => setDetail(null)} hitSlop={8}>
                  <Icon name="x" size={16} color={T.muted} />
                </Pressable>
              </View>
              {detail === "bookings" && (
                <>
                  <HBars
                    rows={insights.statusMix.map((r) => ({ label: r.status, count: r.count }))}
                    empty={t("m.insights.noBookings", { defaultValue: "No bookings in this period yet." })}
                  />
                  {insights.prev && (
                    <Text style={s.detailNote}>
                      {t("m.insights.prevBookingsNote", { defaultValue: "Previous period: {{count}} bookings", count: prevBookings })}
                    </Text>
                  )}
                </>
              )}
              {detail === "cancel" && (
                <>
                  <HBars
                    rows={insights.cancelReasons.slice(0, 5).map((r) => ({ label: r.reason, count: r.count }))}
                    empty={t("m.insights.noCancels", { defaultValue: "No cancellations in this period." })}
                  />
                  {insights.prev && prevBookings > 0 && (
                    <Text style={s.detailNote}>
                      {t("m.insights.prevCancelNote", { defaultValue: "Previous period cancellation rate: {{rate}}%", rate: prevCancelPct.toFixed(1) })}
                    </Text>
                  )}
                </>
              )}
              {detail === "repeat" && (
                <View style={{ marginTop: 10, gap: 6 }}>
                  <Text style={s.detailBody}>
                    {t("m.insights.repeatDetail", { defaultValue: "{{repeat}} of {{total}} customers booked with you more than once in this period.", repeat: insights.repeat.repeatBookers, total: insights.repeat.bookers })}
                  </Text>
                  {insights.repeat.medianDaysToSecond != null && (
                    <Text style={s.detailNote}>
                      {t("m.insights.repeatGap", { defaultValue: "Typical gap between first and second booking: ~{{days}} days.", days: insights.repeat.medianDaysToSecond })}
                    </Text>
                  )}
                  {insights.prev?.repeat.repeatRate != null && (
                    <Text style={s.detailNote}>
                      {t("m.insights.prevRepeatNote", { defaultValue: "Previous period repeat rate: {{rate}}%", rate: insights.prev.repeat.repeatRate })}
                    </Text>
                  )}
                </View>
              )}
              {detail === "lead" && (
                <View style={{ marginTop: 10, gap: 6 }}>
                  <Text style={s.detailBody}>
                    {t("m.insights.leadDetail", { defaultValue: "Median {{median}} days · average {{avg}} days booked in advance.", median: insights.leadTime.medianDays ?? "—", avg: insights.leadTime.avgDays ?? "—" })}
                  </Text>
                  {insights.prev?.leadTime.medianDays != null && (
                    <Text style={s.detailNote}>
                      {t("m.insights.prevLeadNote", { defaultValue: "Previous period median: {{days}} days", days: insights.prev.leadTime.medianDays })}
                    </Text>
                  )}
                  <Text style={s.detailNote}>
                    {t("m.insights.leadHint", { defaultValue: "Longer lead times mean customers plan ahead — keep your calendar open further out to capture them." })}
                  </Text>
                </View>
              )}
            </View>
          )}

          <View style={s.card}>
            <Text style={s.cardTitle}>{t("m.insights.bookingsOverTime", { defaultValue: "Bookings over time" })}</Text>
            <Text style={s.cardSub}>
              {comparePrev
                ? t("m.insights.bookingsOverTimeSubPrev", { defaultValue: "Bookings and cancellations — dashed line is the previous period" })
                : t("m.insights.bookingsOverTimeSub", { defaultValue: "Bookings received per day, with cancellations" })}
            </Text>
            {buckets.length ? (
              <View style={{ marginTop: 10 }}>
                {comparePrev ? (
                  <TrendChart
                    values={buckets.map((b) => b.bookings)}
                    values2={buckets.map((b) => b.cancelled)}
                    prevValues={buckets.map((b) => b.prev)}
                    color={T.aubergine}
                    color2={T.coral}
                    height={130}
                  />
                ) : (
                  <PairedBarsChart
                    groups={buckets.map((b) => ({ label: b.label, values: [b.bookings, b.cancelled] as [number, number] }))}
                    colors={[T.aubergine, T.coral]}
                    height={130}
                  />
                )}
                <View style={s.legendRow}>
                  <View style={[s.legendDot, { backgroundColor: T.aubergine }]} />
                  <Text style={s.legendLbl}>{t("m.insights.bookings", { defaultValue: "Bookings" })}</Text>
                  <View style={[s.legendDot, { backgroundColor: T.coral }]} />
                  <Text style={s.legendLbl}>{t("m.insights.cancelled", { defaultValue: "Cancelled" })}</Text>
                  {comparePrev && (
                    <>
                      <View style={s.legendDash} />
                      <Text style={s.legendLbl}>{t("m.insights.prevPeriod", { defaultValue: "Previous period" })}</Text>
                    </>
                  )}
                  {hasPrev && (
                    <Pressable
                      onPress={() => setComparePrev((v) => !v)}
                      style={[s.comparePill, comparePrev && s.comparePillOn]}
                      hitSlop={6}
                    >
                      <Text style={[s.comparePillTxt, comparePrev && { color: "#fff" }]}>
                        {t("m.insights.comparePrev", { defaultValue: "vs previous" })}
                      </Text>
                    </Pressable>
                  )}
                </View>
              </View>
            ) : (
              <Text style={s.empty}>{t("m.insights.noBookings", { defaultValue: "No bookings in this period yet." })}</Text>
            )}
          </View>

          {category === "stay" && stay && (
            <>
              <View style={s.card}>
                <Text style={s.cardTitle}>{t("m.insights.occupancy", { defaultValue: "Occupancy & nightly rate" })}</Text>
                <Text style={s.cardSub}>{t("m.insights.occupancySub", { defaultValue: "{{rooms}} sellable rooms across your listings", rooms: stay.rooms })}</Text>
                {stay.rooms === 0 ? (
                  <Text style={s.empty}>{t("m.insights.occupancyNoRooms", { defaultValue: "Add room types to your listings to see occupancy." })}</Text>
                ) : (
                  <>
                    <View style={{ flexDirection: "row", gap: 24, marginTop: 10 }}>
                      <View>
                        <Text style={s.statLbl}>{t("m.insights.occupancyRate", { defaultValue: "Occupancy" })}</Text>
                        <View style={s.statValRow}>
                          <Text style={s.statVal}>{stay.totals.occupancyPct != null ? `${stay.totals.occupancyPct}%` : "—"}</Text>
                          {stay.totals.occupancyPct != null && stay.prevTotals.occupancyPct != null && (
                            <KpiDelta current={stay.totals.occupancyPct} previous={stay.prevTotals.occupancyPct} />
                          )}
                        </View>
                      </View>
                      <View>
                        <Text style={s.statLbl}>{t("m.insights.adr", { defaultValue: "Avg nightly rate" })}</Text>
                        <View style={s.statValRow}>
                          <Text style={s.statVal}>{stay.totals.adrPaise != null ? `₹${Math.round(stay.totals.adrPaise / 100).toLocaleString("en-IN")}` : "—"}</Text>
                          {stay.totals.adrPaise != null && stay.prevTotals.adrPaise != null && (
                            <KpiDelta current={stay.totals.adrPaise} previous={stay.prevTotals.adrPaise} />
                          )}
                        </View>
                      </View>
                    </View>
                    {occupancyVals.length > 0 && (
                      <View style={{ marginTop: 10 }}>
                        <TrendChart values={occupancyVals} color="#2f7d55" height={110} />
                      </View>
                    )}
                  </>
                )}
              </View>
              <View style={s.card}>
                <Text style={s.cardTitle}>{t("m.insights.checkinDays", { defaultValue: "Check-in days" })}</Text>
                <Text style={s.cardSub}>{t("m.insights.checkinDaysSub", { defaultValue: "Which weekdays your stays begin on" })}</Text>
                <HBars rows={checkinDays} empty={t("m.insights.noBookings", { defaultValue: "No bookings in this period yet." })} />
              </View>
            </>
          )}

          {category !== "stay" && (
            <View style={s.card}>
              <Text style={s.cardTitle}>{t("m.insights.heatmap", { defaultValue: "When demand lands" })}</Text>
              <Text style={s.cardSub}>{t("m.insights.heatmapSub", { defaultValue: "Booked slots by weekday and hour — use it to set your working hours" })}</Text>
              {hasHeat ? (
                <HeatGrid rows={heatRows} />
              ) : (
                <Text style={s.empty}>{t("m.insights.heatmapEmpty", { defaultValue: "No scheduled bookings in this period yet." })}</Text>
              )}
            </View>
          )}

          {category === "transport" && transport && (
            <View style={s.card}>
              <Text style={s.cardTitle}>{t("m.insights.tripDemand", { defaultValue: "Where trips start" })}</Text>
              <Text style={s.cardSub}>{t("m.insights.tripDemandSub", { defaultValue: "Your top pickup areas and trip types" })}</Text>
              <HBars
                rows={transport.pickups.map((p) => ({ label: p.label, count: p.count }))}
                empty={t("m.insights.noPickups", { defaultValue: "No pickup locations recorded in this period." })}
              />
              {transport.modes.length > 0 && (
                <>
                  <Text style={[s.bySection, { marginTop: 14 }]}>{t("m.insights.tripMix", { defaultValue: "Trip mix" })}</Text>
                  <HBars rows={transport.modes.map((m) => ({ label: MODE_LABELS[m.mode] ?? m.mode, count: m.count }))} empty="" />
                </>
              )}
            </View>
          )}

          <View style={s.card}>
            <Text style={s.cardTitle}>{t("m.insights.funnel", { defaultValue: "Discovery → booking funnel" })}</Text>
            <Text style={s.cardSub}>{t("m.insights.funnelSub", { defaultValue: "How customers move from seeing your listings to booking" })}</Text>
            {hasFunnel ? (
              <>
                <HBars rows={funnelRows} empty="" />
                {insights.funnel.byListing.length > 1 && (
                  <View style={{ marginTop: 14, gap: 8 }}>
                    <Text style={s.bySection}>{t("m.insights.byListing", { defaultValue: "By listing" })}</Text>
                    {insights.funnel.byListing.map((l) => (
                      <View key={l.listingId} style={s.byRow}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={s.byName} numberOfLines={1}>{l.name}</Text>
                          <Text style={s.byCount}>
                            {t("m.insights.byListingMeta", { defaultValue: "{{views}} views · {{opens}} opens", views: l.views, opens: l.modalOpens })}
                          </Text>
                        </View>
                        <Text style={s.byTotal}>{l.bookings}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </>
            ) : (
              <Text style={s.empty}>{t("m.insights.funnelEmpty", { defaultValue: "No funnel data for this period yet — views and clicks are counted from listing activity." })}</Text>
            )}
          </View>

          <View style={s.card}>
            <Text style={s.cardTitle}>{t("m.insights.cancelReasons", { defaultValue: "Cancellation reasons" })}</Text>
            <HBars
              rows={insights.cancelReasons.map((r) => ({ label: r.reason, count: r.count }))}
              empty={t("m.insights.noCancels", { defaultValue: "No cancellations in this period." })}
            />
          </View>

          <View style={s.card}>
            <Text style={s.cardTitle}>{t("m.insights.paymentFailures", { defaultValue: "Payment failures" })}</Text>
            <HBars
              rows={insights.paymentFailures.map((r) => ({ label: r.reason, count: r.count }))}
              empty={t("m.insights.noFailures", { defaultValue: "No failed payments in this period." })}
            />
          </View>

          <View style={s.card}>
            <Text style={s.cardTitle}>{t("m.insights.searchDemand", { defaultValue: "What customers search for" })}</Text>
            <Text style={s.cardSub}>
              {insights.searchDemandScope === "niche"
                ? t("m.insights.searchDemandNicheSub", { defaultValue: "Marketplace searches matching your listings" })
                : t("m.insights.searchDemandSub", { defaultValue: "Top searches in your category across the marketplace" })}
            </Text>
            <HBars
              rows={insights.searchDemand.map((r) => ({ label: r.term, count: r.count }))}
              empty={t("m.insights.noSearches", { defaultValue: "No search data in this period." })}
            />
            {(insights.searchPlaces ?? []).length > 0 && (
              <>
                <Text style={[s.bySection, { marginTop: 14 }]}>{t("m.insights.searchPlaces", { defaultValue: "Where customers are searching" })}</Text>
                <Text style={s.cardSub}>{t("m.insights.searchPlacesSub", { defaultValue: "Searches in the places you operate" })}</Text>
                <HBars
                  rows={(insights.searchPlaces ?? []).map((r) => ({ label: r.region, count: r.count }))}
                  empty=""
                />
              </>
            )}
          </View>
        </>
      )}
    </View>
  );
}

const hg = StyleSheet.create({
  colLbl: { flex: 1, textAlign: "center", fontSize: 8.5, color: T.muted, fontFamily: font.body },
  rowLbl: { width: 30, fontSize: 10, color: T.muted, fontFamily: font.body },
  cell: { flex: 1, height: 20, borderRadius: 4 },
  keyRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, marginTop: 8 },
  keyLbl: { fontSize: 9.5, color: T.muted, fontFamily: font.body },
  keySwatch: { width: 12, height: 12, borderRadius: 3 },
});

const s = StyleSheet.create({
  secTitle: { fontSize: 16, fontFamily: font.headHeavy, color: T.ink, marginBottom: 12 },
  rangeRow: { flexDirection: "row", gap: 6, marginBottom: 12 },
  rangePill: { flex: 1, paddingVertical: 8, borderRadius: 999, alignItems: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.56)" },
  rangePillActive: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  rangePillTxt: { fontSize: 12, fontFamily: font.bodyBold, color: T.aubergine },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  kpi: { width: "47%", flexGrow: 1, padding: 14, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.85)" },
  kpiOn: { borderColor: T.aubergine, borderWidth: 1.5 },
  kpiIco: { width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center", marginBottom: 10 },
  kpiValRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 6 },
  kpiVal: { fontSize: 21, fontFamily: font.head, color: T.ink, flexShrink: 1 },
  kpiLbl: { fontSize: 11.5, color: T.muted, marginTop: 2, fontFamily: font.body },
  tapHint: { fontSize: 11, color: T.muted, fontFamily: font.body, marginTop: 8, textAlign: "right" },
  detailCard: { padding: 16, borderRadius: 18, borderWidth: 1.5, borderColor: "rgba(58,50,71,0.25)", backgroundColor: "rgba(255,255,255,0.92)", marginTop: 10 },
  detailBody: { fontSize: 13, color: T.ink, fontFamily: font.body, lineHeight: 19 },
  detailNote: { fontSize: 11.5, color: T.muted, fontFamily: font.body, marginTop: 8 },
  card: { padding: 16, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.85)", marginTop: 16 },
  legendRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 10 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendDash: { width: 12, height: 0, borderTopWidth: 1.5, borderColor: T.muted, borderStyle: "dashed" },
  legendLbl: { fontSize: 11, color: T.muted, fontFamily: font.body, marginRight: 6 },
  comparePill: { marginLeft: "auto", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: "rgba(58,50,71,0.3)" },
  comparePillOn: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  comparePillTxt: { fontSize: 10.5, fontFamily: font.bodyBold, color: T.aubergine },
  cardTitle: { fontSize: 14, fontFamily: font.head, color: T.ink },
  cardSub: { fontSize: 11.5, color: T.muted, marginTop: 2, fontFamily: font.body },
  statLbl: { fontSize: 10.5, color: T.muted, fontFamily: font.body, textTransform: "uppercase", letterSpacing: 0.4 },
  statValRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 },
  statVal: { fontSize: 19, fontFamily: font.head, color: T.ink },
  empty: { color: T.muted, fontSize: 13, textAlign: "center", paddingVertical: 20, fontFamily: font.body },
  hbLabel: { width: 110, fontSize: 11.5, color: T.muted, fontFamily: font.body, textTransform: "capitalize" },
  hbTrack: { flex: 1, height: 7, borderRadius: 999, backgroundColor: T.line, overflow: "hidden" },
  hbFill: { height: "100%", borderRadius: 999, backgroundColor: T.terra },
  hbN: { width: 30, textAlign: "right", fontSize: 12, color: T.ink, fontFamily: font.bodyBold },
  bySection: { fontSize: 11, fontFamily: font.bodyHeavy, color: T.muted, textTransform: "uppercase", letterSpacing: 0.4 },
  byRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 12, backgroundColor: "rgba(23,22,28,0.03)" },
  byName: { fontSize: 13, fontFamily: font.bodyBold, color: T.ink },
  byCount: { fontSize: 11, color: T.muted, fontFamily: font.body },
  byTotal: { fontSize: 14, fontFamily: font.bodyHeavy, color: "#2f7d55" },
});
