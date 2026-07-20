// design/screens/MessagesScreen.tsx — conversation list, wired to /api/chat.
// Signed in → real conversations (+ a pinned AI assistant row). Signed out →
// the bundled demo threads so the prototype stays explorable.
import React from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { Background } from "../Background";
import { SectionHead } from "../primitives";
import { Icon } from "../Icon";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { fetchConversations, ago } from "../api/chat";
import { T, font, toneOf, Tone } from "../theme";

const TONES: Tone[] = ["saffron", "blue", "aubergine", "coral"];
const toneFor = (id: string) => TONES[[...String(id || "x")].reduce((a, c) => a + c.charCodeAt(0), 0) % TONES.length];

export function MessagesScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { t } = useLanguage();
  const q = useQuery({ queryKey: ["conversations"], queryFn: () => fetchConversations(), enabled: !!user, staleTime: 15_000, retry: 1 });

  const aiRow = (
    <Pressable style={styles.row} onPress={() => nav.navigate("AiChat", { path: "/messages" })}>
      <View style={[styles.avatar, { backgroundColor: toneOf("aubergine").soft }]}>
        <Icon name="bot" size={22} color={toneOf("aubergine").base} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.nameRow}><Text style={styles.name} numberOfLines={1}>{t("m.messages.assistantName", { defaultValue: "IstaSeva Assistant" })}</Text></View>
        <Text style={styles.role}>{t("m.messages.assistantRole", { defaultValue: "AI concierge" })}</Text>
        <Text style={styles.last} numberOfLines={1}>{t("m.messages.assistantLast", { defaultValue: "Plan a trip, find stays, book a cab…" })}</Text>
      </View>
      <Icon name="arrowR" size={18} color={T.muted} />
    </Pressable>
  );

  return (
    <Background>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: insets.top + 6, paddingBottom: 122 }}
        showsVerticalScrollIndicator={false}
      >
        <SectionHead title={t("m.messages.title", { defaultValue: "Messages" })} />
        <View style={{ gap: 10 }}>
          {aiRow}

          {user ? (
            q.isLoading ? (
              <ActivityIndicator color={T.aubergine} style={{ marginTop: 24 }} />
            ) : (q.data && q.data.length > 0) ? (
              q.data.map((m) => {
                const c = toneOf(toneFor(m.otherUserId));
                return (
                  <Pressable
                    key={m.otherUserId}
                    style={styles.row}
                    onPress={() => nav.navigate("Thread", { id: m.otherUserId, name: m.name })}
                  >
                    <View style={[styles.avatar, { backgroundColor: c.soft }]}>
                      <Icon name="message" size={22} color={c.base} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={styles.nameRow}>
                        <Text style={styles.name} numberOfLines={1}>{m.name}</Text>
                        <Text style={styles.time}>{ago(m.at)}</Text>
                      </View>
                      <Text style={styles.last} numberOfLines={1}>{m.last}</Text>
                    </View>
                    {m.unread > 0 && (
                      <View style={styles.badge}><Text style={styles.badgeTxt}>{m.unread}</Text></View>
                    )}
                  </Pressable>
                );
              })
            ) : (
              <View style={styles.empty}>
                <Icon name="message" size={26} color={T.muted} />
                <Text style={styles.emptyTxt}>{t("m.messages.emptyNone", { defaultValue: "No messages yet. Reach out to a host or provider from any listing." })}</Text>
              </View>
            )
          ) : (
            <View style={styles.empty}>
              <Icon name="message" size={26} color={T.muted} />
              <Text style={styles.emptyTxt}>{t("m.messages.emptySignIn", { defaultValue: "Sign in to message hosts and providers." })}</Text>
            </View>
          )}
        </View>
      </ScrollView>
    </Background>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row", alignItems: "center", gap: 14, padding: 14, borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.92)", borderWidth: 1, borderColor: "rgba(255,255,255,0.66)",
  },
  avatar: { width: 50, height: 50, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  nameRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  name: { fontFamily: font.head, fontSize: 15, color: T.ink, flexShrink: 1 },
  time: { fontFamily: font.body, fontSize: 11.5, color: T.muted },
  role: { fontFamily: font.bodySemi, fontSize: 11.5, color: T.terra, marginTop: 1 },
  last: { fontFamily: font.body, fontSize: 13, color: T.muted, marginTop: 3 },
  badge: { minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 999, backgroundColor: T.coral, alignItems: "center", justifyContent: "center" },
  badgeTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 11 },
  empty: { alignItems: "center", gap: 10, paddingVertical: 36, paddingHorizontal: 24 },
  emptyTxt: { fontFamily: font.body, fontSize: 13.5, color: T.muted, textAlign: "center", lineHeight: 20 },
});
