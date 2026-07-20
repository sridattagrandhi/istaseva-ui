// Shared presentational bits + formatters for the mobile admin tabs.
import React from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { T, font } from "../../theme";

const nf = new Intl.NumberFormat("en-IN");
export const fmt = (n: number | undefined | null) => nf.format(Number(n ?? 0));
export function rupees(paise: number | undefined | null): string {
  const r = Number(paise ?? 0) / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(2)}Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(2)}L`;
  if (r >= 1e3) return `₹${(r / 1e3).toFixed(1)}K`;
  return `₹${nf.format(Math.round(r))}`;
}
export const rate = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—");

export function Kpi({ label, value, sub, delta, tag }: { label: string; value: string; sub?: string; delta?: React.ReactNode; tag?: string }) {
  return (
    <View style={s.kpi}>
      <View style={s.rowBetween}>
        <Text style={[s.kpiLabel, { flexShrink: 1 }]}>{label}</Text>
        {!!tag && <Tag text={tag} />}
      </View>
      <View style={s.kpiValueRow}>
        <Text style={s.kpiValue}>{value}</Text>
        {delta}
      </View>
      {!!sub && <Text style={s.kpiSub}>{sub}</Text>}
    </View>
  );
}

/** Tiny muted pill — marks tiles/sections the analytics filter can't narrow
 *  ("Platform-wide": their data comes from the day-keyed rollups, which carry
 *  no listing dimension). Rendered only while a filter is active. */
export function Tag({ text }: { text: string }) {
  return (
    <View style={s.tag}>
      <Text style={s.tagTxt}>{text}</Text>
    </View>
  );
}

/**
 * Period-over-period pill for a KPI tile: % change of `current` vs the
 * previous equal-length window (mirror of the web KpiDelta). Renders "—"
 * when there's no prior baseline. `invert` marks metrics where an increase
 * is bad (refunds, cancellations).
 */
export function KpiDelta({ current, previous, invert }: { current: number; previous: number; invert?: boolean }) {
  if (!(previous > 0)) return <Text style={s.deltaMuted}>—</Text>;
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.05) return <Text style={s.deltaMuted}>0%</Text>;
  const up = pct > 0;
  const good = invert ? !up : up;
  const magnitude = Math.abs(pct) >= 100 ? fmt(Math.round(Math.abs(pct))) : Math.abs(pct).toFixed(1);
  return (
    <Text style={[s.delta, { color: good ? "#0f8a5f" : "#c0392b" }]}>
      {up ? "▲" : "▼"} {magnitude}%
    </Text>
  );
}
export function KpiGrid({ children }: { children: React.ReactNode }) {
  return <View style={s.kpiGrid}>{children}</View>;
}
export function Card({ children }: { children: React.ReactNode }) {
  return <View style={s.card}>{children}</View>;
}
export function SecTitle({ children, tag }: { children: React.ReactNode; tag?: string }) {
  if (!tag) return <Text style={s.secTitle}>{children}</Text>;
  return (
    <View style={[s.rowBetween, { marginTop: 20, marginBottom: 8 }]}>
      <Text style={[s.secTitle, { marginTop: 0, marginBottom: 0, flexShrink: 1 }]}>{children}</Text>
      <Tag text={tag} />
    </View>
  );
}
export function Empty({ children }: { children: React.ReactNode }) {
  return <Text style={s.emptyBody}>{children}</Text>;
}
export function Loading() {
  return <View style={s.center}><ActivityIndicator color={T.aubergine} /></View>;
}

/** Horizontal proportion bar: an outer (lighter) value + an inner (solid) value, both scaled to `max`. */
export function DualBar({ outer, inner, max }: { outer: number; inner: number; max: number }) {
  const m = Math.max(1, max);
  return (
    <View style={s.barTrack}>
      <View style={[s.barOuter, { width: `${Math.round((outer / m) * 100)}%` }]} />
      <View style={[s.barInner, { width: `${Math.round((inner / m) * 100)}%` }]} />
    </View>
  );
}
export function Bar({ value, max, color }: { value: number; max: number; color?: string }) {
  return (
    <View style={s.barTrack}>
      <View style={[s.barInner, { width: `${Math.round((value / Math.max(1, max)) * 100)}%`, backgroundColor: color ?? T.aubergine }]} />
    </View>
  );
}

export const s = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", paddingVertical: 40 },
  emptyBody: { fontSize: 13, color: T.muted, fontFamily: font.body, paddingVertical: 8 },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  kpi: { width: "47.5%", flexGrow: 1, backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: T.line, padding: 14 },
  kpiLabel: { fontSize: 11, color: T.muted, fontFamily: font.body, textTransform: "uppercase", letterSpacing: 0.4 },
  kpiValueRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 6, marginTop: 4 },
  kpiValue: { fontSize: 20, fontFamily: font.head, color: T.ink, flexShrink: 1 },
  kpiSub: { fontSize: 11, color: T.muted, fontFamily: font.body, marginTop: 2 },
  delta: { fontSize: 11, fontFamily: font.head },
  deltaMuted: { fontSize: 11, color: T.muted, fontFamily: font.body },
  secTitle: { fontSize: 14, fontFamily: font.head, color: T.ink, marginTop: 20, marginBottom: 8 },
  card: { backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: T.line, padding: 14 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  rowLabel: { fontSize: 14, fontFamily: font.head, color: T.ink },
  rowMuted: { fontSize: 12, color: T.muted, fontFamily: font.body },
  divider: { borderBottomWidth: 1, borderBottomColor: T.line },
  tag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: "rgba(23,22,28,0.06)", borderWidth: 1, borderColor: T.line },
  tagTxt: { fontSize: 9.5, fontFamily: font.head, color: T.muted, letterSpacing: 0.2 },
  barTrack: { marginTop: 6, height: 8, borderRadius: 999, backgroundColor: "rgba(23,22,28,0.06)", overflow: "hidden" },
  barOuter: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: "rgba(58,50,71,0.25)", borderRadius: 999 },
  barInner: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: T.aubergine, borderRadius: 999 },
});
