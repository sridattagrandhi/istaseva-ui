// dash/DashCalendar.tsx — stays availability & pricing overlay.
// Single-unit stays: listing-wide custom prices + blocked dates.
// Multi-room stays (hotel/lodge/heritage/sathram): a room-type switcher
// ("Listing-wide" + one tab per room) lets the host block dates / set custom
// prices PER room type — mirrors the web AvailabilityCalendar. Overrides are
// scoped by room_type_id (null = listing-wide) and saved in one PUT.
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Icon } from "../../Icon";
import { IconBtn } from "../../primitives";
import { T, font } from "../../theme";
import { useLanguage } from "@/contexts/LanguageContext";
import { fetchAvailability, setAvailability } from "../../api/dash";
import { istToday } from "../../api/bookings";
import { listRoomTypes, RoomTypeRow } from "../../api/roomTypes";

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const MULTI_ROOM_TYPES = new Set(["hotel", "lodge", "heritage", "sathram"]);

type Cell = { blocked?: boolean; price?: number | null };
// Override maps are keyed by `${scope}|${date}` where scope is the room id, or
// "_" for listing-wide. This lets one map hold every scope's pending edits.
const SCOPE_LISTING = "_";

export function DashCalendar({ name, listingId, propertyType, onClose }: { name: string; listingId?: string; propertyType?: string; onClose: () => void }) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  // Localized single-letter weekday headers (Sun..Sat), structure preserved.
  const WD_L = [
    t("m.dashcal.wd.sun", { defaultValue: "S" }),
    t("m.dashcal.wd.mon", { defaultValue: "M" }),
    t("m.dashcal.wd.tue", { defaultValue: "T" }),
    t("m.dashcal.wd.wed", { defaultValue: "W" }),
    t("m.dashcal.wd.thu", { defaultValue: "T" }),
    t("m.dashcal.wd.fri", { defaultValue: "F" }),
    t("m.dashcal.wd.sat", { defaultValue: "S" }),
  ];
  const multiRoom = MULTI_ROOM_TYPES.has(propertyType || "");
  const [cursor, setCursor] = useState(() => startOfMonth(istToday()));
  const [saved, setSaved] = useState<Record<string, Cell>>({});
  const [pending, setPending] = useState<Record<string, Cell>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [priceInput, setPriceInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [rooms, setRooms] = useState<RoomTypeRow[]>([]);
  // null = "Listing-wide" scope; a room id = that room type only.
  const [scope, setScope] = useState<string | null>(null);

  const key = (date: string) => `${scope ?? SCOPE_LISTING}|${date}`;

  // Room types power the switcher (multi-room stays only).
  useEffect(() => {
    if (!listingId || !multiRoom) return;
    listRoomTypes(listingId).then(setRooms).catch(() => {});
  }, [listingId, multiRoom]);

  // Hydrate existing overrides (every scope) from the backend.
  useEffect(() => {
    if (!listingId) return;
    fetchAvailability(listingId)
      .then((rows) => {
        const m: Record<string, Cell> = {};
        for (const r of rows) m[`${r.roomTypeId ?? SCOPE_LISTING}|${r.date}`] = { blocked: r.blocked, price: r.price };
        setSaved(m);
      })
      .catch(() => {});
  }, [listingId]);

  const today = ymd(istToday()); // IST, not device time — matches the backend
  const effective = (date: string): Cell | undefined => {
    const k = key(date);
    return pending[k] !== undefined ? pending[k] : saved[k];
  };

  const weeks = useMemo(() => {
    const first = startOfMonth(cursor);
    const last = endOfMonth(cursor);
    const leading = first.getDay();
    const days: { date: Date; inMonth: boolean }[] = [];
    for (let i = 0; i < leading; i++) { const d = new Date(first); d.setDate(d.getDate() - (leading - i)); days.push({ date: d, inMonth: false }); }
    for (let i = 1; i <= last.getDate(); i++) days.push({ date: new Date(cursor.getFullYear(), cursor.getMonth(), i), inMonth: true });
    while (days.length % 7 !== 0) { const d = new Date(days[days.length - 1].date); d.setDate(d.getDate() + 1); days.push({ date: d, inMonth: false }); }
    // Chunk into 7-day rows so each renders with flex:1 cells (a %-width grid
    // rounds over 100% and wraps the 7th day onto the next row).
    const out: { date: Date; inMonth: boolean }[][] = [];
    for (let i = 0; i < days.length; i += 7) out.push(days.slice(i, i + 7));
    return out;
  }, [cursor]);

  const monthLabel = cursor.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const pendingCount = Object.keys(pending).length;

  const openDay = (dateStr: string) => {
    if (dateStr < today) return;
    setEditing(dateStr);
    const eff = effective(dateStr);
    setPriceInput(eff && eff.price != null ? String(eff.price) : "");
  };

  const applyEdit = (action: "block" | "unblock" | "clear" | "price") => {
    if (!editing) return;
    const cur = effective(editing) || {};
    let next: Cell;
    if (action === "block") next = { blocked: true, price: cur.price ?? null };
    else if (action === "unblock") next = { blocked: false, price: cur.price ?? null };
    else if (action === "clear") next = { blocked: false, price: null };
    else { const n = Number(priceInput); if (!Number.isFinite(n) || n < 0) return; next = { blocked: cur.blocked ?? false, price: Math.round(n) }; }
    setPending((p) => ({ ...p, [key(editing)]: next }));
    setEditing(null);
  };

  const switchScope = (roomId: string | null) => { setScope(roomId); setEditing(null); };

  const save = async () => {
    const commit = () => {
      setSaved((sv) => {
        const merged = { ...sv };
        for (const [k, val] of Object.entries(pending)) {
          if (!val.blocked && val.price == null) delete merged[k];
          else merged[k] = val;
        }
        return merged;
      });
      setPending({});
    };
    if (listingId) {
      setSaving(true);
      try {
        const entries = Object.entries(pending).map(([k, v]) => {
          const sep = k.indexOf("|");
          const sc = k.slice(0, sep);
          const date = k.slice(sep + 1);
          return { date, blocked: !!v.blocked, pricePaise: v.price != null ? Math.round(v.price * 100) : null, roomTypeId: sc === SCOPE_LISTING ? null : sc };
        });
        await setAvailability(listingId, entries);
        commit();
      } catch (e) { console.warn("save availability failed", e); }
      finally { setSaving(false); }
    } else {
      commit();
    }
  };

  const effEditing = editing ? effective(editing) || {} : {};
  const scopeLabel = scope
    ? (rooms.find((r) => r.id === scope)?.name || t("m.dashcal.room", { defaultValue: "Room" }))
    : t("m.dashcal.listingWide", { defaultValue: "Listing-wide" });

  return (
    <View style={[styles.lob, { paddingTop: insets.top }]}>
      <View style={styles.head}>
        <IconBtn name="x" onPress={onClose} />
        <View style={{ flex: 1 }}>
          <Text style={styles.headTitle}>{t("m.dashcal.title", { defaultValue: "Calendar & pricing" })}</Text>
          <Text style={styles.headSub} numberOfLines={1}>{name}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 140 }} showsVerticalScrollIndicator={false}>
        <Text style={styles.intro}>
          {multiRoom
            ? t("m.dashcal.introMulti", { defaultValue: "Pick a room type, then block dates or set custom prices for it. “Listing-wide” applies to the whole property." })
            : t("m.dashcal.introSingle", { defaultValue: "Block dates you're unavailable and set custom prices per night." })}
        </Text>

        {multiRoom && rooms.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 14 }}>
            <Pressable onPress={() => switchScope(null)} style={[styles.scopeTab, scope === null && styles.scopeTabOn]}>
              <Icon name="globe" size={13} color={scope === null ? "#fff" : T.aubergine} />
              <Text style={[styles.scopeTxt, scope === null && { color: "#fff" }]}>{t("m.dashcal.listingWide", { defaultValue: "Listing-wide" })}</Text>
            </Pressable>
            {rooms.map((r) => (
              <Pressable key={r.id} onPress={() => switchScope(r.id)} style={[styles.scopeTab, scope === r.id && styles.scopeTabOn]}>
                <Icon name="bed" size={13} color={scope === r.id ? "#fff" : T.aubergine} />
                <Text style={[styles.scopeTxt, scope === r.id && { color: "#fff" }]} numberOfLines={1}>{r.name || t("m.dashcal.room", { defaultValue: "Room" })}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        <View style={styles.monthRow}>
          <IconBtn name="chevL" size={20} bare onPress={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} />
          <Text style={styles.monthLabel}>{monthLabel}</Text>
          <IconBtn name="chevR" size={20} bare onPress={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} />
        </View>

        <View style={styles.dow}>{WD_L.map((w, i) => <Text key={i} style={styles.dowTxt}>{w}</Text>)}</View>
        <View style={{ marginTop: 6 }}>
          {weeks.map((week, wi) => (
            <View key={wi} style={styles.week}>
              {week.map(({ date, inMonth }, di) => {
                const dateStr = ymd(date);
                const eff = effective(dateStr);
                const isPast = dateStr < today;
                const isPending = pending[key(dateStr)] !== undefined;
                const blocked = eff?.blocked;
                const price = eff && eff.price != null ? eff.price : null;
                return (
                  <Pressable
                    key={di}
                    disabled={isPast || !inMonth}
                    onPress={() => openDay(dateStr)}
                    style={[
                      styles.cell,
                      !inMonth && styles.cellOut,
                      isPast && { opacity: 0.4 },
                      !blocked && price != null && styles.cellPrice,
                      blocked && styles.cellBlocked,
                      isPending && styles.cellPending,
                    ]}
                  >
                    <Text style={[styles.cellNum, !inMonth && { color: "rgba(23,22,28,0.22)" }, blocked && { color: T.coral }, !blocked && price != null && { color: T.terra }]}>{date.getDate()}</Text>
                    {!blocked && price != null && <Text style={styles.cellSub}>₹{price >= 1000 ? price / 1000 + "k" : price}</Text>}
                    {blocked && <Text style={[styles.cellSub, { color: T.coral }]}>{t("m.dashcal.blocked", { defaultValue: "Blocked" })}</Text>}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>

        <View style={styles.legend}>
          {[["default", "Default", "#fff", T.line], ["customPrice", "Custom price", "rgba(139,94,74,0.2)", "rgba(139,94,74,0.4)"], ["blocked", "Blocked", "rgba(164,93,98,0.2)", "rgba(164,93,98,0.4)"]].map(([id, lb, bg, bd]) => (
            <View key={id} style={styles.legendItem}>
              <View style={[styles.sw, { backgroundColor: bg, borderColor: bd }]} />
              <Text style={styles.legendTxt}>{t(`m.dashcal.legend.${id}`, { defaultValue: lb })}</Text>
            </View>
          ))}
        </View>

        {editing && (
          <View style={styles.editor}>
            <View style={styles.editorHead}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.editorTitle}>{new Date(editing + "T00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</Text>
                {multiRoom && <Text style={styles.editorScope} numberOfLines={1}>{scopeLabel}</Text>}
              </View>
              <IconBtn name="x" size={16} bare onPress={() => setEditing(null)} />
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 12, alignItems: "center" }}>
              <View style={styles.mfPrefix}>
                <Text style={styles.mfRupee}>₹</Text>
                <TextInput style={styles.mfInput} keyboardType="number-pad" placeholder={t("m.dashcal.pricePlaceholder", { defaultValue: "Custom price / night" })} placeholderTextColor={T.muted} value={priceInput} onChangeText={(v) => setPriceInput(v.replace(/[^\d]/g, ""))} />
              </View>
              <Pressable style={[styles.miniBtn, !priceInput && { opacity: 0.4 }]} disabled={!priceInput} onPress={() => applyEdit("price")}><Text style={styles.miniTxt}>{t("m.dashcal.set", { defaultValue: "Set" })}</Text></Pressable>
            </View>
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              {effEditing.blocked ? (
                <Pressable style={styles.miniBtn} onPress={() => applyEdit("unblock")}><Text style={styles.miniTxt}>{t("m.dashcal.unblock", { defaultValue: "Unblock" })}</Text></Pressable>
              ) : (
                <Pressable style={styles.miniBtn} onPress={() => applyEdit("block")}><Text style={[styles.miniTxt, { color: T.coral }]}>{t("m.dashcal.blockDay", { defaultValue: "Block this day" })}</Text></Pressable>
              )}
              {(effEditing.blocked || effEditing.price != null) && (
                <Pressable style={styles.miniBtn} onPress={() => applyEdit("clear")}><Text style={styles.miniTxt}>{t("m.dashcal.resetDefault", { defaultValue: "Reset to default" })}</Text></Pressable>
              )}
            </View>
          </View>
        )}
      </ScrollView>

      <View style={[styles.cta, { bottom: Math.max(insets.bottom, 12) }]}>
        <Pressable style={styles.ghost} onPress={onClose}><Text style={styles.ghostTxt}>{t("m.dashcal.close", { defaultValue: "Close" })}</Text></Pressable>
        <Pressable style={[styles.save, (!pendingCount || saving) && { opacity: 0.5 }]} disabled={!pendingCount || saving} onPress={save}>
          <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.saveInner}>
            <Text style={styles.saveTxt}>{saving ? t("m.dashcal.saving", { defaultValue: "Saving…" }) : pendingCount ? t("m.dashcal.saveChanges", { defaultValue: "Save {{count}} changes", count: pendingCount }) : t("m.dashcal.saved", { defaultValue: "Saved" })}</Text>
          </LinearGradient>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  lob: { ...StyleSheet.absoluteFillObject, backgroundColor: T.bg, zIndex: 45 },
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface },
  headTitle: { fontSize: 16, fontFamily: font.head, color: T.ink },
  headSub: { fontSize: 12, color: T.muted, fontFamily: font.body },
  intro: { color: T.muted, fontSize: 13, lineHeight: 19, marginBottom: 14, fontFamily: font.body },
  scopeTab: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 13, borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.7)", maxWidth: 180 },
  scopeTabOn: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  scopeTxt: { fontSize: 12.5, fontFamily: font.bodyBold, color: T.aubergine },
  monthRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  monthLabel: { fontFamily: font.headHeavy, fontSize: 15, color: T.ink },
  dow: { flexDirection: "row", gap: 6 },
  dowTxt: { flex: 1, textAlign: "center", fontSize: 10, fontFamily: font.bodyHeavy, color: T.muted },
  week: { flexDirection: "row", gap: 6, marginBottom: 6 },
  cell: { flex: 1, aspectRatio: 1, borderRadius: 10, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", gap: 1 },
  cellOut: { backgroundColor: "transparent", borderColor: "transparent" },
  cellPrice: { backgroundColor: "rgba(139,94,74,0.12)", borderColor: "rgba(139,94,74,0.35)" },
  cellBlocked: { backgroundColor: "rgba(164,93,98,0.14)", borderColor: "rgba(164,93,98,0.4)" },
  cellPending: { borderWidth: 2, borderColor: T.saffron },
  cellNum: { fontSize: 13, fontFamily: font.bodyBold, color: T.ink },
  cellSub: { fontSize: 8.5, fontFamily: font.bodyBold, color: T.muted },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 16 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  sw: { width: 12, height: 12, borderRadius: 3, borderWidth: 1 },
  legendTxt: { fontSize: 11, color: T.muted, fontFamily: font.body },
  editor: { marginTop: 16, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.9)" },
  editorHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  editorTitle: { fontSize: 14, fontFamily: font.bodyBold, color: T.ink },
  editorScope: { fontSize: 11.5, fontFamily: font.bodyBold, color: T.terra, marginTop: 2 },
  mfPrefix: { flex: 1, flexDirection: "row", alignItems: "center", minHeight: 46, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", overflow: "hidden" },
  mfRupee: { paddingLeft: 14, paddingRight: 4, fontFamily: font.bodyHeavy, color: T.terra },
  mfInput: { flex: 1, paddingHorizontal: 12, minHeight: 46, fontSize: 14.5, fontFamily: font.bodySemi, color: T.ink },
  miniBtn: { minHeight: 38, paddingHorizontal: 14, borderRadius: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.6)" },
  miniTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 13 },
  cta: { position: "absolute", left: 12, right: 12, flexDirection: "row", gap: 12, padding: 12, borderRadius: 24, borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.97)", shadowColor: "#221f27", shadowOffset: { width: 0, height: 22 }, shadowOpacity: 0.2, shadowRadius: 40, elevation: 16 },
  ghost: { flex: 1, minHeight: 50, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.6)" },
  ghostTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 15 },
  save: { flex: 1.4, borderRadius: 16, overflow: "hidden" },
  saveInner: { minHeight: 50, alignItems: "center", justifyContent: "center" },
  saveTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 15 },
});
