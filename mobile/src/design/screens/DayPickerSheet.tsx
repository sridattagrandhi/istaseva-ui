// design/screens/DayPickerSheet.tsx — single-day picker for the services /
// transport Explore segments (a service is booked for ONE day, not a night
// range). Same bottom-sheet anatomy as DateRangeSheet, but single-select. The
// chosen day filters the catalog server-side (fully-booked listings drop out).
import React, { useEffect, useState } from "react";
import { View, Text, Pressable, Modal, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Calendar } from "react-native-calendars";
import { IconBtn } from "../primitives";
import { T, font } from "../theme";
import { istTodayYMD } from "../api/bookings";
import { useLanguage } from "@/contexts/LanguageContext";

export function DayPickerSheet({ visible, value, onApply, onClose, title }: {
  visible: boolean;
  value: string | null;
  onApply: (day: string | null) => void;
  onClose: () => void;
  title?: string;
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<string | null>(value);
  useEffect(() => { if (visible) setDraft(value); }, [visible]); // re-seed on open

  const apply = () => { onApply(draft); onClose(); };
  const clear = () => setDraft(null);
  const marked = draft ? { [draft]: { selected: true, selectedColor: T.terra, selectedTextColor: "#fff" } } : {};

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={s.handle} />
        <View style={s.headRow}>
          <Text style={s.title}>{title ?? t("m.search.dayTitle", { defaultValue: "Choose a day" })}</Text>
          <IconBtn name="x" onPress={onClose} bare />
        </View>
        <Calendar
          minDate={istTodayYMD()}
          markedDates={marked}
          onDayPress={(day: { dateString: string }) => setDraft(day.dateString)}
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
            <Text style={s.ghostTxt}>{t("m.search.dayClear", { defaultValue: "Clear" })}</Text>
          </Pressable>
          <Pressable style={({ pressed }: any) => [s.apply, pressed && { opacity: 0.9 }]} onPress={apply}>
            <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.applyInner}>
              <Text style={s.applyTxt}>{t("m.search.dayApply", { defaultValue: "Apply" })}</Text>
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
