// dash/dashPanels.tsx — Earnings + Reviews panels (ported from dash-manage.jsx) and shared bits.
import React, { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, Modal, ScrollView, TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient as SvgGradient, Path, Stop } from "react-native-svg";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../../Icon";
import { T, font } from "../../theme";
import { DashRole } from "./dashData";
import { ROLE_TYPE, useEarnings, useMyListings } from "../../api/hooks";
import { fetchMyPayouts, fetchPayoutAccount, savePayoutAccount, type EarningsPoint } from "../../api/dash";
import { DateRangeSheet } from "../DateRangeSheet";
import { useLanguage } from "@/contexts/LanguageContext";

export const rupee = (n: number) => "₹" + Number(n).toLocaleString("en-IN");
export const TONE_BG: Record<string, string> = { saffron: "rgba(189,135,82,0.16)", blue: "rgba(97,122,146,0.16)", coral: "rgba(164,93,98,0.16)", aubergine: "rgba(58,50,71,0.12)" };
export const TONE_FG: Record<string, string> = { saffron: "#8b5e4a", blue: "#617a92", coral: "#a45d62", aubergine: "#3a3247" };

const CHIP: Record<string, { label: string; bg: string; fg: string }> = {
  pending: { label: "Pending", bg: "rgba(189,135,82,0.14)", fg: "#8b5e4a" },
  upcoming: { label: "Upcoming", bg: "rgba(139,94,74,0.1)", fg: T.terra },
  confirmed: { label: "Active", bg: "rgba(47,125,85,0.1)", fg: "#2f7d55" },
  completed: { label: "Completed", bg: "rgba(58,50,71,0.08)", fg: T.muted },
  cancelled: { label: "Cancelled", bg: "rgba(164,93,98,0.12)", fg: T.coral },
};
export function StatusChip({ status, label }: { status: string; label?: string }) {
  const { t } = useLanguage();
  const c = CHIP[status] || CHIP.completed;
  const fallback = (CHIP[status] || CHIP.completed).label;
  const text = label || t(`m.dashpanels.status.${status}`, { defaultValue: fallback });
  return <View style={[s.chip, { backgroundColor: c.bg }]}><Text style={[s.chipTxt, { color: c.fg }]}>{text}</Text></View>;
}

/**
 * Dated earnings line — one series, date on the x-axis, ₹ per bucket on the
 * y-axis (stock-chart style: gradient area under the line, sparse date
 * labels). Mirrors the web EarningsTrendCard so both platforms read the same.
 */
export function EarningsChart({ series }: { series: EarningsPoint[] }) {
  const [w, setW] = useState(0);
  const H = 150, TOP = 12, BOTTOM = 6;
  const n = series.length;
  const max = Math.max(...series.map((p) => p.earnings), 1);
  const plotH = H - TOP - BOTTOM;
  const x = (i: number) => (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number) => TOP + (1 - v / max) * plotH;
  const line = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.earnings).toFixed(1)}`).join(" ");
  const area = `${line} L${w.toFixed(1)},${H} L0,${H} Z`;
  // ≤4 evenly spread date labels — a full axis would be unreadable at 30–90 points.
  const tickIdx = n <= 4
    ? series.map((_, i) => i)
    : [...new Set([0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1])];
  return (
    <View style={{ marginTop: 14 }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {w > 0 && n > 0 && (
        <View>
          <Svg width={w} height={H}>
            <Defs>
              <SvgGradient id="earnLineFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={T.gradFrom} stopOpacity={0.26} />
                <Stop offset="1" stopColor={T.gradFrom} stopOpacity={0.02} />
              </SvgGradient>
            </Defs>
            <Path d={area} fill="url(#earnLineFill)" />
            <Path d={line} stroke={T.gradFrom} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          </Svg>
          {/* y-scale hint: the chart's peak bucket */}
          <Text style={s.chartMax}>{rupee(max)}</Text>
        </View>
      )}
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
        {tickIdx.map((i) => <Text key={i} style={s.barLbl}>{series[i]?.label ?? ""}</Text>)}
      </View>
    </View>
  );
}

/* ---------------- earnings model ---------------- */
const E_NOUN: Record<string, { unit: string; units: string; by: string }> = {
  host: { unit: "stay", units: "stays", by: "By property" },
  provider: { unit: "job", units: "jobs", by: "By service" },
  transport: { unit: "trip", units: "trips", by: "By vehicle" },
};
const pad2 = (n: number) => String(n).padStart(2, "0");
const isoD = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
// Financial year start (April). A date in Jan–Mar belongs to the prior FY.
const fyOf = (d: Date) => (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1);

/** Map a range pill (+ FY year / custom window) to the backend's date-window params. */
function earningsWindow(range: string, fyYear: number, custom: { from: string; to: string } | null): { range?: string; from?: string; to?: string } {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const to = isoD(today);
  if (range === "custom" && custom) return { from: custom.from, to: custom.to };
  if (range === "all") return { range: "all", to };
  if (range === "fy") {
    const start = new Date(fyYear, 3, 1);          // Apr 1
    const end = new Date(fyYear + 1, 2, 31);       // Mar 31
    return { from: isoD(start), to: isoD(end > today ? today : end) };
  }
  const f = new Date(today);
  if (range === "week") f.setDate(f.getDate() - 6);
  else if (range === "month") f.setDate(f.getDate() - 29);
  else f.setDate(f.getDate() - 364);               // year
  return { from: isoD(f), to };
}

const RANGES: [string, string][] = [["week", "Week"], ["month", "Month"], ["year", "Year"], ["fy", "FY"], ["all", "All"]];

/** "12 Mar – 4 Apr 2026" (year only on `from` when the ends differ). */
function customRangeLabel(r: { from: string; to: string }): string {
  const f = new Date(`${r.from}T00:00:00`);
  const t = new Date(`${r.to}T00:00:00`);
  const short: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const fs = f.toLocaleDateString("en-IN", f.getFullYear() === t.getFullYear() ? short : { ...short, year: "numeric" });
  return `${fs} – ${t.toLocaleDateString("en-IN", { ...short, year: "numeric" })}`;
}

export function DashEarnings({ role, onOpenPayouts }: { role: string; onOpenPayouts?: () => void }) {
  const { t } = useLanguage();
  const [range, setRange] = useState("month");
  const [listingF, setListingF] = useState("all"); // "all" | listing apiId
  const CURRENT_FY = fyOf(new Date());
  const [fyYear, setFyYear] = useState(CURRENT_FY);
  // Exact [from, to] window for the Custom pill (inclusive, YYYY-MM-DD).
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const { listings } = useMyListings(role);
  const listingId = listingF === "all" ? undefined : listingF;
  // Scoped to this dashboard's vertical — a cab+salon owner's provider
  // Earnings tab must not include cab money (and vice versa).
  const { earnings } = useEarnings({ ...earningsWindow(range, fyYear, custom), listingId, type: ROLE_TYPE[role] });

  // "All properties" + every listing the host owns (real ids), so the whole
  // earnings view can be scoped to one property. Shown only when >1 listing.
  const listingOptions = [
    { value: "all", label: t("m.dashpanels.allListings", { defaultValue: "All listings" }) },
    ...listings.map((l) => ({ value: l.apiId, label: l.name })),
  ];

  const baseNoun = E_NOUN[role] || E_NOUN.host;
  const nounKey = E_NOUN[role] ? role : "host";
  const noun = {
    unit: t(`m.dashpanels.noun.${nounKey}.unit`, { defaultValue: baseNoun.unit }),
    units: t(`m.dashpanels.noun.${nounKey}.units`, { defaultValue: baseNoun.units }),
    by: t(`m.dashpanels.noun.${nounKey}.by`, { defaultValue: baseNoun.by }),
  };

  const total = earnings?.totalRupees ?? 0;
  const count = earnings?.bookings ?? 0;
  const avgPer = count ? Math.round(total / count) : 0;
  const allTime = earnings?.allTime ?? 0;
  const commission = earnings?.commissionRupees ?? 0;
  const net = earnings?.netRupees ?? total;
  const refunds = earnings?.refundsRupees ?? 0;
  const discounts = earnings?.discountsRupees ?? 0;
  const series = earnings?.series ?? [];
  const byListing = earnings?.byListing ?? [];
  const rangeLbl = range === "custom" && custom
    ? customRangeLabel(custom)
    : t(`m.dashpanels.range.${range}`, { defaultValue: (RANGES.find(([k]) => k === range) || ["", ""])[1] });
  const fyLabel = `FY ${String(fyYear).slice(2)}-${String(fyYear + 1).slice(2)}`;
  // Backend series buckets daily up to ~4 months, monthly beyond — label the
  // breakdown card to match.
  const customSpanDays = custom ? Math.round((Date.parse(custom.to) - Date.parse(custom.from)) / 86400000) + 1 : 0;
  const breakdownTitle = range === "week" || range === "month" || (range === "custom" && customSpanDays <= 120)
    ? t("m.dashpanels.dailyBreakdown", { defaultValue: "Daily breakdown" })
    : range === "fy"
      ? t("m.dashpanels.fyBreakdown", { defaultValue: "{{label}} breakdown", label: fyLabel })
      : t("m.dashpanels.monthlyBreakdown", { defaultValue: "Monthly breakdown" });
  // When the range carries platform commission (admin business fee rules,
  // snapshotted per booking), swap the derived "avg/unit" tile for the two
  // numbers a partner actually asks about: commission taken and net payout.
  // Zero-commission partners keep the original four tiles unchanged.
  const kpis = commission > 0
    ? [
        { v: rupee(total), l: t("m.dashpanels.kpiRangeEarnings", { defaultValue: "{{range}} earnings", range: rangeLbl }), ic: "wallet", bg: "rgba(47,125,85,0.12)", fg: "#2f7d55" },
        { v: `−${rupee(commission)}`, l: t("m.dashpanels.kpiCommission", { defaultValue: "Platform commission" }), ic: "card", bg: "rgba(176,101,54,0.14)", fg: "#b06536" },
        { v: rupee(net), l: t("m.dashpanels.kpiNet", { defaultValue: "Net payout" }), ic: "chart", bg: "rgba(47,125,85,0.18)", fg: "#2f7d55" },
        { v: rupee(allTime), l: t("m.dashpanels.kpiAllTime", { defaultValue: "All-time" }), ic: "card", bg: "rgba(23,22,28,0.06)", fg: T.ink },
      ]
    : [
        { v: rupee(total), l: t("m.dashpanels.kpiRangeEarnings", { defaultValue: "{{range}} earnings", range: rangeLbl }), ic: "wallet", bg: "rgba(47,125,85,0.12)", fg: "#2f7d55" },
        { v: String(count), l: t("m.dashpanels.kpiCompleted", { defaultValue: "Completed {{units}}", units: noun.units }), ic: "calendar", bg: "rgba(139,94,74,0.14)", fg: "#8b5e4a" },
        { v: rupee(avgPer), l: t("m.dashpanels.kpiAvgPer", { defaultValue: "Avg / {{unit}}", unit: noun.unit }), ic: "chart", bg: "rgba(97,122,146,0.16)", fg: "#617a92" },
        { v: rupee(allTime), l: t("m.dashpanels.kpiAllTime", { defaultValue: "All-time" }), ic: "card", bg: "rgba(23,22,28,0.06)", fg: T.ink },
      ];
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={s.secTitle}>{t("m.dashpanels.earnings", { defaultValue: "Earnings" })}</Text>
      {listings.length > 1 && (
        <View style={{ marginBottom: 12, zIndex: 60 }}>
          <DashSelect value={listingF} onChange={setListingF} options={listingOptions} />
        </View>
      )}
      <View style={s.rangeRow}>
        {RANGES.map(([k, lb]) => (
          <Pressable key={k} style={[s.rangePill, range === k && s.rangePillActive]} onPress={() => setRange(k)}>
            <Text style={[s.rangePillTxt, range === k && { color: "#fff" }]}>{t(`m.dashpanels.range.${k}`, { defaultValue: lb })}</Text>
          </Pressable>
        ))}
        <Pressable style={[s.rangePill, range === "custom" && s.rangePillActive]} onPress={() => setCustomOpen(true)}>
          <Icon name="calendar" size={13} color={range === "custom" ? "#fff" : T.aubergine} />
        </Pressable>
      </View>
      {range === "custom" && custom && (
        <Pressable style={s.fyNav} onPress={() => setCustomOpen(true)}>
          <Icon name="calendar" size={14} color={T.muted} />
          <Text style={s.fyLabel}>{customRangeLabel(custom)}</Text>
          <Icon name="chevD" size={14} color={T.muted} />
        </Pressable>
      )}
      <DateRangeSheet
        visible={customOpen}
        value={{ start: custom?.from ?? null, end: custom?.to ?? null }}
        title={t("m.dashpanels.customRangeTitle", { defaultValue: "Custom date range" })}
        minDate={null}
        maxDate={isoD(new Date())}
        onApply={(r) => {
          setCustomOpen(false);
          if (r.start) {
            const from = r.start, to = r.end ?? r.start;
            setCustom(from <= to ? { from, to } : { from: to, to: from });
            setRange("custom");
          }
        }}
        onClose={() => setCustomOpen(false)}
      />
      {range === "fy" && (
        <View style={s.fyNav}>
          <Pressable onPress={() => setFyYear((y) => y - 1)}><Icon name="chevL" size={15} color={T.muted} /></Pressable>
          <Text style={s.fyLabel}>{fyLabel}</Text>
          <Pressable disabled={fyYear >= CURRENT_FY} onPress={() => setFyYear((y) => Math.min(y + 1, CURRENT_FY))}><Icon name="chevR" size={15} color={fyYear >= CURRENT_FY ? "rgba(104,112,122,0.3)" : T.muted} /></Pressable>
        </View>
      )}
      <View style={s.kpiGrid}>
        {kpis.map((k, i) => (
          <View key={i} style={s.kpi}>
            <View style={[s.kpiIco, { backgroundColor: k.bg }]}><Icon name={k.ic} size={17} color={k.fg} /></View>
            <Text style={s.kpiVal}>{k.v}</Text>
            <Text style={s.kpiLbl}>{k.l}</Text>
          </View>
        ))}
      </View>
      <View style={s.earnCard}>
        <Text style={s.cardTitle}>{breakdownTitle}</Text>
        {series.some((p) => p.earnings > 0) ? <EarningsChart series={series} /> : <Text style={s.empty}>{t("m.dashpanels.noEarnings", { defaultValue: "No earnings in this range yet." })}</Text>}
      </View>
      {/* Period statement: how gross becomes net. Amounts owed / paid out are
          tracked by the payouts section — this is the range reconciliation. */}
      <View style={[s.earnCard, { marginTop: 14 }]}>
        <Text style={s.cardTitle}>{t("m.dashpanels.statementTitle", { defaultValue: "Statement — {{range}}", range: rangeLbl })}</Text>
        <View style={{ marginTop: 8 }}>
          {[
            { l: t("m.dashpanels.stGross", { defaultValue: "Gross earnings" }), v: rupee(total) },
            { l: t("m.dashpanels.stRefunds", { defaultValue: "Refunds issued" }), v: `−${rupee(refunds)}` },
            { l: t("m.dashpanels.stCommission", { defaultValue: "Platform commission" }), v: `−${rupee(commission)}` },
            { l: t("m.dashpanels.stNet", { defaultValue: "Net earnings" }), v: rupee(total - refunds - commission), strong: true },
          ].map((row, i) => (
            <View key={row.l} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 7, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: "rgba(23,22,28,0.06)" }}>
              <Text style={row.strong ? s.byName : s.byCount}>{row.l}</Text>
              <Text style={[s.byName, { fontSize: 13 }]}>{row.v}</Text>
            </View>
          ))}
        </View>
        {discounts > 0 && (
          <Text style={[s.byCount, { marginTop: 6 }]}>
            {t("m.dashpanels.stDiscounts", { defaultValue: "Includes ₹{{amount}} in discounts you funded, already reflected in gross.", amount: Math.round(discounts).toLocaleString("en-IN") })}
          </Text>
        )}
      </View>
      {listingF === "all" && (
        <View style={[s.earnCard, { marginTop: 14 }]}>
          <Text style={s.cardTitle}>{noun.by}</Text>
          <View style={{ gap: 8, marginTop: 12 }}>
            {byListing.length ? byListing.map((p) => (
              <View key={p.listingId} style={s.byRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.byName} numberOfLines={1}>{p.name}</Text>
                  <Text style={s.byCount}>{p.bookings} {p.bookings === 1 ? noun.unit : noun.units}</Text>
                </View>
                <Text style={s.byTotal}>{rupee(p.earnings)}</Text>
              </View>
            )) : <Text style={s.empty}>{t("m.dashpanels.noCompleted", { defaultValue: "No completed {{units}} in this range.", units: noun.units })}</Text>}
          </View>
        </View>
      )}
      {/* The payouts management surface lives in its own tab; Earnings keeps
          just the balance tile so the number is findable where people look. */}
      {onOpenPayouts && <AwaitingPayoutTile onOpen={onOpenPayouts} />}
    </View>
  );
}

/* ---------------- payouts (status + payout account) ---------------- */

/** Compact "Awaiting payout ₹X → View payouts" tile for the Earnings tab. */
export function AwaitingPayoutTile({ onOpen }: { onOpen: () => void }) {
  const { t } = useLanguage();
  const q = useQuery({ queryKey: ["my-payouts"], queryFn: () => fetchMyPayouts(1), staleTime: 30_000, retry: 1 });
  return (
    <Pressable style={po.linkTile} onPress={onOpen}>
      <View style={{ flex: 1 }}>
        <Text style={po.tileLbl}>{t("m.dashpanels.payoutPending", { defaultValue: "Awaiting payout" })}</Text>
        <Text style={po.tileVal}>{q.data ? rupee(q.data.pendingPaise / 100) : "—"}</Text>
      </View>
      <Text style={po.linkTxt}>{t("m.dashpanels.payoutView", { defaultValue: "View payouts" })}</Text>
      <Icon name="chevR" size={15} color={T.terra} />
    </Pressable>
  );
}

/**
 * Dashboard-overview nudge: shown only while the partner has NO payout
 * account, so they learn they must link one without opening the tab.
 */
export function PayoutNudge({ onOpen }: { onOpen: () => void }) {
  const { t } = useLanguage();
  const q = useQuery({ queryKey: ["my-payouts"], queryFn: () => fetchMyPayouts(1), staleTime: 30_000, retry: 1 });
  if (!q.data || q.data.hasAccount) return null;
  return (
    <Pressable style={po.nudge} onPress={onOpen}>
      <View style={po.nudgeIco}><Icon name="card" size={16} color="#8a5a18" /></View>
      <View style={{ flex: 1 }}>
        <Text style={po.nudgeTitle}>{t("m.dashpanels.payoutNudgeTitle", { defaultValue: "Add a payout account to get paid" })}</Text>
        <Text style={po.nudgeBody}>{t("m.dashpanels.payoutNudgeBody", { defaultValue: "Link a bank account or UPI ID so we know where to send your earnings." })}</Text>
      </View>
      <Icon name="chevR" size={16} color={T.muted} />
    </Pressable>
  );
}

/**
 * Filtered earnings statement for the Payment settings tab — mirrors the web
 * Payment settings surface: the same range pills + custom date range + FY
 * stepper (+ per-listing filter) the Earnings tab uses, driving a
 * gross → refunds → commission → net reconciliation for the chosen window.
 */
function PayoutStatement({ role }: { role: string }) {
  const { t } = useLanguage();
  const [range, setRange] = useState("month");
  const [listingF, setListingF] = useState("all");
  const CURRENT_FY = fyOf(new Date());
  const [fyYear, setFyYear] = useState(CURRENT_FY);
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const { listings } = useMyListings(role);
  const listingId = listingF === "all" ? undefined : listingF;
  const { earnings } = useEarnings({ ...earningsWindow(range, fyYear, custom), listingId, type: ROLE_TYPE[role] });

  const listingOptions = [
    { value: "all", label: t("m.dashpanels.allListings", { defaultValue: "All listings" }) },
    ...listings.map((l) => ({ value: l.apiId, label: l.name })),
  ];

  const total = earnings?.totalRupees ?? 0;
  const commission = earnings?.commissionRupees ?? 0;
  const refunds = earnings?.refundsRupees ?? 0;
  const discounts = earnings?.discountsRupees ?? 0;
  const fyLabel = `FY ${String(fyYear).slice(2)}-${String(fyYear + 1).slice(2)}`;
  const rangeLbl = range === "custom" && custom
    ? customRangeLabel(custom)
    : t(`m.dashpanels.range.${range}`, { defaultValue: (RANGES.find(([k]) => k === range) || ["", ""])[1] });

  return (
    <View>
      <Text style={s.cardTitle}>{t("m.dashpanels.statementTitle", { defaultValue: "Statement — {{range}}", range: rangeLbl })}</Text>
      {listings.length > 1 && (
        <View style={{ marginTop: 10, zIndex: 60 }}>
          <DashSelect value={listingF} onChange={setListingF} options={listingOptions} />
        </View>
      )}
      <View style={[s.rangeRow, { marginTop: 10, marginBottom: 0 }]}>
        {RANGES.map(([k, lb]) => (
          <Pressable key={k} style={[s.rangePill, range === k && s.rangePillActive]} onPress={() => setRange(k)}>
            <Text style={[s.rangePillTxt, range === k && { color: "#fff" }]}>{t(`m.dashpanels.range.${k}`, { defaultValue: lb })}</Text>
          </Pressable>
        ))}
        <Pressable style={[s.rangePill, range === "custom" && s.rangePillActive]} onPress={() => setCustomOpen(true)}>
          <Icon name="calendar" size={13} color={range === "custom" ? "#fff" : T.aubergine} />
        </Pressable>
      </View>
      {range === "custom" && custom && (
        <Pressable style={s.fyNav} onPress={() => setCustomOpen(true)}>
          <Icon name="calendar" size={14} color={T.muted} />
          <Text style={s.fyLabel}>{customRangeLabel(custom)}</Text>
          <Icon name="chevD" size={14} color={T.muted} />
        </Pressable>
      )}
      <DateRangeSheet
        visible={customOpen}
        value={{ start: custom?.from ?? null, end: custom?.to ?? null }}
        title={t("m.dashpanels.customRangeTitle", { defaultValue: "Custom date range" })}
        minDate={null}
        maxDate={isoD(new Date())}
        onApply={(r) => {
          setCustomOpen(false);
          if (r.start) {
            const from = r.start, to = r.end ?? r.start;
            setCustom(from <= to ? { from, to } : { from: to, to: from });
            setRange("custom");
          }
        }}
        onClose={() => setCustomOpen(false)}
      />
      {range === "fy" && (
        <View style={s.fyNav}>
          <Pressable onPress={() => setFyYear((y) => y - 1)}><Icon name="chevL" size={15} color={T.muted} /></Pressable>
          <Text style={s.fyLabel}>{fyLabel}</Text>
          <Pressable disabled={fyYear >= CURRENT_FY} onPress={() => setFyYear((y) => Math.min(y + 1, CURRENT_FY))}><Icon name="chevR" size={15} color={fyYear >= CURRENT_FY ? "rgba(104,112,122,0.3)" : T.muted} /></Pressable>
        </View>
      )}
      <View style={{ marginTop: 8 }}>
        {[
          { l: t("m.dashpanels.stGross", { defaultValue: "Gross earnings" }), v: rupee(total) },
          { l: t("m.dashpanels.stRefunds", { defaultValue: "Refunds issued" }), v: `−${rupee(refunds)}` },
          { l: t("m.dashpanels.stCommission", { defaultValue: "Platform commission" }), v: `−${rupee(commission)}` },
          { l: t("m.dashpanels.stNet", { defaultValue: "Net earnings" }), v: rupee(total - refunds - commission), strong: true },
        ].map((row, i) => (
          <View key={row.l} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 7, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: "rgba(23,22,28,0.06)" }}>
            <Text style={row.strong ? s.byName : s.byCount}>{row.l}</Text>
            <Text style={[s.byName, { fontSize: 13 }]}>{row.v}</Text>
          </View>
        ))}
      </View>
      {discounts > 0 && (
        <Text style={[s.byCount, { marginTop: 6 }]}>
          {t("m.dashpanels.stDiscounts", { defaultValue: "Includes ₹{{amount}} in discounts you funded, already reflected in gross.", amount: Math.round(discounts).toLocaleString("en-IN") })}
        </Text>
      )}
    </View>
  );
}

/**
 * Payout status + destination account for the signed-in partner. "Awaiting
 * payout" = completed, customer-paid, unrefunded bookings not yet covered by
 * a recorded payout, net of platform commission. Account numbers are masked
 * server-side; the full number is write-only.
 */
export function PayoutsCard({ role }: { role?: string }) {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const payoutsQ = useQuery({ queryKey: ["my-payouts"], queryFn: () => fetchMyPayouts(1), staleTime: 30_000, retry: 1 });
  const accountQ = useQuery({ queryKey: ["my-payout-account"], queryFn: fetchPayoutAccount, staleTime: 60_000, retry: 1 });
  // Paged history list (50 per page, most recent first). Summary tiles above
  // always read page 1 via payoutsQ.
  const [page, setPage] = useState(1);
  const histQ = useQuery({ queryKey: ["my-payouts", page], queryFn: () => fetchMyPayouts(page), staleTime: 30_000, retry: 1 });

  const [editOpen, setEditOpen] = useState(false);
  const [method, setMethod] = useState<"bank" | "upi">("bank");
  const [holder, setHolder] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [upiId, setUpiId] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const d = payoutsQ.data;
  const account = accountQ.data ?? null;
  const last = d?.payouts?.[0];
  const history = histQ.data?.payouts ?? [];
  const total = histQ.data?.total ?? history.length;
  const pageSize = histQ.data?.pageSize ?? 50;
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  const submit = async () => {
    setSaving(true); setErr("");
    try {
      await savePayoutAccount(method === "bank"
        ? { method, accountHolder: holder, accountNumber, ifsc }
        : { method, upiId });
      setEditOpen(false);
      setAccountNumber("");
      qc.invalidateQueries({ queryKey: ["my-payout-account"] });
      qc.invalidateQueries({ queryKey: ["my-payouts"] });
    } catch (e: unknown) {
      const ax = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
      setErr(ax.response?.data?.error?.message || ax.message || "Couldn't save the account");
    } finally { setSaving(false); }
  };

  return (
    <View style={{ marginTop: 14 }}>
      {/* Payout account — the destination bank/UPI, top of the tab (mirrors web) */}
      <View style={[s.earnCard, { marginTop: 0 }]}>
        <Text style={s.cardTitle}>{t("m.dashpanels.payouts", { defaultValue: "Payment settings" })}</Text>
        <Text style={po.tileSub}>{t("m.dashpanels.payoutAcctSub", { defaultValue: "Where your earnings are paid out" })}</Text>
        <View style={po.acctRow}>
        <View style={{ flex: 1 }}>
          {account ? (
            <Text style={po.acctTxt} numberOfLines={1}>
              {account.method === "bank"
                ? `${(account.accountNumberMasked ?? "").trim()} · ${account.ifsc ?? ""}`
                : account.upiIdMasked}
            </Text>
          ) : (
            <Text style={po.acctMissing}>{t("m.dashpanels.payoutNoAccount", { defaultValue: "Add a bank account or UPI ID to receive payouts." })}</Text>
          )}
        </View>
        <Pressable style={po.acctBtn} onPress={() => { setEditOpen(true); setErr(""); if (account) setMethod(account.method); }}>
          <Text style={po.acctBtnTxt}>
            {account ? t("m.dashpanels.payoutChange", { defaultValue: "Change" }) : t("m.dashpanels.payoutAdd", { defaultValue: "Add account" })}
          </Text>
        </Pressable>
        </View>
      </View>

      {/* Status tiles — awaiting / last payout */}
      <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
        <View style={[po.tile, po.tileSolo]}>
          <Text style={po.tileLbl}>{t("m.dashpanels.payoutPending", { defaultValue: "Awaiting payout" })}</Text>
          <Text style={po.tileVal}>{d ? rupee(d.pendingPaise / 100) : "—"}</Text>
          <Text style={po.tileSub}>{d ? t("m.dashpanels.payoutPendingSub", { defaultValue: "{{count}} completed bookings", count: d.pendingBookings }) : ""}</Text>
        </View>
        <View style={[po.tile, po.tileSolo]}>
          <Text style={po.tileLbl}>{t("m.dashpanels.payoutLast", { defaultValue: "Last payout" })}</Text>
          {last ? (
            <>
              <Text style={po.tileVal}>{rupee(last.amountPaise / 100)}</Text>
              <Text style={po.tileSub}>{new Date(last.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}</Text>
            </>
          ) : (
            <Text style={po.tileSub}>{t("m.dashpanels.payoutNone", { defaultValue: "No payouts yet" })}</Text>
          )}
        </View>
      </View>

      {/* Filtered period statement — its own card (mirrors web) */}
      {role ? (
        <View style={[s.earnCard, { marginTop: 12 }]}>
          <PayoutStatement role={role} />
        </View>
      ) : null}

      {/* Payout history — its own card: 50 per page, most recent first. */}
      {total > 0 && (
        <View style={[s.earnCard, { marginTop: 12 }]}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
            <Text style={s.cardTitle}>{t("m.dashpanels.payoutHistory", { defaultValue: "Payout history" })}</Text>
            <Text style={po.tileSub}>{t("m.dashpanels.payoutHistoryCount", { defaultValue: "{{count}} total", count: total })}</Text>
          </View>
          {histQ.isLoading ? (
            <Text style={[po.tileSub, { textAlign: "center", paddingVertical: 12 }]}>{t("m.dashpanels.payoutLoading", { defaultValue: "Loading…" })}</Text>
          ) : (
            history.map((p, i) => {
              // "Sent to A/C •••• 1234" / UPI — masked snapshot captured at
              // payout time; older rows have none.
              const dMasked = p.destination
                ? (p.destination.method === "upi" ? p.destination.upiIdMasked : p.destination.accountNumberMasked)
                : null;
              const dest = dMasked
                ? (p.destination!.method === "upi"
                    ? t("m.dashpanels.payoutSentUpi", { defaultValue: "Sent to UPI {{masked}}", masked: dMasked })
                    : t("m.dashpanels.payoutSentAccount", { defaultValue: "Sent to A/C {{masked}}", masked: dMasked }))
                : null;
              return (
                <View key={p.id} style={[po.histRow, i > 0 && po.histRowDivider]}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={po.histAmt}>{rupee(p.amountPaise / 100)}</Text>
                    <Text style={po.tileSub} numberOfLines={1}>
                      {p.bookings} {t("m.dashpanels.payoutBookings", { defaultValue: "bookings" })} · {p.method.toUpperCase()}{p.note ? ` · ${p.note}` : ""}
                    </Text>
                    {dest ? <Text style={po.tileSub} numberOfLines={1}>{dest}</Text> : null}
                  </View>
                  <Text style={po.histDate}>{new Date(p.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}</Text>
                </View>
              );
            })
          )}
          {maxPage > 1 && (
            <View style={po.pagerRow}>
              <Text style={po.tileSub}>{t("m.dashpanels.payoutPageOf", { defaultValue: "Page {{page}} of {{pages}}", page, pages: maxPage })}</Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Pressable
                  disabled={page <= 1 || histQ.isFetching}
                  onPress={() => setPage((v) => Math.max(1, v - 1))}
                  style={[po.pagerBtn, (page <= 1 || histQ.isFetching) && { opacity: 0.4 }]}
                >
                  <Text style={po.pagerTxt}>{t("m.dashpanels.payoutPrev", { defaultValue: "Previous" })}</Text>
                </Pressable>
                <Pressable
                  disabled={page >= maxPage || histQ.isFetching}
                  onPress={() => setPage((v) => Math.min(maxPage, v + 1))}
                  style={[po.pagerBtn, (page >= maxPage || histQ.isFetching) && { opacity: 0.4 }]}
                >
                  <Text style={po.pagerTxt}>{t("m.dashpanels.payoutNext", { defaultValue: "Next" })}</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      )}

      <Modal visible={editOpen} transparent animationType="fade" onRequestClose={() => setEditOpen(false)}>
        <View style={po.modalBack}>
          <View style={po.modalCard}>
            <Text style={po.modalTitle}>{t("m.dashpanels.payoutAccount", { defaultValue: "Payout account" })}</Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
              {(["bank", "upi"] as const).map((m) => (
                <Pressable key={m} style={[po.methodPill, method === m && po.methodPillOn]} onPress={() => setMethod(m)}>
                  <Text style={[po.methodPillTxt, method === m && { color: "#fff" }]}>
                    {m === "bank" ? t("m.dashpanels.payoutBank", { defaultValue: "Bank" }) : "UPI"}
                  </Text>
                </Pressable>
              ))}
            </View>
            {method === "bank" ? (
              <View style={{ gap: 8, marginTop: 10 }}>
                <TextInput style={po.input} placeholder={t("m.dashpanels.payoutHolder", { defaultValue: "Account holder name" })} placeholderTextColor={T.muted} value={holder} onChangeText={setHolder} />
                <TextInput style={po.input} placeholder={t("m.dashpanels.payoutNumber", { defaultValue: "Account number" })} placeholderTextColor={T.muted} keyboardType="number-pad" value={accountNumber} onChangeText={setAccountNumber} />
                <TextInput style={po.input} placeholder="IFSC (e.g. HDFC0001234)" placeholderTextColor={T.muted} autoCapitalize="characters" value={ifsc} onChangeText={(v) => setIfsc(v.toUpperCase())} />
              </View>
            ) : (
              <TextInput style={[po.input, { marginTop: 10 }]} placeholder="name@okhdfcbank" placeholderTextColor={T.muted} autoCapitalize="none" value={upiId} onChangeText={setUpiId} />
            )}
            {err ? <Text style={po.err}>{err}</Text> : null}
            <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
              <Pressable style={po.cancelBtn} onPress={() => setEditOpen(false)}>
                <Text style={po.cancelTxt}>{t("m.common.cancel", { defaultValue: "Cancel" })}</Text>
              </Pressable>
              <Pressable style={[po.saveBtn, saving && { opacity: 0.5 }]} disabled={saving} onPress={submit}>
                <Text style={po.saveTxt}>{saving ? t("m.dashpanels.payoutSaving", { defaultValue: "Saving…" }) : t("m.dashpanels.payoutSave", { defaultValue: "Save" })}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const po = StyleSheet.create({
  tile: { flex: 1, backgroundColor: "rgba(23,22,28,0.04)", borderRadius: 14, padding: 12 },
  // Standalone variant — the status tiles sit between cards on the Payment
  // settings tab, so they carry the card chrome themselves.
  tileSolo: { backgroundColor: "rgba(255,255,255,0.85)", borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", borderRadius: 18, padding: 14 },
  tileLbl: { fontFamily: font.bodySemi, fontSize: 11, color: T.muted },
  tileVal: { fontFamily: font.bodyBold, fontSize: 18, color: T.ink, marginTop: 2 },
  tileSub: { fontFamily: font.bodyMed, fontSize: 11, color: T.muted, marginTop: 2 },
  acctRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(23,22,28,0.12)", paddingTop: 12 },
  histRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9 },
  histRowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(23,22,28,0.08)" },
  histAmt: { fontFamily: font.bodyBold, fontSize: 14, color: T.ink },
  histDate: { fontFamily: font.bodyMed, fontSize: 11, color: T.muted, flexShrink: 0 },
  pagerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(23,22,28,0.08)", paddingTop: 10 },
  pagerBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: "rgba(23,22,28,0.15)", backgroundColor: "#fff" },
  pagerTxt: { fontFamily: font.bodySemi, fontSize: 12, color: T.ink },
  acctTxt: { fontFamily: font.bodySemi, fontSize: 13, color: T.ink },
  acctMissing: { fontFamily: font.bodyMed, fontSize: 12.5, color: T.muted },
  acctBtn: { borderWidth: 1, borderColor: "rgba(23,22,28,0.16)", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 },
  acctBtnTxt: { fontFamily: font.bodySemi, fontSize: 12, color: T.ink },
  modalBack: { flex: 1, backgroundColor: "rgba(23,22,28,0.45)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { width: "100%", maxWidth: 420, backgroundColor: "#fff", borderRadius: 18, padding: 18 },
  modalTitle: { fontFamily: font.headSemi, fontSize: 16, color: T.ink },
  methodPill: { borderWidth: 1, borderColor: "rgba(23,22,28,0.16)", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  methodPillOn: { backgroundColor: T.ink, borderColor: T.ink },
  methodPillTxt: { fontFamily: font.bodySemi, fontSize: 12.5, color: T.ink },
  input: { borderWidth: 1, borderColor: "rgba(23,22,28,0.16)", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontFamily: font.bodyMed, fontSize: 14, color: T.ink },
  err: { fontFamily: font.bodyMed, fontSize: 12.5, color: T.coral, marginTop: 8 },
  cancelBtn: { flex: 1, borderWidth: 1, borderColor: "rgba(23,22,28,0.16)", borderRadius: 12, alignItems: "center", paddingVertical: 11 },
  cancelTxt: { fontFamily: font.bodySemi, fontSize: 13.5, color: T.ink },
  saveBtn: { flex: 1, backgroundColor: T.ink, borderRadius: 12, alignItems: "center", paddingVertical: 11 },
  saveTxt: { fontFamily: font.bodySemi, fontSize: 13.5, color: "#fff" },
  linkTile: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14, backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: "rgba(23,22,28,0.08)", padding: 14 },
  linkTxt: { fontFamily: font.bodySemi, fontSize: 12.5, color: T.terra },
  nudge: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "rgba(216,164,90,0.14)", borderWidth: 1, borderColor: "rgba(216,164,90,0.4)", borderRadius: 16, padding: 12, marginBottom: 14 },
  nudgeIco: { width: 32, height: 32, borderRadius: 10, backgroundColor: "rgba(216,164,90,0.24)", alignItems: "center", justifyContent: "center" },
  nudgeTitle: { fontFamily: font.bodySemi, fontSize: 13, color: T.ink },
  nudgeBody: { fontFamily: font.bodyMed, fontSize: 11.5, color: T.muted, marginTop: 1 },
});

/* ---------------- reviews ---------------- */
function distribution(rating: number, n: number) {
  const d: [number, number][] = [[5, Math.round(n * 0.74)], [4, Math.round(n * 0.18)], [3, Math.round(n * 0.05)], [2, Math.round(n * 0.02)], [1, 0]];
  const sum = d.reduce((a, [, c]) => a + c, 0);
  d[0][1] = Math.max(0, d[0][1] + (n - sum));
  return d;
}
function initials(name: string) { return name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase(); }

function RevCard({ rv, listing }: { rv: { name: string; when: string; rating: number; text: string }; listing?: string }) {
  return (
    <View style={s.revCard}>
      <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
        <View style={s.revAv}><Text style={s.revAvTxt}>{initials(rv.name)}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={s.revName}>{rv.name}</Text>
          <Text style={s.revWhen} numberOfLines={1}>{listing ? listing + " · " : ""}{rv.when}</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 1 }}>{Array.from({ length: rv.rating }).map((_, i) => <Icon key={i} name="starFill" size={12} color={T.saffron} />)}</View>
      </View>
      <Text style={s.revText}>“{rv.text}”</Text>
    </View>
  );
}

type Opt = { value: string; label: string };
function DashSelect({ value, options, onChange }: { value: string; options: Opt[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    // zIndex bumps the open dropdown above sibling rows so it overlays content below it
    <View style={{ position: "relative", zIndex: open ? 50 : 1 }}>
      <Pressable onPress={() => setOpen((o) => !o)} style={({ pressed }: { pressed: boolean }) => [s.selTrigger, open && { borderColor: "rgba(139,94,74,0.5)" }, pressed && { opacity: 0.85 }]}>
        <Text style={s.selTxt} numberOfLines={1}>{current?.label}</Text>
        <Icon name="chevD" size={15} color={T.muted} />
      </Pressable>
      {open && (
        <View style={s.selMenu}>
          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {options.map((o) => (
              <Pressable key={o.value} onPress={() => { onChange(o.value); setOpen(false); }} style={({ pressed }: { pressed: boolean }) => [s.selItem, o.value === value && { backgroundColor: "rgba(139,94,74,0.09)" }, pressed && { opacity: 0.8 }]}>
                <Text style={[s.selItemTxt, o.value === value && { color: T.terra }]} numberOfLines={1}>{o.label}</Text>
                {o.value === value && <Icon name="checkSm" size={16} color={T.terra} strokeWidth={2.6} />}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

function DashReviewsModal({ d, reviews, rating, count, visible, onClose }: { d: DashRole; reviews: { name: string; when: string; rating: number; text: string; listing: string }[]; rating: number; count: number; visible: boolean; onClose: () => void }) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const allLabelDefault = { host: "All properties", provider: "All services", transport: "All vehicles" }[d.role] || "All listings";
  const allLabelKey = ["host", "provider", "transport"].includes(d.role) ? d.role : "listings";
  const allLabel = t(`m.dashpanels.allListings.${allLabelKey}`, { defaultValue: allLabelDefault });
  const [ratingF, setRatingF] = useState("all");
  const [listingF, setListingF] = useState("all");
  const [sort, setSort] = useState("recent");
  let shown = reviews.filter((r) => (ratingF === "all" || Math.round(r.rating) === Number(ratingF)) && (listingF === "all" || r.listing === listingF));
  if (sort === "highest") shown = [...shown].sort((a, b) => b.rating - a.rating);
  else if (sort === "lowest") shown = [...shown].sort((a, b) => a.rating - b.rating);
  else if (sort === "oldest") shown = [...shown].reverse();
  const filtered = ratingF !== "all" || listingF !== "all";
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#faf8fa", paddingTop: insets.top }}>
        <View style={s.fsHead}>
          <Pressable onPress={onClose} style={({ pressed }: { pressed: boolean }) => [{ padding: 6 }, pressed && { opacity: 0.6 }]}><Icon name="x" size={24} color={T.ink} /></Pressable>
          <Text style={s.fsTitle}>{t("m.dashpanels.reviews", { defaultValue: "Reviews" })}</Text>
          <View style={{ width: 36 }} />
        </View>
        <View style={s.revTop}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
            <Text style={[s.bigRating, { fontSize: 30 }]}>{rating.toFixed(1)}</Text>
            <Text style={s.revWhen}><Icon name="starFill" size={13} color={T.saffron} /> {t("m.dashpanels.reviewsCount", { defaultValue: "{{count}} reviews", count })}</Text>
          </View>
          <View style={{ gap: 8, marginTop: 12 }}>
            <DashSelect value={listingF} onChange={setListingF} options={[{ value: "all", label: allLabel }, ...d.listings.map((l) => ({ value: l.name, label: l.name }))]} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}><DashSelect value={ratingF} onChange={setRatingF} options={[{ value: "all", label: t("m.dashpanels.allRatings", { defaultValue: "All ratings" }) }, ...[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: t("m.dashpanels.nStars", { defaultValue: "{{n}} stars", n }) }))]} /></View>
              <View style={{ flex: 1 }}><DashSelect value={sort} onChange={setSort} options={[{ value: "recent", label: t("m.dashpanels.sortRecent", { defaultValue: "Most recent" }) }, { value: "oldest", label: t("m.dashpanels.sortOldest", { defaultValue: "Oldest" }) }, { value: "highest", label: t("m.dashpanels.sortHighest", { defaultValue: "Highest rated" }) }, { value: "lowest", label: t("m.dashpanels.sortLowest", { defaultValue: "Lowest rated" }) }]} /></View>
            </View>
          </View>
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 24 }} showsVerticalScrollIndicator={false}>
          <Text style={[s.revWhen, { marginVertical: 12 }]}>{t("m.dashpanels.reviewsShown", { defaultValue: "{{count}} reviews", count: shown.length })}{filtered ? t("m.dashpanels.filteredSuffix", { defaultValue: " · filtered" }) : ""}</Text>
          <View style={{ gap: 12 }}>
            {shown.length ? shown.map((rv, i) => <RevCard key={i} rv={rv} listing={rv.listing} />) : <Text style={[s.revWhen, { textAlign: "center", padding: 24 }]}>{t("m.dashpanels.noMatching", { defaultValue: "No matching reviews." })}</Text>}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

export function DashReviews({ d, real }: { d: DashRole; real?: { list: { name: string; when: string; rating: number; text: string; listing?: string }[]; rating: number; count: number; fromBackend?: boolean } }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const useReal = !!real?.fromBackend;
  const rating = useReal ? real!.rating : d.reviews.rating;
  const count = useReal ? real!.count : d.reviews.count;
  const reviews = useMemo(() => {
    if (useReal) return (real!.list || []).map((r) => ({ ...r, listing: r.listing || "" }));
    return (d.reviews.list || []).map((r) => ({ ...r, listing: "" }));
  }, [d, useReal, real]);
  const dist = distribution(rating, count);
  const max = Math.max(...dist.map(([, c]) => c), 1);
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={s.secTitle}>{t("m.dashpanels.reviews", { defaultValue: "Reviews" })}</Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <Text style={s.bigRating}>{rating.toFixed(1)}</Text>
        <Text style={s.revWhen}>{t("m.dashpanels.reviewsCount", { defaultValue: "{{count}} reviews", count })}</Text>
      </View>
      {useReal && count === 0 ? (
        <Text style={[s.revWhen, { marginTop: 16 }]}>{t("m.dashpanels.noReviewsYet", { defaultValue: "No reviews yet. They'll appear here once guests review your completed bookings." })}</Text>
      ) : (
        <>
          <View style={{ gap: 7, marginTop: 14 }}>
            {dist.map(([star, c]) => (
              <View key={star} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 3, width: 34 }}>
                  <Text style={s.rbStar}>{star}</Text>
                  <Icon name="starFill" size={11} color={T.saffron} />
                </View>
                <View style={s.rbTrack}><View style={[s.rbFill, { width: `${(c / max) * 100}%` }]} /></View>
                <Text style={s.rbN}>{c}</Text>
              </View>
            ))}
          </View>
          <View style={{ gap: 12, marginTop: 16 }}>
            {reviews.slice(0, 2).map((rv, i) => <RevCard key={i} rv={rv} listing={rv.listing} />)}
          </View>
          <Pressable style={s.ghost} onPress={() => setOpen(true)}>
            <Text style={s.ghostTxt}>{t("m.dashpanels.showAllReviews", { defaultValue: "Show all {{count}} reviews", count })}</Text>
          </Pressable>
        </>
      )}
      <DashReviewsModal d={d} reviews={reviews} rating={rating} count={count} visible={open} onClose={() => setOpen(false)} />
    </View>
  );
}

const s = StyleSheet.create({
  chip: { paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999 },
  chipTxt: { fontSize: 11, fontFamily: font.bodyHeavy },
  barLbl: { fontSize: 9.5, color: T.muted, fontFamily: font.body },
  chartMax: { position: "absolute", top: 0, left: 0, fontSize: 9.5, color: T.muted, fontFamily: font.bodySemi },
  secTitle: { fontSize: 16, fontFamily: font.headHeavy, color: T.ink, marginBottom: 12 },
  rangeRow: { flexDirection: "row", gap: 6, marginBottom: 12 },
  rangePill: { flex: 1, paddingVertical: 8, borderRadius: 999, alignItems: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.56)" },
  rangePillActive: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  rangePillTxt: { fontSize: 12, fontFamily: font.bodyBold, color: T.aubergine },
  fyNav: { flexDirection: "row", alignItems: "center", gap: 2, alignSelf: "flex-start", borderWidth: 1, borderColor: T.line, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 6, marginBottom: 12, backgroundColor: "#fff" },
  fyLabel: { fontSize: 12.5, fontFamily: font.bodyHeavy, paddingHorizontal: 5, color: T.ink },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  kpi: { width: "47%", flexGrow: 1, padding: 14, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.85)" },
  kpiIco: { width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center", marginBottom: 10 },
  kpiVal: { fontSize: 21, fontFamily: font.head, color: T.ink },
  kpiLbl: { fontSize: 11.5, color: T.muted, marginTop: 2, fontFamily: font.body },
  earnCard: { padding: 16, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.85)", marginTop: 16 },
  cardTitle: { fontSize: 14, fontFamily: font.head, color: T.ink },
  delta: { flexDirection: "row", alignItems: "center", gap: 3, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999 },
  deltaTxt: { fontSize: 11, fontFamily: font.bodyHeavy },
  empty: { color: T.muted, fontSize: 13, textAlign: "center", paddingVertical: 24, fontFamily: font.body },
  byRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 12, backgroundColor: "rgba(23,22,28,0.03)" },
  byName: { fontSize: 13, fontFamily: font.bodyBold, color: T.ink },
  byCount: { fontSize: 11, color: T.muted, fontFamily: font.body },
  byTotal: { fontSize: 14, fontFamily: font.bodyHeavy, color: "#2f7d55" },
  bigRating: { fontSize: 32, fontFamily: font.head, color: T.ink },
  rbStar: { fontSize: 12, fontFamily: font.bodyBold, color: T.ink },
  rbTrack: { flex: 1, height: 7, borderRadius: 999, backgroundColor: T.line, overflow: "hidden" },
  rbFill: { height: "100%", borderRadius: 999, backgroundColor: T.saffron },
  rbN: { width: 26, textAlign: "right", fontSize: 12, color: T.muted, fontFamily: font.body },
  revCard: { padding: 14, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.85)" },
  revAv: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: T.aubergine },
  revAvTxt: { color: "#fff", fontFamily: font.headHeavy, fontSize: 14 },
  revName: { fontSize: 14, fontFamily: font.bodyBold, color: T.ink },
  revWhen: { fontSize: 12, color: T.muted, fontFamily: font.body },
  revText: { fontSize: 13, lineHeight: 20, marginTop: 12, color: T.ink, fontFamily: font.body },
  ghost: { minHeight: 52, borderRadius: 18, alignItems: "center", justifyContent: "center", marginTop: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.6)" },
  ghostTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 15 },
  fsHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: T.line },
  fsTitle: { fontSize: 16, fontFamily: font.head, color: T.ink },
  revTop: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: "rgba(255,255,255,0.5)", zIndex: 30 },
  selTrigger: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 42, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  selTxt: { flex: 1, fontSize: 13.5, fontFamily: font.bodySemi, color: T.ink },
  selMenu: { position: "absolute", top: 46, left: 0, right: 0, zIndex: 50, maxHeight: 260, backgroundColor: "#fff", borderRadius: 14, padding: 8, borderWidth: 1, borderColor: T.line, shadowColor: "#241e1c", shadowOffset: { width: 0, height: 16 }, shadowOpacity: 0.18, shadowRadius: 32, elevation: 18 },
  selItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10 },
  selItemTxt: { fontSize: 14, fontFamily: font.bodySemi, color: T.ink, flex: 1 },
});
