// design/screens/SimpleScreen.tsx — generic placeholder for not-yet-ported overlays.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Background } from "../Background";
import { AppBar } from "../primitives";
import { Icon } from "../Icon";
import { useLanguage } from "@/contexts/LanguageContext";
import { T, font } from "../theme";

export function SimpleScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const title = route.params?.title ?? t("m.simple.comingSoon", { defaultValue: "Coming soon" });
  return (
    <Background>
      <View style={{ paddingTop: insets.top }}>
        <AppBar title={title} onBack={() => nav.goBack()} />
      </View>
      <View style={styles.center}>
        <Icon name="wand" size={40} color={T.muted} />
        <Text style={styles.txt}>{t("m.simple.portedLater", { defaultValue: "{{title}} — ported in a later phase.", title })}</Text>
      </View>
    </Background>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 30 },
  txt: { color: T.muted, fontFamily: font.body, fontSize: 14, textAlign: "center" },
});
