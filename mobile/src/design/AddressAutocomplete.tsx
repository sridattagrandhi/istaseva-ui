// design/AddressAutocomplete.tsx — a text field with a live Google Places
// predictions dropdown (mirrors the web's location input). As the user types
// (>=3 chars, debounced) a list of place predictions drops down; tapping one
// fills the field and resolves lat/lng via place-details.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { Icon } from "./Icon";
import { useLanguage } from "@/contexts/LanguageContext";
import { T, font, noOutline } from "./theme";
import { placePredictions, placeDetails, PlacePrediction, PlaceDetails, AutocompleteMode } from "./api/geocode";

export function AddressAutocomplete({
  value,
  onChangeText,
  onPick,
  placeholder,
  icon = "mappin",
  containerStyle,
  mode,
  invalid,
}: {
  value: string;
  onChangeText: (t: string) => void;
  onPick: (description: string, details: PlaceDetails | null) => void;
  placeholder?: string;
  icon?: string;
  containerStyle?: any;
  /** "address" widens predictions to establishments (hotels, stations) —
   *  use for street-address / pickup fields. Default is region-only. */
  mode?: AutocompleteMode;
  /** Review-gate UX: renders the field with a red border when a required
   *  address is missing at "Review booking" time. */
  invalid?: boolean;
}) {
  const { t } = useLanguage();
  const [preds, setPreds] = useState<PlacePrediction[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNext = useRef(false); // don't re-query the value we just set on pick

  useEffect(() => {
    if (skipNext.current) { skipNext.current = false; return; }
    if (timer.current) clearTimeout(timer.current);
    const q = (value || "").trim();
    if (q.length < 3) { setPreds([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      const list = await placePredictions(q, mode);
      setPreds(list);
      setOpen(list.length > 0);
      setLoading(false);
    }, 280);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [value, mode]);

  const pick = async (pr: PlacePrediction) => {
    skipNext.current = true;
    onChangeText(pr.description);
    setOpen(false);
    setPreds([]);
    const details = await placeDetails(pr.id);
    onPick(pr.description, details);
  };

  return (
    <View style={[{ position: "relative", zIndex: 20 }, containerStyle]}>
      <View style={[ac.field, invalid && ac.fieldInvalid]}>
        <Icon name={icon} size={17} color={T.terra} />
        <TextInput
          style={ac.input}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder ?? t("m.address.placeholder", { defaultValue: "City, area, landmark" })}
          placeholderTextColor={T.muted}
          autoCorrect={false}
          onFocus={() => preds.length > 0 && setOpen(true)}
        />
        {loading && <ActivityIndicator size="small" color={T.muted} />}
      </View>
      {open && preds.length > 0 && (
        <View style={ac.dropdown}>
          {preds.map((pr) => (
            <Pressable key={pr.id} onPress={() => pick(pr)} style={({ pressed }) => [ac.row, pressed && { backgroundColor: "rgba(58,50,71,0.06)" }]}>
              <Icon name="mappin" size={15} color={T.muted} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={ac.main} numberOfLines={1}>{pr.mainText || pr.description}</Text>
                {!!pr.secondaryText && <Text style={ac.sub} numberOfLines={1}>{pr.secondaryText}</Text>}
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const ac = StyleSheet.create({
  field: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  fieldInvalid: { borderWidth: 1.5, borderColor: T.coral, backgroundColor: "rgba(164,93,98,0.04)" },
  input: { flex: 1, fontSize: 15, fontFamily: font.body, color: T.ink, paddingVertical: 0, ...noOutline },
  dropdown: { position: "absolute", top: 52, left: 0, right: 0, borderRadius: 14, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", overflow: "hidden", shadowColor: "#221f27", shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.16, shadowRadius: 24, elevation: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: "rgba(58,50,71,0.06)" },
  main: { fontSize: 14, fontFamily: font.bodyBold, color: T.ink },
  sub: { fontSize: 12, fontFamily: font.body, color: T.muted, marginTop: 1 },
});
