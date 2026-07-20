// design/screens/HelpSupportScreen.tsx — Help & Support: tappable ways to
// reach us (call / email / AI assistant) + working hours. Reached from the
// Profile screen's "Help & support" row; mirrors the web Contact page's
// contact-information block using the shared support constants.
import React from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Linking } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../Icon";
import { AppBar } from "../primitives";
import { Background } from "../Background";
import { T, font } from "../theme";
import { useLanguage } from "@/contexts/LanguageContext";
import { SUPPORT_EMAIL, SUPPORT_PHONE } from "../support";

export function HelpSupportScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();

  const rows: { icon: string; title: string; sub: string; onPress: () => void }[] = [
    {
      icon: "phone",
      title: t("m.help.callUs", { defaultValue: "Call us" }),
      sub: SUPPORT_PHONE,
      onPress: () => { void Linking.openURL(`tel:${SUPPORT_PHONE.replace(/\s+/g, "")}`); },
    },
    {
      icon: "mail",
      title: t("m.help.emailUs", { defaultValue: "Email us" }),
      sub: SUPPORT_EMAIL,
      onPress: () => { void Linking.openURL(`mailto:${SUPPORT_EMAIL}`); },
    },
    {
      icon: "sparkle",
      title: t("m.help.askAssistant", { defaultValue: "Ask the AI assistant" }),
      sub: t("m.help.askAssistantSub", { defaultValue: "Instant answers about bookings, listings, and payments" }),
      onPress: () => nav.navigate("AiChat"),
    },
  ];

  return (
    <Background>
      <View style={{ paddingTop: insets.top }}>
        <AppBar title={t("m.help.title", { defaultValue: "Help & support" })} onBack={() => nav.goBack()} />
      </View>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 32 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.hint}>
          {t("m.help.hint", { defaultValue: "Questions about a booking, payment, or your listing? Reach us any of these ways." })}
        </Text>
        <View style={styles.card}>
          {rows.map((r, i) => (
            <Pressable
              key={r.title}
              onPress={r.onPress}
              style={({ pressed }: any) => [
                styles.row,
                i < rows.length - 1 && styles.rowDivider,
                pressed && { backgroundColor: "rgba(58,50,71,0.06)" },
              ]}
            >
              <View style={styles.rowIcon}><Icon name={r.icon} size={19} color={T.aubergine} /></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowTitle}>{r.title}</Text>
                <Text style={styles.rowSub} numberOfLines={2}>{r.sub}</Text>
              </View>
              <Icon name="chevR" size={18} color={T.muted} />
            </Pressable>
          ))}
        </View>
        <View style={styles.hoursCard}>
          <Icon name="clock" size={16} color={T.terra} />
          <Text style={styles.hoursTxt}>
            {t("m.help.workingHours", { defaultValue: "Support hours: Mon – Sat, 9 AM – 7 PM IST" })}
          </Text>
        </View>
      </ScrollView>
    </Background>
  );
}

const styles = StyleSheet.create({
  hint: { fontFamily: font.body, fontSize: 13, color: T.muted, marginBottom: 14, lineHeight: 19 },
  card: { backgroundColor: "#fff", borderRadius: 18, borderWidth: 1, borderColor: T.line, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 15 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: "rgba(58,50,71,0.08)" },
  rowIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: "rgba(58,50,71,0.08)", alignItems: "center", justifyContent: "center" },
  rowTitle: { fontFamily: font.bodyBold, fontSize: 14.5, color: T.ink },
  rowSub: { fontFamily: font.body, fontSize: 12.5, color: T.muted, marginTop: 2 },
  hoursCard: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.55)" },
  hoursTxt: { flex: 1, fontFamily: font.body, fontSize: 12.5, color: T.ink, lineHeight: 17 },
});
