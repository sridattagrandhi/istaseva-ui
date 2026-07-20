// design/screens/ProfileScreen.tsx — user card + dashboard switcher + menu (Phase 1 functional).
import React from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Image, Alert } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { Background } from "../Background";
import { Icon } from "../Icon";
import { useDesign } from "../DesignContext";
import { useCatalog, useGuestBookings } from "../api/hooks";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { fetchMyProfile } from "../api/users";
import { T, font } from "../theme";

const MENU: [string, string, string?][] = [
  ["badge", "Identity verification", "Kyc"],
  ["user", "Personal information", "ProfileEdit"],
  ["languages", "Language", "Language"],
  ["bell", "Notifications", "Notifications"],
  ["shield", "Privacy & safety", "Privacy"],
  ["headset", "Help & support", "HelpSupport"],
];

const DASHBOARDS: [string, string, string][] = [
  ["store", "Provider", "provider"],
  ["car", "Transport", "transport"],
  ["home", "Host", "host"],
];

export function ProfileScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { wish, bookings: localBookings } = useDesign();
  const { user, signOut, signOutAll } = useAuth();
  const profileQ = useQuery({ queryKey: ["profile"], queryFn: fetchMyProfile, enabled: !!user, staleTime: 30_000, retry: 1 });
  const profile = profileQ.data;

  // Real stats: current/upcoming bookings + saved listings that actually
  // resolve in the catalog (matches what the Bookings/Wishlist tabs show).
  const C = useCatalog();
  const guest = useGuestBookings();
  const allBookings = guest.fromBackend ? guest.bookings : localBookings;
  const upcomingCount = allBookings.filter((b) => b.status === "upcoming" || b.status === "confirmed").length;
  const savedCount =
    C.stays.filter((x) => wish.has(x.id)).length +
    C.services.filter((x) => wish.has(x.id)).length +
    C.transport.filter((x) => wish.has(x.id)).length;

  const displayName = profile?.displayName || user?.name || (user?.email ? user.email.split("@")[0] : t("m.profile.guest", { defaultValue: "User" }));
  const initials = displayName.split(/[\s.@]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "G";
  const subtitle = profile?.location || user?.phone || user?.email || t("m.profile.browsingAsGuest", { defaultValue: "Browsing as user" });

  const logout = async () => {
    try { await signOut(); } catch {}
    nav.reset({ index: 0, routes: [{ name: "Onboarding" }] });
  };

  const logoutAll = () => {
    Alert.alert(
      t("m.profile.logoutAll", { defaultValue: "Sign out all devices" }),
      t("m.profile.logoutAllConfirm", { defaultValue: "You'll be signed out everywhere and need to sign in again on each device." }),
      [
        { text: t("m.common.cancel", { defaultValue: "Cancel" }), style: "cancel" },
        {
          text: t("m.profile.logoutAll", { defaultValue: "Sign out all devices" }),
          style: "destructive",
          onPress: async () => {
            const revoked = await signOutAll();
            if (!revoked) {
              Alert.alert(
                t("m.profile.logoutAllPartialTitle", { defaultValue: "Signed out here" }),
                t("m.profile.logoutAllPartial", { defaultValue: "You're signed out on this device, but other devices may still be active. Try again when you're back online." })
              );
            }
            nav.reset({ index: 0, routes: [{ name: "Onboarding" }] });
          },
        },
      ]
    );
  };

  return (
    <Background>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: insets.top + 6, paddingBottom: 122 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.userCard}>
          {user ? (
            <Pressable style={styles.editBtn} onPress={() => nav.navigate("ProfileEdit")} hitSlop={10}>
              <Icon name="pencil" size={16} color={T.aubergine} />
            </Pressable>
          ) : null}
          <View style={styles.avatar}>
            {profile?.avatarUrl ? (
              <Image source={{ uri: profile.avatarUrl }} style={StyleSheet.absoluteFill as any} />
            ) : (
              <Text style={styles.avatarTxt}>{initials}</Text>
            )}
          </View>
          <Text style={styles.name}>{displayName}</Text>
          <View style={styles.phoneRow}>
            <Icon name={user ? "mail" : "user"} size={13} color={T.muted} />
            <Text style={styles.phone}>{subtitle}</Text>
            {user?.emailVerified || user?.phoneVerified ? (
              <View style={styles.verified}>
                <Icon name="badge" size={13} color={T.terra} />
                <Text style={styles.verifiedTxt}>{t("m.profile.verified", { defaultValue: "Verified" })}</Text>
              </View>
            ) : null}
          </View>
          <View style={styles.stats}>
            <Stat value={String(upcomingCount)} label={t("m.profile.statTrips", { defaultValue: "Bookings" })} onPress={() => nav.navigate("Tabs", { screen: "Bookings" })} />
            <Stat value={String(savedCount)} label={t("m.profile.statSaved", { defaultValue: "Saved" })} onPress={() => nav.navigate("Tabs", { screen: "Wishlist" })} />
          </View>
        </View>

        <Text style={styles.secLabel}>{t("m.profile.switchDashboard", { defaultValue: "Switch dashboard" })}</Text>
        <View style={styles.dashRow}>
          {DASHBOARDS.map(([ic, lb, role]) => (
            <Pressable key={role} style={styles.dashBtn} onPress={() => nav.navigate("Dashboard", { role })}>
              <Icon name={ic} size={22} color={T.aubergine} />
              <Text style={styles.dashTxt}>{t(`m.profile.dashboard.${role}`, { defaultValue: lb })}</Text>
            </Pressable>
          ))}
        </View>

        {user?.role === "admin" && (
          <>
            <Text style={styles.secLabel}>{t("m.profile.adminLabel", { defaultValue: "Admin" })}</Text>
            <View style={styles.menu}>
              <Pressable
                onPress={() => nav.navigate("Admin")}
                style={({ pressed, hovered }: any) => [styles.menuRow, hovered && { backgroundColor: "rgba(58,50,71,0.04)" }, pressed && { backgroundColor: "rgba(58,50,71,0.07)" }]}
              >
                <Icon name="chart" size={20} color={T.aubergine} />
                <Text style={styles.menuTxt}>{t("m.profile.menu.admin", { defaultValue: "Admin Dashboard" })}</Text>
                <Icon name="chevR" size={18} color={T.muted} />
              </Pressable>
            </View>
          </>
        )}

        <Text style={styles.secLabel}>{t("m.profile.account", { defaultValue: "Account" })}</Text>
        <View style={styles.menu}>
          {MENU.map(([ic, label, route], i) => (
            <Pressable
              key={label}
              onPress={() => route && nav.navigate(route)}
              style={({ pressed, hovered }: any) => [styles.menuRow, i < MENU.length - 1 && styles.menuDivider, hovered && { backgroundColor: "rgba(58,50,71,0.04)" }, pressed && { backgroundColor: "rgba(58,50,71,0.07)" }]}
            >
              <Icon name={ic} size={20} color={T.aubergine} />
              <Text style={styles.menuTxt}>{t(`m.profile.menu.${route ?? label}`, { defaultValue: label })}</Text>
              <Icon name="chevR" size={18} color={T.muted} />
            </Pressable>
          ))}
        </View>

        <Pressable
          style={({ pressed }: any) => [styles.logoutAll, pressed && { opacity: 0.8 }]}
          onPress={logoutAll}
        >
          <Icon name="shield" size={18} color={T.aubergine} />
          <Text style={styles.logoutAllTxt}>{t("m.profile.logoutAll", { defaultValue: "Sign out all devices" })}</Text>
        </Pressable>

        <Pressable
          style={({ pressed, hovered }: any) => [styles.logout, hovered && { backgroundColor: "rgba(164,93,98,0.06)" }, pressed && { opacity: 0.8 }]}
          onPress={logout}
        >
          <Icon name="logout" size={19} color={T.coral} />
          <Text style={styles.logoutTxt}>{t("m.profile.logout", { defaultValue: "Log out" })}</Text>
        </Pressable>
      </ScrollView>
    </Background>
  );
}

function Stat({ value, label, onPress }: { value: string; label: string; onPress?: () => void }) {
  return (
    <Pressable style={({ pressed }) => [styles.stat, pressed && onPress && { opacity: 0.55 }]} onPress={onPress} disabled={!onPress}>
      <Text style={styles.statVal}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  userCard: {
    alignItems: "center", padding: 22, borderRadius: 22, marginTop: 8,
    backgroundColor: "rgba(255,255,255,0.92)", borderWidth: 1, borderColor: "rgba(255,255,255,0.66)",
  },
  avatar: { width: 76, height: 76, borderRadius: 999, backgroundColor: T.aubergine, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  editBtn: { position: "absolute", top: 14, right: 14, width: 34, height: 34, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(58,50,71,0.07)" },
  avatarTxt: { color: "#fff", fontFamily: font.headHeavy, fontSize: 26 },
  name: { fontFamily: font.head, fontSize: 20, color: T.ink, marginTop: 12 },
  phoneRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  phone: { fontFamily: font.body, fontSize: 13, color: T.muted },
  verified: { flexDirection: "row", alignItems: "center", gap: 3, marginLeft: 4 },
  verifiedTxt: { color: T.terra, fontFamily: font.bodyBold, fontSize: 12 },
  stats: { flexDirection: "row", gap: 28, marginTop: 18 },
  stat: { alignItems: "center" },
  statVal: { fontFamily: font.headHeavy, fontSize: 20, color: T.ink },
  statLabel: { fontFamily: font.body, fontSize: 12, color: T.muted, marginTop: 2 },
  secLabel: { fontFamily: font.bodyHeavy, fontSize: 12, color: T.aubergine, letterSpacing: 1, textTransform: "uppercase", marginTop: 24, marginBottom: 10 },
  dashRow: { flexDirection: "row", gap: 12 },
  dashBtn: {
    flex: 1, alignItems: "center", gap: 8, paddingVertical: 18, borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.92)", borderWidth: 1, borderColor: "rgba(255,255,255,0.66)",
  },
  dashTxt: { fontFamily: font.bodyBold, fontSize: 13, color: T.aubergine },
  menu: { borderRadius: 18, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.92)", borderWidth: 1, borderColor: "rgba(255,255,255,0.66)" },
  menuRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 15 },
  menuDivider: { borderBottomWidth: 1, borderBottomColor: "rgba(23,22,28,0.06)" },
  menuTxt: { flex: 1, fontFamily: font.bodySemi, fontSize: 14.5, color: T.ink },
  logoutAll: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, marginTop: 22, paddingVertical: 16, borderRadius: 16, borderWidth: 1, borderColor: "rgba(70,50,80,0.18)" },
  logoutAllTxt: { fontFamily: font.bodyHeavy, fontSize: 15, color: T.aubergine },
  logout: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, marginTop: 12, paddingVertical: 16, borderRadius: 16, borderWidth: 1, borderColor: "rgba(164,93,98,0.3)" },
  logoutTxt: { fontFamily: font.bodyHeavy, fontSize: 15, color: T.coral },
});
