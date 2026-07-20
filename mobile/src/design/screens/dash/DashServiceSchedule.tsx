// dash/DashServiceSchedule.tsx — service provider day-blocking overlay.
//
// Deliberately SEPARATE from the transport DashSchedule (hourly strips) and the
// stays DashCalendar (per-night pricing + rooms): a service only needs whole-day
// blocking, so this is a touch-first month grid where each tap toggles a day.
// Blocked days persist to listing_availability_overrides at the listing level
// (roomTypeId null) — the same store the customer booking calendar reads and the
// backend's createHold enforces.
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../Icon";
import { IconBtn } from "../../primitives";
import { T, font } from "../../theme";
import { fetchAvailability, fetchServiceBookings, setAvailability } from "../../api/dash";
import { useLanguage } from "@/contexts/LanguageContext";

const toISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);

export function DashServiceSchedule({ name, listingId, onClose }: {
  name: string;
  listingId?: string;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const [booked, setBooked] = useState<Set<string>>(new Set());
  // Dates currently mid-PUT — disables the cell so a double tap can't race.
  const [pending, setPending] = useState<Set<string>>(new Set());

  const todayISO = toISO(new Date());

  // Hydrate blocked + booked state from the backend (real listings only).
  useEffect(() => {
    if (!listingId) return;
    fetchAvailability(listingId)
      .then((rows) => setBlocked(new Set(rows.filter((r) => r.blocked && r.roomTypeId == null).map((r) => r.date))))
      .catch(() => {});
    fetchServiceBookings(listingId)
      .then((rows) => setBooked(new Set(rows.map((r) => r.date))))
      .catch(() => {});
  }, [listingId]);

  const toggle = (iso: string) => {
    if (iso < todayISO || pending.has(iso)) return;
    const wasBlocked = blocked.has(iso);
    setBlocked((prev) => { const n = new Set(prev); wasBlocked ? n.delete(iso) : n.add(iso); return n; });
    if (!listingId) return;
    setPending((prev) => new Set(prev).add(iso));
    setAvailability(listingId, [{ date: iso, blocked: !wasBlocked, pricePaise: null, roomTypeId: null }])
      .catch(() => {
        // Roll back optimistic toggle on failure.
        setBlocked((prev) => { const n = new Set(prev); wasBlocked ? n.add(iso) : n.delete(iso); return n; });
      })
      .finally(() => setPending((prev) => { const n = new Set(prev); n.delete(iso); return n; }));
  };

  // Sun-anchored grid with leading/trailing filler days for layout.
  const grid = useMemo(() => {
    const first = startOfMonth(cursor);
    const last = endOfMonth(cursor);
    const leading = first.getDay();
    const days: { date: Date; inMonth: boolean }[] = [];
    for (let i = 0; i < leading; i++) { const d = new Date(first); d.setDate(d.getDate() - (leading - i)); days.push({ date: d, inMonth: false }); }
    for (let i = 1; i <= last.getDate(); i++) days.push({ date: new Date(cursor.getFullYear(), cursor.getMonth(), i), inMonth: true });
    while (days.length % 7 !== 0) { const d = new Date(days[days.length - 1].date); d.setDate(d.getDate() + 1); days.push({ date: d, inMonth: false }); }
    return days;
  }, [cursor]);

  // Chunk into explicit weeks of 7. Rendering each week as its own flex row
  // (cells flex:1) guarantees exactly 7 columns filling the full width — a
  // percentage-width + flexWrap grid drops the 7th cell to the next row when
  // subpixel rounding nudges the row past 100%.
  const weeks = useMemo(() => {
    const out: { date: Date; inMonth: boolean }[][] = [];
    for (let i = 0; i < grid.length; i += 7) out.push(grid.slice(i, i + 7));
    return out;
  }, [grid]);

  const monthLabel = cursor.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const dow = [
    t("m.dashsvc.dowSun", { defaultValue: "Sun" }), t("m.dashsvc.dowMon", { defaultValue: "Mon" }),
    t("m.dashsvc.dowTue", { defaultValue: "Tue" }), t("m.dashsvc.dowWed", { defaultValue: "Wed" }),
    t("m.dashsvc.dowThu", { defaultValue: "Thu" }), t("m.dashsvc.dowFri", { defaultValue: "Fri" }),
    t("m.dashsvc.dowSat", { defaultValue: "Sat" }),
  ];

  return (
    <View style={[styles.lob, { paddingTop: insets.top }]}>
      <View style={styles.head}>
        <IconBtn name="x" onPress={onClose} />
        <View style={{ flex: 1 }}>
          <Text style={styles.headTitle} numberOfLines={1}>{t("m.dashsvc.headerTitle", { defaultValue: "{{name}} — Schedule", name })}</Text>
          <Text style={styles.headSub}>{t("m.dashsvc.headerSub", { defaultValue: "Tap a day to block it — customers can't book blocked days." })}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        <View style={styles.monthNav}>
          <Pressable hitSlop={8} onPress={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}><Icon name="chevL" size={20} color={T.ink} /></Pressable>
          <Text style={styles.monthLabel}>{monthLabel}</Text>
          <Pressable hitSlop={8} onPress={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}><Icon name="chevR" size={20} color={T.ink} /></Pressable>
        </View>

        <View style={styles.dowRow}>
          {dow.map((d) => <Text key={d} style={styles.dowTxt}>{d}</Text>)}
        </View>

        {weeks.map((week, wi) => (
          <View key={wi} style={styles.weekRow}>
            {week.map(({ date, inMonth }, i) => {
              const iso = toISO(date);
              const isPast = iso < todayISO;
              const isBlocked = blocked.has(iso);
              const isBooked = !isBlocked && booked.has(iso);
              const isPending = pending.has(iso);
              return (
                <Pressable
                  key={i}
                  disabled={isPast || isPending}
                  onPress={() => toggle(iso)}
                  style={[
                    styles.cell,
                    !inMonth && { opacity: 0.35 },
                    isPast && styles.cellPast,
                    isBlocked && styles.cellBlocked,
                    isPending && { opacity: 0.5 },
                  ]}
                >
                  <Text style={[styles.cellNum, isBlocked && { color: T.coral }]}>{date.getDate()}</Text>
                  {isBlocked && <Text style={styles.cellTag}>{t("m.dashsvc.blocked", { defaultValue: "Blocked" })}</Text>}
                  {isBooked && <Text style={styles.cellBooked}>{t("m.dashsvc.booked", { defaultValue: "Booked" })}</Text>}
                </Pressable>
              );
            })}
          </View>
        ))}

        <View style={styles.legend}>
          <View style={styles.legendItem}><View style={[styles.swatch, { backgroundColor: "#fff", borderColor: T.line }]} /><Text style={styles.legendTxt}>{t("m.dashsvc.legendOpen", { defaultValue: "Open" })}</Text></View>
          <View style={styles.legendItem}><View style={[styles.swatch, { backgroundColor: "rgba(164,93,98,0.14)", borderColor: "rgba(164,93,98,0.4)" }]} /><Text style={styles.legendTxt}>{t("m.dashsvc.blocked", { defaultValue: "Blocked" })}</Text></View>
          <Text style={styles.legendTxt}>{t("m.dashsvc.bookedHint", { defaultValue: "“Booked” = already has a booking" })}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  lob: { ...StyleSheet.absoluteFillObject, backgroundColor: T.bg, zIndex: 45 },
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface },
  headTitle: { fontSize: 16, fontFamily: font.head, color: T.ink },
  headSub: { fontSize: 12, color: T.muted, fontFamily: font.body },
  monthNav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  monthLabel: { fontSize: 15, fontFamily: font.bodyBold, color: T.ink },
  dowRow: { flexDirection: "row", gap: 4, marginBottom: 6 },
  dowTxt: { flex: 1, textAlign: "center", fontSize: 10, color: T.muted, fontFamily: font.bodyHeavy, textTransform: "uppercase" },
  weekRow: { flexDirection: "row", gap: 4, marginBottom: 4 },
  cell: { flex: 1, aspectRatio: 1, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: T.line, borderRadius: 10, backgroundColor: "#fff" },
  cellPast: { opacity: 0.4 },
  cellBlocked: { backgroundColor: "rgba(164,93,98,0.12)", borderColor: "rgba(164,93,98,0.35)" },
  cellNum: { fontSize: 13, fontFamily: font.bodyBold, color: T.ink },
  cellTag: { fontSize: 9, color: T.coral, fontFamily: font.body, marginTop: 1 },
  cellBooked: { fontSize: 9, color: T.muted, fontFamily: font.body, marginTop: 1 },
  legend: { flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap", marginTop: 16 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  swatch: { width: 12, height: 12, borderRadius: 4, borderWidth: 1 },
  legendTxt: { fontSize: 11, color: T.muted, fontFamily: font.body },
});
