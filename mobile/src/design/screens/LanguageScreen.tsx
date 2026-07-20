// design/screens/LanguageScreen.tsx — pick the app display language.
// Selection persists via LanguageContext (AsyncStorage) and re-renders all screens.
import React from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../Icon";
import { AppBar } from "../primitives";
import { Background } from "../Background";
import { T, font } from "../theme";
import { useLanguage, languages } from "@/contexts/LanguageContext";

export function LanguageScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { language, setLanguage, t } = useLanguage();

  return (
    <Background>
      <View style={{ paddingTop: insets.top }}>
        <AppBar title={t("m.language.title", { defaultValue: "Language" })} onBack={() => nav.goBack()} />
      </View>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 32 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.hint}>
          {t("m.language.hint", { defaultValue: "Choose the language for buttons, labels, and menus." })}
        </Text>
        <View style={styles.card}>
          {languages.map((lng, i) => {
            const active = lng.code === language;
            return (
              <Pressable
                key={lng.code}
                onPress={() => setLanguage(lng.code)}
                style={({ pressed }: any) => [
                  styles.row,
                  i < languages.length - 1 && styles.rowDivider,
                  pressed && { backgroundColor: "rgba(58,50,71,0.06)" },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.native}>{lng.nativeName}</Text>
                  <Text style={styles.name}>{lng.name}</Text>
                </View>
                {active ? <Icon name="check" size={20} color={T.aubergine} /> : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </Background>
  );
}

const styles = StyleSheet.create({
  hint: { fontFamily: font.body, fontSize: 13, color: T.muted, marginBottom: 14, lineHeight: 19 },
  card: { backgroundColor: "#fff", borderRadius: 18, borderWidth: 1, borderColor: T.line, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 15 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: T.line },
  native: { fontFamily: font.bodySemi, fontSize: 16, color: T.ink },
  name: { fontFamily: font.body, fontSize: 12.5, color: T.muted, marginTop: 2 },
});
