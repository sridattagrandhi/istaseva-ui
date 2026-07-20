// design/screens/SearchSheet.tsx — full search bottom sheet (StreetEasy-style,
// search-first). Opens when the Explore search bar is tapped: segment pills,
// a focused search field (Google Places predictions for stays only — the
// per-segment gating invariant lives in ExploreScreen), the segment's recent
// searches (query left, date right), then Dates + Who tiles. Tapping Dates
// opens DateRangeSheet for every segment (stays = check-in/out nights;
// services & transport = an availability window, ANY-day server filter);
// Who opens GuestsSheet for stays; transport passengers are an inline
// stepper. The date/guest pickers are rendered NESTED inside this Modal —
// sibling RN Modals cannot stack on iOS (the second silently fails to
// present while the first is up), which is why they live here and not at the
// Explore level. Search values/setters stay in ExploreScreen and apply live;
// the CTA reports the current result count and closes.
import React, { useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Modal } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useLanguage } from "@/contexts/LanguageContext";
import { Icon } from "../Icon";
import { IconBtn, Segmented, Counter } from "../primitives";
import { T, font, noOutline } from "../theme";
import type { RecentSearch } from "../api/recentSearches";
import type { PlacePrediction } from "../api/geocode";
import { DateRangeSheet, DateRange } from "./DateRangeSheet";
import { GuestsSheet } from "./GuestsSheet";

export function SearchSheet({
  visible, onClose,
  seg, segOptions, onSeg,
  query, onQuery,
  picked, onClearPicked, preds, predOpen, onPickPlace,
  datesValue,
  stayRange, onApplyStayRange,
  dayRange, onApplyDayRange,
  guests, onApplyGuests,
  seats, onSeats,
  resultCount,
  recents, recentMain, recentSide, onApplyRecent, onRemoveRecent, onClearRecents,
}: {
  visible: boolean;
  onClose: () => void;
  seg: string;
  segOptions: [string, string, string][];
  onSeg: (s: string) => void;
  query: string;
  onQuery: (v: string) => void;
  picked: { label: string } | null;
  onClearPicked: () => void;
  preds: PlacePrediction[];
  predOpen: boolean;
  onPickPlace: (pr: PlacePrediction) => void;
  /** Pre-formatted dates label ("19–22 Jul" / "Sat, 19 Jul") or null. */
  datesValue: string | null;
  /** Stays check-in/out range + apply (Explore's handleDates, incl. analytics). */
  stayRange: DateRange;
  onApplyStayRange: (r: DateRange) => void;
  /** Services/transport availability window for the ACTIVE segment. */
  dayRange: DateRange;
  onApplyDayRange: (r: DateRange) => void;
  guests: number;
  onApplyGuests: (n: number) => void;
  seats: number;
  onSeats: (n: number) => void;
  resultCount: number;
  recents: RecentSearch[];
  /** Row main text (query/place + guests). */
  recentMain: (r: RecentSearch) => string;
  /** Right-aligned meta (the snapshotted date) or null. */
  recentSide: (r: RecentSearch) => string | null;
  onApplyRecent: (r: RecentSearch) => void;
  onRemoveRecent: (id: string) => void;
  onClearRecents: () => void;
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const isStays = seg === "stays";
  const isTransport = seg === "transport";
  // Nested-picker visibility — local to the sheet (see header comment).
  const [datesOpen, setDatesOpen] = useState(false);
  const [guestsOpen, setGuestsOpen] = useState(false);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={s.handle} />
        <View style={s.headRow}>
          <IconBtn name="x" size={19} onPress={onClose} accessibilityLabel={t("m.searchSheet.close", { defaultValue: "Close search" })} />
          <Text style={s.headTitle}>{t(`m.searchSheet.title.${seg}`, { defaultValue: seg === "stays" ? "Search stays" : seg === "services" ? "Search services" : "Search transport" })}</Text>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
          <View style={{ marginBottom: 14 }}>
            <Segmented options={segOptions} value={seg} onChange={onSeg} small />
          </View>

          {/* search field — focused state look, matches the app's inputs */}
          <View style={s.field}>
            <Icon name="search" size={19} color={T.terra} />
            <TextInput
              value={query}
              onChangeText={onQuery}
              placeholder={t("m.primitives.searchPlaceholder", { defaultValue: "Search stays, services, rides…" })}
              placeholderTextColor="rgba(101,114,109,0.8)"
              autoFocus
              autoCorrect={false}
              style={s.fieldInput}
            />
            {(query.length > 0 || picked) && (
              <IconBtn name="x" size={17} onPress={onClearPicked} bare accessibilityLabel={t("m.search.clearSearch", { defaultValue: "Clear search" })} />
            )}
          </View>
          {picked && (
            <View style={s.pickedChip}>
              <Icon name="mappin" size={13} color={T.terra} />
              <Text style={s.pickedTxt} numberOfLines={1}>{picked.label}</Text>
            </View>
          )}

          {/* stays-only Places predictions, inline under the field */}
          {predOpen && preds.length > 0 && (
            <View style={s.card}>
              {preds.map((pr, i) => (
                <Pressable key={pr.id} onPress={() => onPickPlace(pr)} style={({ pressed }) => [s.row, i > 0 && s.rowDivider, pressed && s.rowPressed]}>
                  <Icon name="mappin" size={16} color={T.muted} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.rowMain} numberOfLines={1}>{pr.mainText || pr.description}</Text>
                    {!!pr.secondaryText && <Text style={s.rowSub} numberOfLines={1}>{pr.secondaryText}</Text>}
                  </View>
                </Pressable>
              ))}
            </View>
          )}

          {/* recent searches — query left, snapshotted date right (mock B) */}
          {!predOpen && recents.length > 0 && (
            <>
              <View style={s.secRow}>
                <Text style={s.secLabel}>{t("m.search.recent", { defaultValue: "Recent searches" })}</Text>
                <Pressable onPress={onClearRecents} hitSlop={8}>
                  <Text style={s.secClear}>{t("m.search.clearRecents", { defaultValue: "Clear" })}</Text>
                </Pressable>
              </View>
              <View style={s.card}>
                {recents.map((r, i) => {
                  const side = recentSide(r);
                  return (
                    <Pressable key={r.id} onPress={() => onApplyRecent(r)} style={({ pressed }) => [s.row, i > 0 && s.rowDivider, pressed && s.rowPressed]}>
                      <Icon name="clock" size={16} color={T.muted} />
                      <Text style={s.rowMain} numberOfLines={1}>{recentMain(r)}</Text>
                      {!!side && <Text style={s.rowSide} numberOfLines={1}>{side}</Text>}
                      <Pressable onPress={() => onRemoveRecent(r.id)} hitSlop={8} accessibilityLabel={t("m.search.removeRecent", { defaultValue: "Remove recent search" })}>
                        <Icon name="x" size={14} color={T.muted} />
                      </Pressable>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}

          {/* Dates + Who tiles */}
          <View style={s.tilesRow}>
            <Pressable style={({ pressed }) => [s.tile, pressed && s.rowPressed]} onPress={() => setDatesOpen(true)}>
              <Text style={s.tileLabel}>{t("m.searchSheet.dates", { defaultValue: "Dates" })}</Text>
              <View style={s.tileValRow}>
                <Icon name="calendar" size={16} color={T.terra} />
                <Text style={[s.tileVal, !datesValue && s.tileValEmpty]} numberOfLines={1}>
                  {datesValue || t("m.searchSheet.datesAny", { defaultValue: "Any" })}
                </Text>
              </View>
            </Pressable>
            {isStays && (
              <Pressable style={({ pressed }) => [s.tile, pressed && s.rowPressed]} onPress={() => setGuestsOpen(true)}>
                <Text style={s.tileLabel}>{t("m.searchSheet.who", { defaultValue: "Who" })}</Text>
                <View style={s.tileValRow}>
                  <Icon name="users" size={16} color={T.terra} />
                  <Text style={s.tileVal} numberOfLines={1}>
                    {guests > 1
                      ? t("m.search.guestsCount", { defaultValue: "{{count}} guests", count: guests })
                      : t("m.search.guestsAny", { defaultValue: "Any" })}
                  </Text>
                </View>
              </Pressable>
            )}
            {isTransport && (
              <View style={s.tile}>
                <Text style={s.tileLabel}>{t("m.booking.passengers", { defaultValue: "Passengers" })}</Text>
                <View style={{ marginTop: 2 }}>
                  <Counter value={seats} min={1} max={20} onChange={onSeats} />
                </View>
              </View>
            )}
          </View>
        </ScrollView>

        <Pressable onPress={onClose} style={({ pressed }) => [s.cta, pressed && { transform: [{ scale: 0.98 }] }]}>
          <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.ctaInner}>
            <Icon name="search" size={18} color="#fff" />
            <Text style={s.ctaTxt}>{t("m.searchSheet.showResults", { defaultValue: "Show {{count}} results", count: resultCount })}</Text>
          </LinearGradient>
        </Pressable>
      </View>

      {/* Nested pickers — must live INSIDE this Modal to present on iOS. */}
      {isStays ? (
        <DateRangeSheet visible={datesOpen} value={stayRange} onApply={onApplyStayRange} onClose={() => setDatesOpen(false)} />
      ) : (
        <DateRangeSheet visible={datesOpen} value={dayRange} onApply={onApplyDayRange} onClose={() => setDatesOpen(false)} title={t("m.searchSheet.dates", { defaultValue: "Dates" })} />
      )}
      <GuestsSheet visible={guestsOpen} value={guests} onApply={onApplyGuests} onClose={() => setGuestsOpen(false)} />
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(23,20,29,0.5)" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "92%", backgroundColor: "#faf8fa", borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 8 },
  handle: { alignSelf: "center", width: 42, height: 5, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.2)", marginBottom: 8 },
  headRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 },
  headTitle: { fontFamily: font.head, fontSize: 20, color: T.ink },
  field: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1.5, borderColor: T.aubergine, backgroundColor: "#fff", marginBottom: 10 },
  fieldInput: { flex: 1, fontSize: 15, fontFamily: font.body, color: T.ink, paddingVertical: 0, ...noOutline },
  pickedChip: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: "rgba(139,94,74,0.4)", backgroundColor: "rgba(139,94,74,0.08)", marginBottom: 10 },
  pickedTxt: { fontFamily: font.bodySemi, fontSize: 12.5, color: T.terra, maxWidth: 240 },
  secRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4, marginBottom: 8, paddingHorizontal: 2 },
  secLabel: { fontFamily: font.bodyBold, fontSize: 11, letterSpacing: 0.7, color: T.muted, textTransform: "uppercase" },
  secClear: { fontFamily: font.bodySemi, fontSize: 12.5, color: T.terra },
  card: { backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: T.line, paddingHorizontal: 14, marginBottom: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 11, paddingVertical: 13 },
  rowDivider: { borderTopWidth: 1, borderTopColor: "rgba(23,22,28,0.06)" },
  rowPressed: { opacity: 0.75 },
  rowMain: { flex: 1, fontFamily: font.bodySemi, fontSize: 13.5, color: T.ink },
  rowSub: { fontFamily: font.body, fontSize: 12, color: T.muted, marginTop: 1 },
  rowSide: { fontFamily: font.body, fontSize: 12.5, color: T.muted },
  tilesRow: { flexDirection: "row", gap: 11, marginTop: 2, marginBottom: 14 },
  tile: { flex: 1, backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: T.line, paddingHorizontal: 14, paddingVertical: 12 },
  tileLabel: { fontFamily: font.bodySemi, fontSize: 10.5, letterSpacing: 0.5, color: T.muted, textTransform: "uppercase", marginBottom: 6 },
  tileValRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  tileVal: { flex: 1, fontFamily: font.headSemi, fontSize: 13.5, color: T.ink },
  tileValEmpty: { color: T.muted },
  cta: { marginTop: 2 },
  ctaInner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 54, borderRadius: 18 },
  ctaTxt: { fontFamily: font.bodyBold, fontSize: 14.5, color: "#fff" },
});
