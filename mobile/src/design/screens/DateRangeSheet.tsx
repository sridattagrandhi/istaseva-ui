// design/screens/DateRangeSheet.tsx — stays check-in/check-out range picker.
// Mobile counterpart of the web DateRangePopover. Bottom sheet (same Modal +
// scrim + handle pattern as FilterSheet) wrapping a react-native-calendars
// Calendar in period-marking mode. Controlled: edits a local draft and only
// commits via onApply; Clear resets to an open range.
import React, { useEffect, useState } from "react";
import { View, Text, Pressable, Modal, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Calendar } from "react-native-calendars";
import { IconBtn } from "../primitives";
import { T, font } from "../theme";
import { ymd, istTodayYMD } from "../api/bookings";
import { useLanguage } from "@/contexts/LanguageContext";

export type DateRange = { start: string | null; end: string | null };

const RANGE_FILL = "rgba(139,94,74,0.16)";

/** Period-marking object for react-native-calendars from a start/end pair. */
function buildMarked(start: string | null, end: string | null): Record<string, any> {
  if (!start) return {};
  if (!end) return { [start]: { startingDay: true, endingDay: true, color: T.terra, textColor: "#fff" } };
  const marked: Record<string, any> = {};
  const cur = new Date(`${start}T00:00:00`);
  const last = new Date(`${end}T00:00:00`);
  while (cur <= last) {
    marked[ymd(cur)] = { color: RANGE_FILL, textColor: T.ink };
    cur.setDate(cur.getDate() + 1);
  }
  marked[start] = { startingDay: true, color: T.terra, textColor: "#fff" };
  marked[end] = { endingDay: true, color: T.terra, textColor: "#fff" };
  return marked;
}

export function DateRangeSheet({ visible, value, onApply, onClose, title, minDate, maxDate }: {
  visible: boolean;
  value: DateRange;
  onApply: (r: DateRange) => void;
  onClose: () => void;
  /** Sheet heading; defaults to the stays check-in/check-out title. */
  title?: string;
  /** Earliest selectable day. Defaults to today (stays semantics); pass
   *  `null` to allow past dates (admin filters / analytics ranges). */
  minDate?: string | null;
  /** Latest selectable day (e.g. today for historical analytics ranges). */
  maxDate?: string;
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<DateRange>(value);
  useEffect(() => { if (visible) setDraft(value); }, [visible]); // re-seed on open

  // Check-in / check-out semantics: first tap (or a tap before the current
  // start, or a tap once a full range exists) sets a fresh check-in; the next
  // tap on/after it sets check-out.
  const onDay = (day: { dateString: string }) => {
    const d = day.dateString;
    setDraft((p) => {
      if (!p.start || p.end || d < p.start) return { start: d, end: null };
      return { start: p.start, end: d };
    });
  };

  const apply = () => { onApply(draft); onClose(); };
  const clear = () => setDraft({ start: null, end: null });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={s.handle} />
        <View style={s.headRow}>
          <Text style={s.title}>{title ?? t("m.search.datesTitle", { defaultValue: "Check-in / Check-out" })}</Text>
          <IconBtn name="x" onPress={onClose} bare />
        </View>
        <Calendar
          minDate={minDate === null ? undefined : (minDate ?? istTodayYMD())}
          maxDate={maxDate}
          markingType="period"
          markedDates={buildMarked(draft.start, draft.end)}
          onDayPress={onDay}
          enableSwipeMonths
          theme={{
            calendarBackground: "transparent",
            textSectionTitleColor: T.muted,
            monthTextColor: T.ink,
            dayTextColor: T.ink,
            textDisabledColor: "rgba(58,50,71,0.28)",
            arrowColor: T.terra,
            todayTextColor: T.terra,
            textMonthFontFamily: font.head,
            textDayFontFamily: font.bodySemi,
            textDayHeaderFontFamily: font.bodyBold,
          }}
        />
        <View style={s.footer}>
          <Pressable style={({ pressed }: any) => [s.ghost, pressed && { opacity: 0.8 }]} onPress={clear}>
            <Text style={s.ghostTxt}>{t("m.search.datesClear", { defaultValue: "Clear" })}</Text>
          </Pressable>
          <Pressable style={({ pressed }: any) => [s.apply, pressed && { opacity: 0.9 }]} onPress={apply}>
            <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.applyInner}>
              <Text style={s.applyTxt}>{t("m.search.datesApply", { defaultValue: "Apply dates" })}</Text>
            </LinearGradient>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(23,20,29,0.5)" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "88%", backgroundColor: "#faf8fa", borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 8 },
  handle: { width: 42, height: 5, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.2)", alignSelf: "center", marginBottom: 8 },
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6, marginBottom: 4 },
  title: { fontSize: 20, fontFamily: font.head, color: T.ink },
  footer: { flexDirection: "row", gap: 12, paddingTop: 12, marginTop: 8, borderTopWidth: 1, borderTopColor: T.line },
  ghost: { flex: 1, minHeight: 54, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.6)" },
  ghostTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 16 },
  apply: { flex: 2, borderRadius: 18, overflow: "hidden" },
  applyInner: { minHeight: 54, alignItems: "center", justifyContent: "center" },
  applyTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 16 },
});
