// design/Navigator.tsx — root stack + floating 5-tab bar + AI FAB, mirroring app.jsx.
import React from "react";
import { View, Text, Pressable, StyleSheet, Platform, ActivityIndicator } from "react-native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator, BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { Icon } from "./Icon";
import { T, font } from "./theme";

import { ExploreScreen } from "./screens/ExploreScreen";
import { WishlistScreen } from "./screens/WishlistScreen";
import { BookingsScreen } from "./screens/BookingsScreen";
import { ReviewPromptHost } from "./screens/ReviewModal";
import { MessagesScreen } from "./screens/MessagesScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { StayDetailScreen } from "./screens/StayDetailScreen";
import { ServiceDetailScreen } from "./screens/ServiceDetailScreen";
import { TransportDetailScreen } from "./screens/TransportDetailScreen";
import { BookingScreen } from "./screens/BookingScreen";
import { SearchScreen } from "./screens/SearchScreen";
import { NotificationsScreen } from "./screens/NotificationsScreen";
import { AiChatScreen } from "./screens/AiChatScreen";
import { ThreadScreen } from "./screens/ThreadScreen";
import { MapSearchScreen } from "./screens/MapSearchScreen";
import { OnboardingScreen } from "./screens/OnboardingScreen";
import { ResetPasswordScreen } from "./screens/ResetPasswordScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { KycVerificationScreen } from "./screens/KycVerificationScreen";
import { ProfileEditScreen } from "./screens/ProfileEditScreen";
import { AdminScreen } from "./screens/admin/AdminScreen";
import { LanguageScreen } from "./screens/LanguageScreen";
import { PrivacyScreen } from "./screens/PrivacyScreen";
import { HelpSupportScreen } from "./screens/HelpSupportScreen";
import { TermsScreen, PrivacyPolicyScreen, GrievanceScreen, OssLicensesScreen } from "./screens/LegalScreens";

export type RootParamList = {
  Onboarding: undefined;
  /** Reached via the emailed reset deep link. `oobCode` is Firebase's
   *  one-time reset code; `mode` is the action type (resetPassword). */
  ResetPassword: { oobCode?: string; mode?: string } | undefined;
  Tabs: undefined;
  StayDetail: { id: string };
  ServiceDetail: { id: string };
  TransportDetail: { id: string; mode?: string };
  Booking: { kind: "stay" | "service" | "transport"; id: string; roomIndex?: number; variantIndex?: number; addonIndexes?: number[]; mode?: string };
  Search: undefined;
  Notifications: undefined;
  MapSearch: {
    filters?: import("./screens/FilterSheet").Filters;
    /** Pre-fill for the map search bar (cosmetic — no geo-filter applied). */
    city?: string;
    /** A place the user had PICKED on Explore — arrives applied (geo-filter + centered). */
    place?: import("./api/geocode").PlaceDetails & { label: string };
  } | undefined;
  Dashboard: { role?: string };
  ProfileEdit: undefined;
  /** path = where the chat was opened from, in the backend's web-route
   *  vocabulary ("/explore", "/dashboard/guest", …) for persona tuning. */
  AiChat: { path?: string } | undefined;
  Thread: { id: string; name?: string };
  Kyc: undefined;
  Language: undefined;
  Privacy: undefined;
  HelpSupport: undefined;
  /** Legal docs (LEG-001/LEG-006). `Privacy` above is the consent-toggle +
   *  data-rights screen; `PrivacyPolicy` is the policy TEXT. */
  Terms: undefined;
  PrivacyPolicy: undefined;
  Grievance: undefined;
  /** Open-source attributions (LEG-016). */
  OssLicenses: undefined;
  Admin: undefined;
};

const Stack = createNativeStackNavigator<RootParamList>();
const Tab = createBottomTabNavigator();

const TABS: [string, string, string][] = [
  ["Explore", "compass", "Explore"],
  ["Wishlist", "heart", "Wishlist"],
  ["Bookings", "calendar", "Bookings"],
  ["Messages", "message", "Messages"],
  ["Profile", "user", "Profile"],
];

// Active tab → the web route the backend's assistant personas key off.
const PATH_FOR_TAB: Record<string, string> = {
  Explore: "/explore",
  Wishlist: "/wishlist",
  Bookings: "/dashboard/guest",
  Messages: "/messages",
  Profile: "/profile",
};

function FloatingTabBar({ state, navigation }: BottomTabBarProps) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const bottom = Math.max(insets.bottom, 10);
  const activeTab = state.routes[state.index]?.name ?? "Explore";
  return (
    <View pointerEvents="box-none" style={[styles.tabWrap, { bottom }]}>
      {/* AI FAB */}
      <Pressable
        style={({ pressed }) => [styles.fab, pressed && { transform: [{ scale: 0.94 }] }]}
        onPress={() => navigation.getParent()?.navigate("AiChat", { path: PATH_FOR_TAB[activeTab] })}
      >
        <LinearGradient
          colors={[T.gradFrom, T.gradTo]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.fabInner}
        >
          <Icon name="bot" size={24} color="#fff" />
        </LinearGradient>
      </Pressable>

      <View style={styles.tabbar}>
        {state.routes.map((route, i) => {
          const focused = state.index === i;
          const [, ic, lb] = TABS.find(([k]) => k === route.name) ?? ["", "compass", route.name];
          const label = t(`m.nav.${route.name}`, { defaultValue: lb });
          return (
            <Pressable
              key={route.key}
              style={styles.tabBtn}
              onPress={() => {
                const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
              }}
            >
              <View style={styles.tbIcoWrap}>
                {focused ? (
                  <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.tbIco}>
                    <Icon name={ic} size={21} color="#fff" strokeWidth={2} />
                  </LinearGradient>
                ) : (
                  <View style={styles.tbIco}>
                    <Icon name={ic} size={21} color={T.muted} strokeWidth={1.8} />
                  </View>
                )}
              </View>
              <Text style={[styles.tbLabel, focused && { color: T.aubergine }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <FloatingTabBar {...props} />}
    >
      <Tab.Screen name="Explore" component={ExploreScreen} />
      <Tab.Screen name="Wishlist" component={WishlistScreen} />
      <Tab.Screen name="Bookings" component={BookingsScreen} />
      <Tab.Screen name="Messages" component={MessagesScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

export function DesignNavigator() {
  const { user, loading } = useAuth();

  // Wait for Firebase to restore any persisted session before choosing the
  // landing route, so a returning (still-logged-in) user lands on Explore
  // instead of the auth flow. Mirrors App.tsx's fonts-loading fallback.
  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#f4efe9" }}>
        <ActivityIndicator color="#3a3247" />
      </View>
    );
  }

  return (
    <>
    <Stack.Navigator initialRouteName={user ? "Tabs" : "Onboarding"} screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "transparent" }, gestureEnabled: true, fullScreenGestureEnabled: true }}>
      <Stack.Screen name="Onboarding" component={OnboardingScreen} options={{ animation: "fade" }} />
      <Stack.Screen name="ResetPassword" component={ResetPasswordScreen} options={{ animation: "fade" }} />
      <Stack.Screen name="Tabs" component={Tabs} />
      <Stack.Screen name="StayDetail" component={StayDetailScreen} />
      <Stack.Screen name="ServiceDetail" component={ServiceDetailScreen} />
      <Stack.Screen name="TransportDetail" component={TransportDetailScreen} />
      <Stack.Screen name="Booking" component={BookingScreen} />
      <Stack.Screen name="Search" component={SearchScreen} options={{ animation: "fade" }} />
      <Stack.Screen name="Notifications" component={NotificationsScreen} />
      <Stack.Screen name="AiChat" component={AiChatScreen} options={{ presentation: "modal" }} />
      <Stack.Screen name="Thread" component={ThreadScreen} />
      {/* fullScreenGestureEnabled off here: its screen-wide native pop-pan
          recognizer overlaps the map's draggable bottom sheet and starves the
          sheet's PanResponder (sheet won't drag). Edge swipe-back still works
          via the inherited gestureEnabled. */}
      <Stack.Screen name="MapSearch" component={MapSearchScreen} options={{ fullScreenGestureEnabled: false }} />
      <Stack.Screen name="Dashboard" component={DashboardScreen} />
      <Stack.Screen name="ProfileEdit" component={ProfileEditScreen} />
      <Stack.Screen name="Admin" component={AdminScreen} />
      <Stack.Screen name="Kyc" component={KycVerificationScreen} />
      <Stack.Screen name="Language" component={LanguageScreen} />
      <Stack.Screen name="Privacy" component={PrivacyScreen} />
      <Stack.Screen name="HelpSupport" component={HelpSupportScreen} />
      <Stack.Screen name="Terms" component={TermsScreen} />
      <Stack.Screen name="PrivacyPolicy" component={PrivacyPolicyScreen} />
      <Stack.Screen name="Grievance" component={GrievanceScreen} />
      <Stack.Screen name="OssLicenses" component={OssLicensesScreen} />
    </Stack.Navigator>
    {/* Post-completion review prompt: pops the standard review sheet once per
        app open for the newest finished-but-unreviewed booking. RN <Modal>
        floats above every screen, so mounting it beside the stack is enough. */}
    {user && <ReviewPromptHost />}
    </>
  );
}

const styles = StyleSheet.create({
  tabWrap: { position: "absolute", left: 12, right: 12 },
  tabbar: {
    height: 76,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.7)",
    backgroundColor: "rgba(255,255,255,0.95)",
    shadowColor: "#221f27",
    shadowOffset: { width: 0, height: 22 },
    shadowOpacity: 0.2,
    shadowRadius: 40,
    elevation: 16,
  },
  tabBtn: { flex: 1, alignItems: "center", gap: 4 },
  tbIcoWrap: { width: 40, height: 30 },
  tbIco: { width: 40, height: 30, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  tbLabel: { fontSize: 10.5, fontFamily: font.bodyBold, color: T.muted },

  fab: {
    position: "absolute",
    right: 6,
    top: -64,
    width: 56,
    height: 56,
    borderRadius: 999,
    shadowColor: "#3a3247",
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.34,
    shadowRadius: 24,
    elevation: 14,
  },
  fabInner: { flex: 1, borderRadius: 999, alignItems: "center", justifyContent: "center" },
});
