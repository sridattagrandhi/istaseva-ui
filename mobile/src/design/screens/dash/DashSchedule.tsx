// dash/DashSchedule.tsx — transport 30-day schedule overlay (ported from dash-manage.jsx).
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../Icon";
import { IconBtn } from "../../primitives";
import { T, font } from "../../theme";
import { fetchAvailability, setAvailability } from "../../api/dash";
import { useLanguage } from "@/contexts/LanguageContext";

const parseHHMM = (s: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(s.trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const formatHHMM = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
const formatLabel = (mins: number) => { const h = Math.floor(mins / 60), m = mins % 60, period = h >= 12 ? "PM" : "AM", h12 = ((h + 11) % 12) + 1; return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, "0")}${period}`; };

type SCell = { state: "free" | "booked" | "buffer"; label: string; sub?: string };

function buildCells(windowStart: number, windowEnd: number, bookings: { s: number; e: number; label: string }[], buffer: number, duration: number): SCell[] {
  if (windowEnd <= windowStart) return [];
  const sorted = [...bookings].sort((a, b) => a.s - b.s);
  const out: SCell[] = [];
  let cursor = windowStart;
  const emitFree = (until: number) => { while (cursor + duration <= until) { out.push({ state: "free", label: formatLabel(cursor) }); cursor += duration; } };
  for (const b of sorted) {
    if (b.e <= windowStart || b.s >= windowEnd) continue;
    emitFree(b.s);
    const bs = Math.max(windowStart, b.s), be = Math.min(windowEnd, b.e);
    out.push({ state: "booked", label: `${formatLabel(bs)}–${formatLabel(be)}`, sub: b.label });
    if (buffer > 0 && be < windowEnd) { const bufEnd = Math.min(windowEnd, be + buffer); out.push({ state: "buffer", label: `+${bufEnd - be}m` }); }
    cursor = Math.max(cursor, be + buffer);
  }
  emitFree(windowEnd);
  return out;
}

const HORIZON = 30;
const DEFAULT_WINDOW: [number, number] = [9 * 60, 21 * 60]; // placeholder when no hours set
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const toISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const formatDay = (d: Date) => d.toLocaleDateString("en-IN", { weekday: "short", month: "short", day: "numeric" });

/** A scheduled trip (real booking) placed on a given day. */
type Trip = { start: string; end: string; label: string };

/** Resolve a date's open window from the driver's weekly working hours.
 *  - No schedule at all (`hasSchedule` false) → the 9–9 placeholder window.
 *  - Schedule exists but this weekday isn't an open window → null (Closed):
 *    a day the driver didn't enable is a day off, whether stored as null or
 *    simply omitted by the editor. */
function windowForDate(d: Date, wh: Record<string, [string, string] | null> | undefined, hasSchedule: boolean): { start: number; end: number } | null {
  const key = WEEKDAY_KEYS[d.getDay()];
  const slot = wh ? wh[key] : undefined;
  if (Array.isArray(slot) && slot.length === 2) {
    const s = parseHHMM(slot[0]), e = parseHHMM(slot[1]);
    if (s != null && e != null && e > s) return { start: s, end: e };
  }
  if (!hasSchedule) return { start: DEFAULT_WINDOW[0], end: DEFAULT_WINDOW[1] };
  return null; // schedule set, this weekday not enabled → closed
}

function Strip({ caption, windowStart, windowEnd, trips, buffer }: { caption: string; windowStart: number; windowEnd: number; trips: { start: string; end: string; label: string }[]; buffer: number }) {
  const cells = useMemo(() => buildCells(windowStart, windowEnd, trips.map((b) => ({ s: parseHHMM(b.start)!, e: parseHHMM(b.end)!, label: b.label })), buffer, 60), [trips, windowStart, windowEnd, buffer]);
  return (
    <View style={styles.day}>
      <View style={styles.dayHead}>
        <Text style={styles.dayCaption}>{caption}</Text>
        <Text style={styles.dayHours}>{formatLabel(windowStart)} – {formatLabel(windowEnd)}</Text>
      </View>
      <View style={styles.cells}>
        {cells.map((c, i) => (
          <View key={i} style={[styles.cell, styles["cell_" + c.state as "cell_free"]]}>
            <Text style={[styles.cellTxt, styles["txt_" + c.state as "txt_free"]]}>{c.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export function DashSchedule({ name, listingId, workingHours, bufferMinutes = 15, bookings = [], onClose }: {
  name: string;
  listingId?: string;
  /** Driver's weekly hours — drives each day's open window. */
  workingHours?: Record<string, [string, string] | null>;
  bufferMinutes?: number;
  /** Real upcoming bookings for THIS listing (already scoped by caller). */
  bookings?: Array<{ scheduledDate?: string; endDate?: string; startTime?: string; endTime?: string; label?: string; status?: string }>;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const days = useMemo(() => { const start = new Date(); start.setHours(0, 0, 0, 0); return Array.from({ length: HORIZON }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; }); }, []);

  // No schedule = no weekday carries a window. Drives the placeholder banner.
  const hasSchedule = !!workingHours && Object.values(workingHours).some((v) => Array.isArray(v) && v.length === 2);

  // Real bookings indexed by date → trips (excludes cancelled). A trip with no
  // end time gets a nominal 1-hour block so it still shades the grid.
  // Multi-day rentals store ONE row with an EXCLUSIVE end_date (last rented
  // day + 1) — expand it so EVERY rented day is shaded, not just the start
  // (a 17–19 Jun rental previously only blocked the 17th on this screen).
  const tripsByDate = useMemo(() => {
    const map: Record<string, Trip[]> = {};
    for (const b of bookings) {
      if (!b.scheduledDate || b.status === "cancelled") continue;
      const s = b.startTime || "09:00";
      const sMin = parseHHMM(s);
      const e = b.endTime || (sMin != null ? formatHHMM(sMin + 60) : "10:00");
      const trip: Trip = { start: s, end: e, label: b.label || t("m.dashsched.bookedTrip", { defaultValue: "Booked trip" }) };
      if (b.endDate && b.endDate > b.scheduledDate) {
        const end = new Date(`${b.endDate}T00:00:00`);
        for (let d = new Date(`${b.scheduledDate}T00:00:00`); d < end; d = new Date(d.getTime() + 86400000)) {
          (map[toISO(d)] ||= []).push(trip);
        }
      } else {
        (map[b.scheduledDate] ||= []).push(trip);
      }
    }
    return map;
  }, [bookings, t]);

  // Hydrate blocked days from the backend (real listings only).
  useEffect(() => {
    if (!listingId) return;
    fetchAvailability(listingId).then((rows) => setBlocked(new Set(rows.filter((r) => r.blocked).map((r) => r.date)))).catch(() => {});
  }, [listingId]);

  const toggle = (iso: string) => {
    const wasBlocked = blocked.has(iso);
    setBlocked((prev) => { const n = new Set(prev); wasBlocked ? n.delete(iso) : n.add(iso); return n; });
    if (listingId) {
      // block → {blocked:true}; unblock → clear ({blocked:false, pricePaise:null})
      setAvailability(listingId, [{ date: iso, blocked: !wasBlocked, pricePaise: null }]).catch(() => {
        setBlocked((prev) => { const n = new Set(prev); wasBlocked ? n.add(iso) : n.delete(iso); return n; });
      });
    }
  };

  return (
    <View style={[styles.lob, { paddingTop: insets.top }]}>
      <View style={styles.head}>
        <IconBtn name="x" onPress={onClose} />
        <View style={{ flex: 1 }}>
          <Text style={styles.headTitle} numberOfLines={1}>{t("m.dashsched.headerTitle", { defaultValue: "{{name}} — Schedule", name })}</Text>
          <Text style={styles.headSub}>{t("m.dashsched.headerSub", { defaultValue: "Next {{days}} days · {{buffer}} min buffer between trips", days: HORIZON, buffer: bufferMinutes })}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        {!hasSchedule && (
          <View style={styles.banner}>
            <Icon name="info" size={16} color={T.terra} />
            <Text style={styles.bannerTxt}>{t("m.dashsched.noScheduleBanner", { defaultValue: "No weekly schedule set yet — showing 9 AM–9 PM daily as a placeholder. Open Edit to set the days and hours you actually drive." })}</Text>
          </View>
        )}
        <Text style={styles.hint}>{t("m.dashsched.hint", { defaultValue: "Booked trips are shaded; free hours are green. Tap Block day to take a day off — customers can't book it." })}</Text>
        <View style={{ gap: 10 }}>
          {days.map((d) => {
            const iso = toISO(d);
            const isBlocked = blocked.has(iso);
            const win = windowForDate(d, workingHours, hasSchedule);
            const closed = win === null; // weekday the driver doesn't work
            const trips = isBlocked || closed ? [] : tripsByDate[iso] || [];
            return (
              <View key={iso} style={[styles.wrap, (isBlocked || closed) && { opacity: 0.7 }]}>
                {!closed && (
                  <View style={{ flexDirection: "row", justifyContent: "flex-end", marginBottom: 6 }}>
                    <Pressable style={[styles.blockBtn, isBlocked && styles.blockOn]} onPress={() => toggle(iso)}>
                      <Icon name="x" size={12} color={isBlocked ? "#2f7d55" : T.muted} />
                      <Text style={[styles.blockTxt, isBlocked && { color: "#2f7d55" }]}>{isBlocked ? t("m.dashsched.unblockDay", { defaultValue: "Unblock day" }) : t("m.dashsched.blockDay", { defaultValue: "Block day" })}</Text>
                    </Pressable>
                  </View>
                )}
                {closed ? (
                  <View style={styles.blockedRow}>
                    <Text style={styles.blockedDay}>{formatDay(d)}</Text>
                    <Text style={styles.blockedTxt}>{t("m.dashsched.closed", { defaultValue: "Closed — not in your working days." })}</Text>
                  </View>
                ) : isBlocked ? (
                  <View style={styles.blockedRow}>
                    <Text style={styles.blockedDay}>{formatDay(d)}</Text>
                    <Text style={styles.blockedTxt}>{t("m.dashsched.dayBlocked", { defaultValue: "Day blocked — customers can't book." })}</Text>
                  </View>
                ) : (
                  <Strip caption={formatDay(d)} windowStart={win!.start} windowEnd={win!.end} trips={trips} buffer={bufferMinutes} />
                )}
              </View>
            );
          })}
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
  banner: { flexDirection: "row", gap: 8, alignItems: "flex-start", borderWidth: 1, borderColor: "rgba(189,135,82,0.4)", backgroundColor: "rgba(189,135,82,0.1)", borderRadius: 12, padding: 12, marginBottom: 12 },
  bannerTxt: { flex: 1, fontSize: 12, lineHeight: 17, color: T.ink, fontFamily: font.body },
  hint: { color: T.muted, fontSize: 12, lineHeight: 17, marginBottom: 12, fontFamily: font.body },
  wrap: {},
  blockBtn: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 11, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  blockOn: { borderColor: "rgba(47,125,85,0.4)", backgroundColor: "rgba(47,125,85,0.08)" },
  blockTxt: { fontSize: 11, fontFamily: font.bodyHeavy, color: T.muted },
  blockedRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, borderWidth: 1, borderColor: "rgba(164,93,98,0.4)", backgroundColor: "rgba(164,93,98,0.07)", borderRadius: 10, padding: 12 },
  blockedDay: { fontFamily: font.bodyBold, fontSize: 12, color: T.coral },
  blockedTxt: { fontSize: 12, color: T.coral, fontFamily: font.body },
  day: { borderWidth: 1, borderColor: T.line, borderRadius: 12, backgroundColor: "#fff", padding: 12 },
  dayHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  dayCaption: { fontFamily: font.bodyBold, fontSize: 12, color: T.ink },
  dayHours: { fontSize: 12, color: T.muted, fontFamily: font.body },
  cells: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  cell: { minWidth: 54, height: 32, paddingHorizontal: 6, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: 1 },
  cell_free: { backgroundColor: "rgba(47,125,85,0.1)", borderColor: "rgba(47,125,85,0.28)" },
  cell_booked: { backgroundColor: "rgba(164,93,98,0.14)", borderColor: "rgba(164,93,98,0.35)" },
  cell_buffer: { backgroundColor: "rgba(189,135,82,0.16)", borderColor: "rgba(189,135,82,0.4)" },
  cellTxt: { fontSize: 11, fontFamily: font.bodyBold },
  txt_free: { color: "#2f7d55" },
  txt_booked: { color: T.coral },
  txt_buffer: { color: "#8b5e4a" },
});
