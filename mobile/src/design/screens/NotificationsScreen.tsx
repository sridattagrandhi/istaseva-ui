// design/screens/NotificationsScreen.tsx — real in-app notifications when signed in; mock demo otherwise.
import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Background } from "../Background";
import { AppBar } from "../primitives";
import { Icon } from "../Icon";
import { T, font } from "../theme";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { Notif, fetchNotifications, markNotificationRead, markAllNotificationsRead } from "../api/notifications";

const TINT: Record<string, { bg: string; fg: string }> = {
  saffron: { bg: "rgba(189,135,82,0.16)", fg: "#8b5e4a" },
  coral: { bg: "rgba(164,93,98,0.16)", fg: "#a45d62" },
  blue: { bg: "rgba(97,122,146,0.16)", fg: "#617a92" },
  aubergine: { bg: "rgba(58,50,71,0.1)", fg: "#3a3247" },
};

export function NotificationsScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { t } = useLanguage();
  const [items, setItems] = useState<Notif[]>([]);

  useEffect(() => {
    if (!user) { setItems([]); return; }
    let alive = true;
    fetchNotifications().then((rows) => { if (alive) setItems(rows); }).catch(() => {});
    return () => { alive = false; };
  }, [user]);

  const anyUnread = items.some((n) => !n.read);

  const markAll = () => {
    if (!user || !anyUnread) return;
    setItems((p) => p.map((n) => ({ ...n, read: true })));
    markAllNotificationsRead().catch(() => {});
  };

  // Resolve a tapped notification to an in-app destination from its metadata.
  // Returns true when it navigated; false means "no known target" (we then
  // just mark it read). Booking notifications open the Bookings tab and pop the
  // matching booking's detail sheet; message notifications open the thread.
  const navigateFor = (n: Notif): boolean => {
    const md = n.metadata || {};
    if (md.bookingId) {
      nav.navigate("Tabs", { screen: "Bookings", params: { openBookingId: String(md.bookingId) } });
      return true;
    }
    if (n.type === "new_message" && md.senderId) {
      nav.navigate("Thread", { id: String(md.senderId) });
      return true;
    }
    return false;
  };

  const tap = (n: Notif) => {
    // Mark read and navigate are independent: re-tapping an already-read
    // notification should still take you to its target.
    if (!n.read) {
      setItems((p) => p.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      if (user) markNotificationRead(n.id).catch(() => {});
    }
    navigateFor(n);
  };

  return (
    <Background>
      <View style={{ paddingTop: insets.top }}>
        <AppBar title={t("m.notifications.title", { defaultValue: "Notifications" })} onBack={() => nav.goBack()} />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {anyUnread && (
          <Pressable onPress={markAll} style={({ pressed }: any) => [styles.markAll, pressed && { opacity: 0.7 }]}>
            <Icon name="checkSm" size={14} color={T.terra} strokeWidth={2.6} />
            <Text style={styles.markAllTxt}>{t("m.notifications.markAll", { defaultValue: "Mark all as read" })}</Text>
          </Pressable>
        )}
        <View style={{ gap: 10 }}>
          {items.map((n) => {
            const c = TINT[n.tone] || TINT.aubergine;
            return (
              <Pressable key={n.id} onPress={() => tap(n)} style={({ pressed }: any) => [styles.row, !n.read && styles.rowUnread, pressed && { opacity: 0.85 }]}>
                <View style={[styles.ico, { backgroundColor: c.bg }]}>
                  <Icon name={n.icon} size={20} color={c.fg} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.title}>{n.title}</Text>
                  <Text style={styles.sub}>{n.message}</Text>
                </View>
                <View style={{ alignItems: "flex-end", gap: 6 }}>
                  <Text style={styles.time}>{n.time}</Text>
                  {!n.read && <View style={styles.dot} />}
                </View>
              </Pressable>
            );
          })}
          {items.length === 0 && <Text style={styles.empty}>{t("m.notifications.empty", { defaultValue: "You're all caught up — no notifications yet." })}</Text>}
        </View>
      </ScrollView>
    </Background>
  );
}

const styles = StyleSheet.create({
  markAll: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-end", marginBottom: 12, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999 },
  markAllTxt: { fontFamily: font.bodyHeavy, fontSize: 12.5, color: T.terra },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 14, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.92)", borderWidth: 1, borderColor: "rgba(255,255,255,0.66)" },
  rowUnread: { backgroundColor: "rgba(255,255,255,0.98)", borderColor: "rgba(189,135,82,0.32)" },
  ico: { width: 42, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  title: { fontFamily: font.bodyBold, fontSize: 14, color: T.ink },
  sub: { fontFamily: font.body, fontSize: 13, color: T.muted, marginTop: 2, lineHeight: 18 },
  time: { fontFamily: font.body, fontSize: 12, color: T.muted },
  dot: { width: 8, height: 8, borderRadius: 99, backgroundColor: T.terra },
  empty: { fontFamily: font.body, fontSize: 13, color: T.muted, textAlign: "center", marginTop: 40 },
});
