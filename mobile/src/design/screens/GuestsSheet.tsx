// design/screens/GuestsSheet.tsx — dedicated "Who" guests stepper popup.
// The Airbnb-style search header's Who control. A small bottom sheet (same Modal
// + scrim + handle pattern as FilterSheet) with a − / + stepper that edits the
// minimum-guests value. Single source of truth for guests now lives here (the
// guests slider was removed from FilterSheet); the committed value drives
// `filters.guests` → `stayPass` in ExploreScreen. 1 = "Any".
import React, { useEffect, useState } from "react";
import { View, Text, Pressable, Modal, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Icon } from "../Icon";
import { IconBtn } from "../primitives";
import { T, font } from "../theme";
import { useLanguage } from "@/contexts/LanguageContext";

const MIN_GUESTS = 1; // 1 = "Any" (no constraint)
const MAX_GUESTS = 16;

export function GuestsSheet({ visible, value, onApply, onClose }: {
  visible: boolean;
  value: number;
  onApply: (n: number) => void;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const noun = t("m.search.guestsTitle", { defaultValue: "Guests" });
  const subtitle = t("m.search.guestsSubtitle", { defaultValue: "Minimum per stay" });
  const insets = useSafeAreaInsets();
  const [n, setN] = useState(value);
  useEffect(() => { if (visible) setN(value); }, [visible]); // re-seed on open

  const dec = () => setN((v) => Math.max(MIN_GUESTS, v - 1));
  const inc = () => setN((v) => Math.min(MAX_GUESTS, v + 1));
  const atMin = n <= MIN_GUESTS;
  const atMax = n >= MAX_GUESTS;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={s.handle} />
        <View style={s.headRow}>
          <Text style={s.title}>{noun}</Text>
          <IconBtn name="x" onPress={onClose} bare />
        </View>

        <View style={s.stepRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.stepLabel}>{noun}</Text>
            <Text style={s.stepSub}>{subtitle}</Text>
          </View>
          <View style={s.stepper}>
            <Pressable
              onPress={dec}
              disabled={atMin}
              style={({ pressed }: any) => [s.stepBtn, atMin && s.stepBtnOff, pressed && !atMin && { opacity: 0.7 }]}
              accessibilityLabel={t("m.search.guestsDec", { defaultValue: "Fewer guests" })}
            >
              <Icon name="minus" size={18} color={atMin ? "rgba(58,50,71,0.3)" : T.aubergine} />
            </Pressable>
            <Text style={s.stepNum}>{n <= MIN_GUESTS ? t("m.search.guestsAny", { defaultValue: "Any" }) : String(n)}</Text>
            <Pressable
              onPress={inc}
              disabled={atMax}
              style={({ pressed }: any) => [s.stepBtn, atMax && s.stepBtnOff, pressed && !atMax && { opacity: 0.7 }]}
              accessibilityLabel={t("m.search.guestsInc", { defaultValue: "More guests" })}
            >
              <Icon name="plus" size={18} color={atMax ? "rgba(58,50,71,0.3)" : T.aubergine} />
            </Pressable>
          </View>
        </View>

        <View style={s.footer}>
          <Pressable style={({ pressed }: any) => [s.ghost, pressed && { opacity: 0.8 }]} onPress={() => setN(MIN_GUESTS)}>
            <Text style={s.ghostTxt}>{t("m.search.reset", { defaultValue: "Reset" })}</Text>
          </Pressable>
          <Pressable style={({ pressed }: any) => [s.apply, pressed && { opacity: 0.9 }]} onPress={() => { onApply(n); onClose(); }}>
            <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.applyInner}>
              <Text style={s.applyTxt}>{t("m.search.done", { defaultValue: "Done" })}</Text>
            </LinearGradient>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(23,20,29,0.5)" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: "#faf8fa", borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 8 },
  handle: { width: 42, height: 5, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.2)", alignSelf: "center", marginBottom: 8 },
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6, marginBottom: 4 },
  title: { fontSize: 20, fontFamily: font.head, color: T.ink },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 16, paddingVertical: 22 },
  stepLabel: { fontSize: 16, fontFamily: font.headHeavy, color: T.ink },
  stepSub: { fontSize: 13, fontFamily: font.body, color: T.muted, marginTop: 3 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 14 },
  stepBtn: { width: 40, height: 40, borderRadius: 999, alignItems: "center", justifyContent: "center", borderWidth: 1.4, borderColor: T.aubergine, backgroundColor: "#fff" },
  stepBtnOff: { borderColor: "rgba(58,50,71,0.22)" },
  stepNum: { minWidth: 44, textAlign: "center", fontSize: 18, fontFamily: font.headHeavy, color: T.ink },
  footer: { flexDirection: "row", gap: 12, paddingTop: 12, marginTop: 4, borderTopWidth: 1, borderTopColor: T.line },
  ghost: { flex: 1, minHeight: 54, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.6)" },
  ghostTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 16 },
  apply: { flex: 2, borderRadius: 18, overflow: "hidden" },
  applyInner: { minHeight: 54, alignItems: "center", justifyContent: "center" },
  applyTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 16 },
});
