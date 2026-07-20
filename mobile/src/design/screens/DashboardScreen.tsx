// design/screens/DashboardScreen.tsx — host/provider/transport dashboard (ported from dashboards.jsx).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, Pressable, Modal, StyleSheet, ActivityIndicator, Alert, Image, Linking, RefreshControl } from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Icon } from "../Icon";
import { T, font } from "../theme";
import { DASH, DashRole, DashListing, DashBooking } from "./dash/dashData";
import { DashEarnings, DashReviews, EarningsChart, PayoutNudge, PayoutsCard, StatusChip, TONE_BG, TONE_FG, rupee } from "./dash/dashPanels";
import { DashInsights } from "./dash/DashInsights";
import { DashCalendar } from "./dash/DashCalendar";
import { DashSchedule } from "./dash/DashSchedule";
import { DashServiceSchedule } from "./dash/DashServiceSchedule";
import { ListingDetailsSheet } from "./dash/ListingDetailsSheet";
import { ListingOnboarding, DraftListing } from "./dash/ListingOnboarding";
import { RoomTypesManager } from "./dash/RoomTypesManager";
import { CreateCoupon } from "./dash/CreateCoupon";
import { BookForGuest } from "./dash/BookForGuest";
import { DashCoupon } from "./dash/dashData";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ROLE_TYPE, useMyListings, useCoupons, useProviderBookings, useEarnings, useProviderReviews, useInsights, useUnreadNotifications } from "../api/hooks";
import { createListing, createCoupon, setListingActive, setCouponActive, deleteCoupon, fetchListingRaw, listingToForm, updateListingFull, MyListing } from "../api/dash";
import type { RootParamList } from "../Navigator";
import { createRoomTypesAfterListing } from "../api/roomTypes";
import { fetchKycDocuments } from "../api/verification";
import { fetchMyProfile } from "../api/users";
import { loadOnboardingDraft, clearOnboardingDraft, describeAge, OnboardingDraftEnvelope } from "../api/onboardingDraft";
import { uploadListingPhotos } from "../api/storage";
import { cancelBookingStatus, istToday, istTodayYMD, ymd } from "../api/bookings";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "@/lib/toast";

const ROLE_META: [string, string, string][] = [["provider", "Provider", "sparkle"], ["transport", "Transport", "car"], ["host", "Host", "home"]];
// Stays where guests book individual rooms — these manage per-room pricing/
// layout in the Room types manager (mirrors MULTI_ROOM in ListingOnboarding).
const MULTI_ROOM_TYPES = new Set(["hotel", "lodge", "heritage", "sathram"]);
const ROLE_LABEL: Record<string, string> = { host: "Host", provider: "Provider", transport: "Transport" };
const ENTRY_FOR: Record<string, "stay" | "service" | "transport"> = { host: "stay", provider: "service", transport: "transport" };
const SUBS: [string, string][] = [["upcoming", "Upcoming"], ["completed", "Completed"], ["cancelled", "Cancelled"]];

// Rows shown in the dashboard mix real backend listings (MyListing — apiId,
// propertyType, working hours) with local mock DashListing rows, so the
// backend-only fields are optional here.
type ScreenListing = DashListing & Partial<Pick<MyListing, "apiId" | "propertyType" | "workingHours" | "bufferMinutes" | "languages">>;

/** De-dupe spoken languages case-insensitively, each Title-Cased. Listing
 *  metadata often repeats the same language in different casing (e.g.
 *  ["english", "English"]) — without this it renders as a repeated list. */
function formatLanguageList(langs: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of langs) {
    const l = String(raw).trim();
    if (!l) continue;
    const key = l.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l.charAt(0).toUpperCase() + l.slice(1).toLowerCase());
  }
  return out.join(", ");
}
// Backend bookings (mapDashBooking) carry scheduling fields the mock rows lack.
type LiveBooking = DashBooking & { listingId?: string; scheduledDate?: string; endDate?: string; startTime?: string; endTime?: string };
// Shape of the API error fields the handlers below read (axios-style).
type ApiErr = { message?: string; details?: { missing?: { label?: string; message?: string }[] } };
// RN's Pressable style-callback state (plus the web-only hover flag).
type PressState = { pressed: boolean; hovered?: boolean };
// Free-form onboarding form state (ListingOnboarding's `p`) — the api layer's
// buildCreatePayload consumes it as-is; only the keys read here are typed.
type RoomDraft = Record<string, unknown> & { photos?: string[] };
type OnboardForm = Record<string, unknown> & { photos?: string[]; rooms?: RoomDraft[] };

function StatTile({ s, onPress }: { s: { icon: string; value: string; label: string; desc: string }; onPress?: () => void }) {
  const body = (
    <>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <View style={st.dsIco}><Icon name={s.icon} size={18} color="#8b5e4a" /></View>
      </View>
      <Text style={st.statVal}>{s.value}</Text>
      <Text style={st.statLabel}>{s.label}</Text>
      <Text style={st.statDesc}>{s.desc}</Text>
    </>
  );
  if (onPress) return <Pressable style={({ pressed }: PressState) => [st.statTile, pressed && { opacity: 0.82 }]} onPress={onPress}>{body}</Pressable>;
  return <View style={st.statTile}>{body}</View>;
}

// Period-over-period trend chip (▲/▼ %) for the Overview earnings card. Green
// up, coral down, muted flat; "New" when there's no prior-period baseline.
function TrendChip({ pct }: { pct: number | null }) {
  const { t } = useLanguage();
  if (pct === null) return (
    <View style={[st.trend, { backgroundColor: "rgba(47,125,85,0.1)" }]}>
      <Icon name="arrowUR" size={11} color="#2f7d55" /><Text style={[st.trendTxt, { color: "#2f7d55" }]}>{t("m.dashboard.trendNew", { defaultValue: "New" })}</Text>
    </View>
  );
  const flat = Math.abs(pct) < 0.5;
  const up = pct >= 0;
  const color = flat ? T.muted : up ? "#2f7d55" : T.coral;
  const bg = flat ? "rgba(58,50,71,0.08)" : up ? "rgba(47,125,85,0.1)" : "rgba(164,93,98,0.12)";
  return (
    <View style={[st.trend, { backgroundColor: bg }]}>
      <Icon name={up ? "arrowUR" : "arrowDR"} size={11} color={color} />
      <Text style={[st.trendTxt, { color }]}>{flat ? "0%" : `${Math.abs(Math.round(pct))}%`}</Text>
    </View>
  );
}

function BookingCard({ b, onCancel, onOpen }: { b: DashBooking; onCancel?: (b: DashBooking) => void; onOpen?: (b: DashBooking) => void }) {
  const { t } = useLanguage();
  return (
    <Pressable style={({ pressed }) => [st.bk, pressed && onOpen && { opacity: 0.9 }]} onPress={() => onOpen?.(b)}>
      <View style={[st.bkIco, { backgroundColor: TONE_BG[b.tone] }]}><Icon name={b.icon} size={20} color={TONE_FG[b.tone]} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flex: 1, minWidth: 0 }}>
            <View style={st.guestAv}><Text style={st.guestAvTxt}>{b.avatar}</Text></View>
            <Text style={st.guest} numberOfLines={1}>{b.guest}</Text>
          </View>
          <StatusChip status={b.status} />
        </View>
        <Text style={st.bkMeta}>{b.item}</Text>
        <Text style={st.bkMeta}>{b.meta}</Text>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 9 }}>
          <Text style={st.bkAmt}>{rupee(b.amount)}</Text>
          {b.status === "upcoming" && onCancel ? (
            <Pressable style={st.cancelBtn} onPress={() => onCancel(b)}><Text style={st.cancelTxt}>{t("m.dashboard.cancel", { defaultValue: "Cancel" })}</Text></Pressable>
          ) : (
            <Text style={st.bkWhen}>{b.when}</Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}

function BdRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={st.bdInfoRow}>
      <View style={st.bdInfoIco}><Icon name={icon} size={18} color={T.aubergine} /></View>
      <View style={{ flex: 1 }}>
        <Text style={st.bdInfoLabel}>{label}</Text>
        <Text style={st.bdInfoVal}>{value}</Text>
      </View>
    </View>
  );
}
function BdBill({ label, value, strong, accent }: { label: string; value: string; strong?: boolean; accent?: boolean }) {
  return (
    <View style={st.bdBillRow}>
      <Text style={[st.bdBillLabel, strong && st.bdBillStrong]}>{label}</Text>
      <Text style={[st.bdBillVal, strong && st.bdBillStrong, accent ? { color: "#2f7d55" } : null]}>{value}</Text>
    </View>
  );
}

function ListingRow({ l, role, onView, onEdit, onToggle, onCalendar, onSchedule, onServiceSchedule, onRooms }: {
  l: ScreenListing;
  role: string;
  onView: (l: ScreenListing) => void;
  onEdit: (l: ScreenListing) => void;
  onToggle: (l: ScreenListing) => void;
  onCalendar: (l: ScreenListing) => void;
  onSchedule: (l: ScreenListing) => void;
  onServiceSchedule: (l: ScreenListing) => void;
  onRooms: (l: ScreenListing) => void;
}) {
  const { t } = useLanguage();
  const active = l.status === "live";
  const multiRoom = role === "host" && !!l.apiId && !!l.propertyType && MULTI_ROOM_TYPES.has(l.propertyType);
  return (
    <View style={st.bk}>
      <View style={[st.bkIco, { backgroundColor: TONE_BG[l.tone] }]}><Icon name={l.icon} size={20} color={TONE_FG[l.tone]} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <StatusChip status={active ? "confirmed" : "completed"} label={active ? t("m.dashboard.active", { defaultValue: "Active" }) : t("m.dashboard.inactive", { defaultValue: "Inactive" })} />
        <Text style={st.listingName}>{l.name}</Text>
        <Text style={st.bkMeta}>{l.location}</Text>
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 9, alignItems: "center" }}>
          <Text style={st.bkMeta}>{l.metric}</Text>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <View style={{ flexDirection: "row", gap: 3, alignItems: "center" }}>
              <Icon name="starFill" size={11} color={T.saffron} />
              <Text style={st.bkMeta}>{l.rating}</Text>
            </View>
            <Text style={st.listingPrice}>{l.price}</Text>
          </View>
        </View>
        <View style={st.actions}>
          {!!l.apiId && <Pressable style={st.act} onPress={() => onView(l)}><Icon name="eye" size={14} color={T.ink} /><Text style={st.actTxt}>{t("m.dashboard.view", { defaultValue: "View" })}</Text></Pressable>}
          <Pressable style={st.act} onPress={() => onEdit(l)}><Icon name="pencil" size={14} color={T.ink} /><Text style={st.actTxt}>{t("m.dashboard.edit", { defaultValue: "Edit" })}</Text></Pressable>
          {multiRoom && <Pressable style={st.act} onPress={() => onRooms(l)}><Icon name="bed" size={14} color={T.ink} /><Text style={st.actTxt}>{t("m.dashboard.rooms", { defaultValue: "Rooms" })}</Text></Pressable>}
          {role === "host" && <Pressable style={st.act} onPress={() => onCalendar(l)}><Icon name="calendar" size={14} color={T.ink} /><Text style={st.actTxt}>{t("m.dashboard.calendar", { defaultValue: "Calendar" })}</Text></Pressable>}
          {role === "transport" && <Pressable style={st.act} onPress={() => onSchedule(l)}><Icon name="clock" size={14} color={T.ink} /><Text style={st.actTxt}>{t("m.dashboard.schedule", { defaultValue: "Schedule" })}</Text></Pressable>}
          {role === "provider" && <Pressable style={st.act} onPress={() => onServiceSchedule(l)}><Icon name="clock" size={14} color={T.ink} /><Text style={st.actTxt}>{t("m.dashboard.schedule", { defaultValue: "Schedule" })}</Text></Pressable>}
          <Pressable style={st.act} onPress={() => onToggle(l)}>
            <Icon name="dot" size={13} color={active ? "#2f7d55" : "#b6bbc2"} />
            <Text style={[st.actTxt, { color: active ? "#2f7d55" : T.muted }]}>{active ? t("m.dashboard.deactivate", { defaultValue: "Deactivate" }) : t("m.dashboard.activate", { defaultValue: "Activate" })}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function CouponCard({ c, onToggle, onDelete }: { c: DashCoupon; onToggle: () => void; onDelete: () => void }) {
  const active = c.active ?? c.status !== "expired";
  return (
    <View style={[st.coupon, !active && { opacity: 0.55 }]}>
      <View style={st.couponTag}><Icon name="ticket" size={18} color="#8b5e4a" /></View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Text style={st.couponCode}>{c.code}</Text>
          <View style={st.couponOff}><Text style={st.couponOffTxt}>{c.off}</Text></View>
        </View>
        <Text style={[st.bkMeta, { marginTop: 3 }]}>{c.desc}</Text>
        <Text style={[st.bkMeta, { marginTop: 1 }]}>{c.used}</Text>
      </View>
      {/* Pause / resume — same on/off toggle as the web coupon manager. */}
      <Pressable onPress={onToggle} hitSlop={6} style={[st.couponSwitch, active && { backgroundColor: T.terra }]} accessibilityRole="switch" accessibilityState={{ checked: active }}>
        <View style={[st.couponKnob, active && { transform: [{ translateX: 18 }] }]} />
      </Pressable>
      <Pressable onPress={onDelete} hitSlop={6} style={st.couponDel}>
        <Icon name="trash" size={17} color={T.coral} />
      </Pressable>
    </View>
  );
}

export function DashboardScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootParamList>>();
  const route = useRoute<RouteProp<RootParamList, "Dashboard">>();
  const insets = useSafeAreaInsets();
  const [role, setRole] = useState<string>(route.params?.role || "host");
  const [tab, setTab] = useState("overview");
  const [sub, setSub] = useState("upcoming");
  const d: DashRole = DASH[role];
  const { t } = useLanguage();
  const { user } = useAuth();
  const { listings: myListings, fromBackend, refetch: refetchMine } = useMyListings(role);
  const queryClient = useQueryClient();
  // Every host-side mutation (publish / edit / activate / delete / rooms)
  // must also refresh the CUSTOMER-facing caches — Explore's catalog and the
  // listing's detail page — or they keep showing stale data until the 60s
  // staleTime lapses. Active observers (e.g. the mounted Explore tab)
  // refetch immediately on invalidation.
  const invalidateMarketplace = (apiId?: string) => {
    void queryClient.invalidateQueries({ queryKey: ["catalog"] });
    if (apiId) {
      void queryClient.invalidateQueries({ queryKey: ["listing", apiId] });
      void queryClient.invalidateQueries({ queryKey: ["reviews", apiId] });
    }
  };
  const [bookings, setBookings] = useState(d.bookings);
  const [listings, setListings] = useState<DashListing[]>(d.listings);
  const { coupons: myCoupons, fromBackend: couponsFromBackend, refetch: refetchCoupons } = useCoupons();
  const provBookings = useProviderBookings(role);
  // Overview earnings — scoped to THIS dashboard's vertical (host = stays,
  // provider = services, transport = transport) so a cab+salon owner's
  // dashboards never mix each other's money. The selected range drives the
  // trend chart; the tile always shows the type-scoped all-time total from
  // the same response, so tile and "All" range agree by construction.
  const [earnRangeId, setEarnRangeId] = useState<"30d" | "90d" | "365d" | "all">("30d");
  const earnType = ROLE_TYPE[role];
  const { earnings: realEarn, fromBackend: earnFromBackend, refetch: refetchEarn } = useEarnings({ range: earnRangeId, type: earnType });
  // Previous same-length window (ending the day before the current one) —
  // powers the Overview earnings trend chip. No baseline exists for "all".
  const prevWindow = useMemo(() => {
    const days = ({ "30d": 30, "90d": 90, "365d": 365 } as Record<string, number>)[earnRangeId] ?? 30;
    const curStart = istToday(); curStart.setDate(curStart.getDate() - (days - 1));
    const prevEnd = new Date(curStart); prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - (days - 1));
    return { from: ymd(prevStart), to: ymd(prevEnd), type: earnType };
  }, [earnRangeId, earnType]);
  const { earnings: prevEarn, refetch: refetchPrevEarn } = useEarnings(prevWindow, { enabled: earnRangeId !== "all" });
  // Partner insights (occupancy / repeat rate) for the Overview 4th stat tile.
  const { insights, refetch: refetchInsights } = useInsights(ENTRY_FOR[role], 30);
  // Unread in-app notifications → bell badge.
  const { unread } = useUnreadNotifications();
  const [refreshing, setRefreshing] = useState(false);
  // Real provider-received bookings when signed in; mock otherwise.
  const liveBookings: LiveBooking[] = provBookings.fromBackend ? provBookings.bookings : bookings;
  // Real identity from the signed-in account.
  const realName = user?.name || user?.email?.split("@")[0] || d.profile.name;
  const realAvatar = realName.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase();
  // Real listings/coupons (from the backend) when signed in; mock otherwise.
  const liveListings: ScreenListing[] = fromBackend ? myListings : listings;
  const [coupons, setCoupons] = useState<DashCoupon[]>(d.coupons);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreY, setMoreY] = useState(0);
  const [adding, setAdding] = useState(false);
  // Saved-but-unfinished onboarding draft for THIS dashboard's listing type.
  // Surfaces as a non-activatable Draft row at the top of the listings tab
  // (mirrors web MyListings) with Continue onboarding / Delete. Reloaded
  // whenever onboarding closes so a fresh "Save draft" shows up immediately.
  const [draft, setDraft] = useState<{ env: OnboardingDraftEnvelope; savedAt: Date | null } | null>(null);
  const [resumingDraft, setResumingDraft] = useState(false);
  useEffect(() => {
    if (adding) return;
    let alive = true;
    loadOnboardingDraft(user?.id, ENTRY_FOR[role]).then(({ draft: env, savedAt }) => {
      if (alive) setDraft(env ? { env, savedAt } : null);
    });
    return () => { alive = false; };
  }, [adding, role, user?.id]);
  const deleteDraft = () => {
    Alert.alert(t("m.dashboard.deleteDraftTitle", { defaultValue: "Delete draft?" }), t("m.dashboard.deleteDraftMsg", { defaultValue: "This removes the saved onboarding progress. You can't undo this." }), [
      { text: t("m.dashboard.cancel", { defaultValue: "Cancel" }), style: "cancel" },
      { text: t("m.dashboard.delete", { defaultValue: "Delete" }), style: "destructive", onPress: () => { void clearOnboardingDraft(user?.id, ENTRY_FOR[role]); setDraft(null); } },
    ]);
  };
  const [editing, setEditing] = useState<ScreenListing | null>(null);
  // Read-only owner detail sheet (View action on a listing row).
  const [viewFor, setViewFor] = useState<ScreenListing | null>(null);
  // On edit, fetch the full listing so the form can be pre-populated.
  const editApiId = editing?.apiId;
  const editQ = useQuery({ queryKey: ["edit-listing", editApiId], queryFn: () => fetchListingRaw(editApiId!), enabled: !!editApiId && !!user, staleTime: 0, retry: 1 });
  // KYC banner is driven by REAL status: only shown when the signed-in user has
  // not uploaded any verification documents (not the hardcoded dash config).
  const kycQ = useQuery({ queryKey: ["kyc-docs"], queryFn: fetchKycDocuments, enabled: !!user, staleTime: 60_000, retry: 1 });
  // Live user_profiles row — real avatar + display name for the Profile tab
  // (same ["profile"] cache the Profile bottom-tab and ProfileEdit use, so
  // edits made there reflect here immediately).
  const profileQ = useQuery({ queryKey: ["profile"], queryFn: fetchMyProfile, enabled: !!user, staleTime: 30_000, retry: 1 });
  const provReviews = useProviderReviews(role);
  const [calendarFor, setCalendarFor] = useState<ScreenListing | null>(null);
  const [scheduleFor, setScheduleFor] = useState<ScreenListing | null>(null);
  const [serviceScheduleFor, setServiceScheduleFor] = useState<ScreenListing | null>(null);
  const [roomsFor, setRoomsFor] = useState<ScreenListing | null>(null);
  const [creatingCoupon, setCreatingCoupon] = useState(false);
  const [bookingForGuest, setBookingForGuest] = useState(false);
  const [bookingDetail, setBookingDetail] = useState<DashBooking | null>(null);
  const tabsRef = useRef<View>(null);

  useEffect(() => {
    setBookings(DASH[role].bookings);
    setListings(DASH[role].listings);
    setCoupons(DASH[role].coupons);
    setTab("overview"); setSub("upcoming"); setMenuOpen(false); setMoreOpen(false);
  }, [role]);

  const openMore = () => {
    tabsRef.current?.measureInWindow((_x, y, _w, h) => { setMoreY(y + h + 6); setMoreOpen(true); });
  };

  // Tab labels run through i18n; the dashData strings are the English
  // defaults. Only "listings" differs per role (Listings / Services /
  // Vehicles) — every other tab shares one label across roles.
  const tabLabel = (id: string, fallback: string) =>
    id === "listings"
      ? t(`m.dashboard.tab.listings.${role}`, { defaultValue: fallback })
      : t(`m.dashboard.tab.${id}`, { defaultValue: fallback });
  const primaryTabs = d.tabs.slice(0, 4);
  const moreTabs = d.tabs.slice(4);
  const activeInMore = moreTabs.find((t) => t[0] === tab);
  const counts = SUBS.reduce((a, [k]) => ((a[k] = liveBookings.filter((b) => b.status === k).length), a), {} as Record<string, number>);
  // Upcoming sorted soonest-first so the 3 shown on the Overview are genuinely
  // the next ones (backend order isn't guaranteed); missing dates sort last.
  const soonKey = (b: LiveBooking) => `${b.scheduledDate || "9999-99-99"} ${b.startTime || "99:99"}`;
  const upcoming = liveBookings.filter((b) => b.status === "upcoming").sort((a, b) => (soonKey(a) < soonKey(b) ? -1 : soonKey(a) > soonKey(b) ? 1 : 0));

  // "Today" triage: upcoming bookings scheduled for today. Rendered only when
  // non-zero.
  const todayYMD = istTodayYMD();
  const todayCount = liveBookings.filter((b) => b.status === "upcoming" && b.scheduledDate === todayYMD).length;

  // Earnings trend: current vs previous same-length window. undefined → no
  // chip (no real data, or "all" which has no baseline); null → "New" (no
  // prior-period earnings); number → signed %.
  const earnDeltaPct: number | null | undefined = (() => {
    if (!earnFromBackend || !realEarn || earnRangeId === "all") return undefined;
    const prev = prevEarn?.totalRupees ?? 0;
    if (prev <= 0) return realEarn.totalRupees > 0 ? null : undefined;
    return ((realEarn.totalRupees - prev) / prev) * 100;
  })();

  // Real earnings overlay (signed-in providers): tile[0]=earnings, tile[2]=rating.
  const kfmt = (n: number) => (n >= 1000 ? `₹${(n / 1000).toFixed(1)}K` : `₹${Math.round(n)}`);
  // Tab each stat tile deep-links to when tapped.
  const STAT_TABS = ["earnings", "bookings", "reviews", role === "transport" ? "bookings" : "insights"];
  // 4th tile is role-specific (mirrors the web dashboards): host → occupancy %,
  // provider → repeat rate (both from the partner Insights endpoint), transport
  // → upcoming trips. Keeps a uniform 2×2 grid across roles.
  const tile4 = (() => {
    if (role === "host") {
      const pct = insights?.stay?.totals?.occupancyPct;
      return { icon: "home", value: pct != null ? `${Math.round(pct)}%` : "—",
        label: t("m.dashboard.occupancy", { defaultValue: "Occupancy" }),
        desc: t("m.dashboard.occupancyDesc", { defaultValue: "Rooms booked · 30d" }) };
    }
    if (role === "provider") {
      const rr = insights?.repeat?.repeatRate;
      return { icon: "sparkle", value: rr != null ? `${rr}%` : "—",
        label: t("m.dashboard.repeatRate", { defaultValue: "Repeat rate" }),
        desc: t("m.dashboard.repeatRateDesc", { defaultValue: "Returning clients" }) };
    }
    return { icon: "car", value: String(counts.upcoming ?? 0),
      label: t("m.dashboard.upcomingTrips", { defaultValue: "Upcoming" }),
      desc: t("m.dashboard.upcomingTripsDesc", { defaultValue: "Scheduled trips" }) };
  })();
  const stats = d.stats.map((s, i) => {
    const tab = STAT_TABS[i] || "overview";
    // 4th tile (occupancy / repeat / upcoming).
    if (i === 3) return { ...s, icon: tile4.icon, value: tile4.value, label: tile4.label, desc: tile4.desc, tab };
    // 2nd tile: active bookings (host) / jobs done (provider) / trips done
    // (transport) — previously hardcoded to "0".
    if (i === 1) {
      const val = role === "host" ? counts.upcoming : counts.completed;
      return { ...s, tab, ...(provBookings.fromBackend ? { value: String(val ?? 0) } : {}) };
    }
    if (i === 0 && earnFromBackend && realEarn) {
      // Lifetime total for this vertical — the trend chart's "All" range
      // lands on exactly this number (same endpoint, same filters).
      return { ...s, tab, value: kfmt(realEarn.allTime), desc: t("m.dashboard.allTime", { defaultValue: "All time · completed" }) };
    }
    if (i === 2 && earnFromBackend && realEarn) {
      const hasReviews = provReviews.fromBackend && provReviews.count > 0;
      return {
        ...s, tab,
        value: hasReviews ? provReviews.rating.toFixed(1) : realEarn.avgRating != null ? realEarn.avgRating.toFixed(1) : s.value,
        desc: provReviews.fromBackend ? t("m.dashboard.reviewCount", { defaultValue: "{{count}} review{{plural}}", count: provReviews.count, plural: provReviews.count === 1 ? "" : "s" }) : s.desc,
      };
    }
    return { ...s, tab };
  });
  // Overview trend card: the selected window's gross + its explicit dates
  // (from the server's resolved window, so chart and label can't drift).
  const earnTotal = earnFromBackend && realEarn ? `₹${Math.round(realEarn.totalRupees).toLocaleString("en-IN")}` : d.earnings.total;
  const earnWindowLbl = (() => {
    if (!earnFromBackend || !realEarn) return "";
    const fmt = (iso: string, withYear: boolean) => new Date(`${iso}T00:00:00`)
      .toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) });
    const from = realEarn.from ?? realEarn.series[0]?.date;
    const to = realEarn.to ?? realEarn.series[realEarn.series.length - 1]?.date;
    return from && to ? `${fmt(from, false)} – ${fmt(to, true)}` : "";
  })();
  const earnSeries = earnFromBackend && realEarn ? realEarn.series : [];
  const bkLabel = tabLabel("bookings", (d.tabs.find((t) => t[0] === "bookings") || ["", "Bookings"])[1]);

  // Pull-to-refresh: re-pull every live source feeding this dashboard.
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refetchMine(), provBookings.refetch(), refetchEarn(), refetchPrevEarn(),
        refetchCoupons(), provReviews.refetch(), refetchInsights(), kycQ.refetch(),
      ].map((p) => Promise.resolve(p)));
    } finally { setRefreshing(false); }
  };
  // KYC verification prompt: signed in → only when no documents uploaded yet;
  // signed out (demo) → dash config. Used to gate the banner AND suppress the
  // payout nudge beneath it (one primary nudge at a time).
  const showKycBanner = user ? (kycQ.isSuccess && (kycQ.data?.length ?? 0) === 0) : d.kyc !== "verified";

  const toggleListing = async (l: ScreenListing) => {
    if (l.apiId && user) {
      try { await setListingActive(l.apiId, l.status !== "live"); refetchMine(); invalidateMarketplace(l.apiId); return; }
      catch (e) {
        // Activation runs the server readiness gate. Surface exactly what's
        // missing (e.g. "Room types, Room photos") instead of failing silently
        // and snapping the toggle back on refetch.
        const err = e as ApiErr;
        const missing = err?.details?.missing;
        if (Array.isArray(missing) && missing.length) {
          // Show the specific message, not just the label — several distinct
          // room failures (no rooms / rooms incomplete / rooms missing photos)
          // all share the label "Room types", which misleads hosts whose rooms
          // DO exist but are missing a price, capacity, or photo. The message
          // says exactly what to fix.
          toast.error(t("m.dashboard.cantGoLive", { defaultValue: "Can't go live yet — {{reasons}}", reasons: missing.map((m) => m.message || m.label).join(" ") }));
        } else {
          toast.error(err?.message || t("m.dashboard.updateListingError", { defaultValue: "Couldn't update the listing." }));
        }
        return;
      }
    }
    setListings((p) => p.map((x) => (x === l ? { ...x, status: x.status === "live" ? "paused" : "live" } : x)));
  };
  // Listing deletion is admin-only (soft archive via the ops console) —
  // partners deactivate instead, so booking/invoice history is never orphaned.
  const cancelBooking = async (b: DashBooking) => {
    if (b.id && user) {
      // Host cancels stays as "host", provider/transport as "provider" (mirrors
      // the web). The backend issues the refund + sends cancellation/refund
      // emails to guest and provider on this same call.
      try {
        await cancelBookingStatus(b.id, role === "host" ? "host" : "provider");
        provBookings.refetch();
        toast.success(t("m.dashboard.bookingCancelled", { defaultValue: "Booking cancelled — the guest has been refunded and notified." }));
        return;
      } catch (e) {
        toast.error((e as ApiErr)?.message || t("m.dashboard.cancelBookingError", { defaultValue: "Couldn't cancel this booking. Please try again." }));
        return;
      }
    }
    setBookings((p) => p.map((x) => (x === b ? { ...x, status: "cancelled" } : x)));
  };
  // Upload each room type's locally-picked photos to S3 (existing https urls
  // pass through), returning the rooms with CDN urls so they persist.
  const uploadRoomPhotos = async (userId: string, rooms?: RoomDraft[]) => {
    if (!Array.isArray(rooms) || rooms.length === 0) return rooms;
    return Promise.all(
      rooms.map(async (r) => ({
        ...r,
        photos: Array.isArray(r.photos) && r.photos.length ? await uploadListingPhotos(userId, r.photos) : [],
      })),
    );
  };

  const publish = async (item: DraftListing, formState?: OnboardForm) => {
    setAdding(false); setTab("listings");
    if (user && formState) {
      try {
        // Upload locally-picked photos to S3 first; submit the CDN urls (not
        // the file:// uris, which would otherwise persist as broken images).
        const photos = Array.isArray(formState.photos) ? await uploadListingPhotos(user.id, formState.photos) : [];
        const rooms = await uploadRoomPhotos(user.id, formState.rooms);
        const { listing: created, warnings } = await createListing(ENTRY_FOR[role], { ...formState, photos });
        // Warn-only guardrail nudges (street address in the public
        // description, etc.) — the listing saved; show them as advice.
        for (const w of warnings) toast.info(w);
        // Room types are a SEPARATE resource — bulk-create them after the
        // listing exists (mirrors the web onboarding post-create loop). Never
        // sent in the listing body.
        const listingId = created?.id;
        if (listingId && ENTRY_FOR[role] === "stay" && Array.isArray(rooms) && rooms.length) {
          const { failed } = await createRoomTypesAfterListing(listingId, rooms);
          if (failed.length) toast.error(t("m.dashboard.roomsNeedReadding", { defaultValue: "Listing created, but {{count}} room{{plural}} need re-adding from “Rooms”.", count: failed.length, plural: failed.length > 1 ? "s" : "" }));
        }
        refetchMine();
        invalidateMarketplace(listingId);
        return;
      } catch (e) {
        // Surface the failure instead of degrading to a local-only listing.
        // The old silent fallback made a failed publish (moderation rejection,
        // validation error, backend down) look identical to a successful one.
        console.warn("create listing failed", e);
        toast.error((e as ApiErr)?.message || t("m.dashboard.publishFailed", { defaultValue: "Couldn't publish your listing. Please try again." }));
        return;
      }
    }
    setListings((p) => [item, ...p]); // guest → local-only
  };
  const saveEdit = async (updated: DraftListing, formState?: OnboardForm) => {
    const target = editing;
    const existing = editQ.data; // captured before clearing `editing`
    setEditing(null); setTab("listings");
    if (target?.apiId && user && formState) {
      try {
        // Upload any newly-picked photos (existing https urls pass through);
        // then PATCH the FULL built payload, merging metadata over the existing
        // row so untouched keys (providerName, slots…) survive. Room types are
        // managed separately via the Rooms manager, not this payload.
        const photos = Array.isArray(formState.photos) ? await uploadListingPhotos(user.id, formState.photos) : [];
        await updateListingFull(target.apiId, ENTRY_FOR[role], { ...formState, photos }, existing);
        refetchMine();
        invalidateMarketplace(target.apiId);
        return;
      } catch (e) { toast.error((e as ApiErr)?.message || t("m.dashboard.saveChangesError", { defaultValue: "Couldn't save changes." })); return; }
    }
    setListings((p) => p.map((x) => (x === target ? { ...x, name: updated.name, location: updated.location, price: updated.price } : x)));
  };

  if (adding) return (
    <ListingOnboarding
      entryType={ENTRY_FOR[role]}
      resumeDraft={resumingDraft ? draft?.env : undefined}
      onClose={() => { setAdding(false); setResumingDraft(false); }}
      onPublish={(l, f) => { setResumingDraft(false); void publish(l, f); }}
    />
  );
  if (editing) {
    // Wait for the full listing before opening the form so every field
    // pre-populates (a blank form + full PATCH would wipe data).
    if (editApiId && !editQ.data) {
      return (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#f4efe9" }}>
          <ActivityIndicator color={T.aubergine} />
        </View>
      );
    }
    const initialForm = editApiId && editQ.data
      ? listingToForm(ENTRY_FOR[role], editQ.data)
      : { name: editing.name, location: editing.location };
    return (
      <ListingOnboarding
        entryType={ENTRY_FOR[role]}
        editing
        initialForm={initialForm}
        onClose={() => setEditing(null)}
        onPublish={saveEdit}
        onManageRooms={() => { const t = editing; setEditing(null); setRoomsFor(t); }}
      />
    );
  }
  if (roomsFor) return <RoomTypesManager listingId={roomsFor.apiId!} listingName={roomsFor.name} onClose={() => { const rid = roomsFor?.apiId; setRoomsFor(null); refetchMine(); invalidateMarketplace(rid); }} />;
  if (calendarFor) return <DashCalendar name={calendarFor.name} listingId={calendarFor.apiId} propertyType={calendarFor.propertyType} onClose={() => {
    // Blocked-date edits feed the customer booking calendar — refresh it.
    const cid = calendarFor?.apiId;
    setCalendarFor(null);
    if (cid) { void queryClient.invalidateQueries({ queryKey: ["availability", cid] }); void queryClient.invalidateQueries({ queryKey: ["booked-dates", cid] }); }
  }} />;
  if (scheduleFor) {
    const schedId = scheduleFor.apiId;
    // Real upcoming trips for THIS listing only (listing-scoped — a driver may
    // run more than one vehicle under one profile).
    const schedTrips = liveBookings
      .filter((b) => b.listingId && schedId && b.listingId === schedId)
      .map((b) => ({ scheduledDate: b.scheduledDate, endDate: b.endDate, startTime: b.startTime, endTime: b.endTime, status: b.status, label: b.guest ? `${b.guest}` : t("m.dashboard.bookedTrip", { defaultValue: "Booked trip" }) }));
    return (
      <DashSchedule
        name={scheduleFor.name}
        listingId={schedId}
        workingHours={scheduleFor.workingHours}
        bufferMinutes={scheduleFor.bufferMinutes}
        bookings={schedTrips}
        onClose={() => {
          // Block-day edits feed the customer booking calendar — refresh it.
          setScheduleFor(null);
          if (schedId) { void queryClient.invalidateQueries({ queryKey: ["availability", schedId] }); void queryClient.invalidateQueries({ queryKey: ["booked-dates", schedId] }); }
        }}
      />
    );
  }
  if (serviceScheduleFor) {
    const svcId = serviceScheduleFor.apiId;
    return (
      <DashServiceSchedule
        name={serviceScheduleFor.name}
        listingId={svcId}
        onClose={() => {
          // Block-day edits feed the customer booking calendar — refresh it.
          setServiceScheduleFor(null);
          if (svcId) { void queryClient.invalidateQueries({ queryKey: ["availability", svcId] }); void queryClient.invalidateQueries({ queryKey: ["service-bookings", svcId] }); }
        }}
      />
    );
  }
  if (bookingForGuest) return (
    <BookForGuest
      entryType={role === "provider" ? "service" : role === "transport" ? "transport" : "stay"}
      listings={myListings}
      onClose={() => setBookingForGuest(false)}
      onCreated={() => provBookings.refetch()}
    />
  );
  if (creatingCoupon) return <CreateCoupon entryType={ENTRY_FOR[role]} listings={myListings} onClose={() => setCreatingCoupon(false)} onCreate={async (c, raw) => {
    setCreatingCoupon(false);
    if (user && raw) { try { await createCoupon(raw); refetchCoupons(); return; } catch (e) { console.warn("create coupon failed", e); } }
    setCoupons((p) => [c, ...p]);
  }} />;

  // Pause / resume a coupon — backend coupons hit PATCH; local (offline) ones
  // just flip in place.
  const toggleCoupon = async (c: DashCoupon) => {
    const next = !(c.active ?? c.status !== "expired");
    if (user && c.id) {
      try { await setCouponActive(c.id, next); refetchCoupons(); return; }
      catch (e) { toast.error((e as ApiErr)?.message || t("m.dashboard.updateCouponError", { defaultValue: "Couldn't update the coupon." })); return; }
    }
    setCoupons((p) => p.map((x) => (x === c ? { ...x, active: next, status: next ? "active" : "expired" } : x)));
  };

  // Delete a coupon for good (confirm first).
  const removeCoupon = (c: DashCoupon) => {
    Alert.alert(t("m.dashboard.deleteCouponTitle", { defaultValue: "Delete coupon?" }), t("m.dashboard.deleteCouponMsg", { defaultValue: "\"{{code}}\" will be removed permanently.", code: c.code }), [
      { text: t("m.dashboard.cancel", { defaultValue: "Cancel" }), style: "cancel" },
      { text: t("m.dashboard.delete", { defaultValue: "Delete" }), style: "destructive", onPress: async () => {
        if (user && c.id) {
          try { await deleteCoupon(c.id); refetchCoupons(); return; }
          catch (e) { toast.error((e as ApiErr)?.message || t("m.dashboard.deleteCouponError", { defaultValue: "Couldn't delete the coupon." })); return; }
        }
        setCoupons((p) => p.filter((x) => x !== c));
      } },
    ]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#f4efe9" }}>
      {/* identity header */}
      <View style={[st.appbar, { paddingTop: insets.top + 4 }]}>
        <Pressable style={st.id} onPress={() => setMenuOpen((o) => !o)}>
          <LinearGradient colors={["#2a2531", "#8b5e4a"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[st.idAv, { overflow: "hidden" }]}>
            {profileQ.data?.avatarUrl ? (
              <Image source={{ uri: profileQ.data.avatarUrl }} style={StyleSheet.absoluteFill as object} />
            ) : (
              <Text style={st.idAvTxt}>{realAvatar}</Text>
            )}
          </LinearGradient>
          <View style={{ flexShrink: 1 }}>
            <Text style={st.idName} numberOfLines={1}>{realName}</Text>
            <Text style={st.idRole}>{t("m.dashboard.roleDashboard", { defaultValue: "{{role}} dashboard", role: t(`m.dashboard.role.${role}`, { defaultValue: ROLE_LABEL[role] }) })}</Text>
          </View>
          <Icon name="chevD" size={16} color={T.muted} />
        </Pressable>
        <Pressable style={({ pressed, hovered }: PressState) => [st.bell, hovered && { backgroundColor: "rgba(255,255,255,0.95)" }, pressed && { opacity: 0.8 }]} onPress={() => nav.navigate("Notifications")}>
          <Icon name="bell" size={20} color={T.aubergine} />
          {/* Count badge only when there are genuinely unread notifications. */}
          {unread > 0 && (
            <View style={st.notifBadge}><Text style={st.notifBadgeTxt}>{unread > 9 ? "9+" : String(unread)}</Text></View>
          )}
        </Pressable>
      </View>

      {/* role switcher */}
      {menuOpen && (
        <>
          <Pressable style={st.scrim} onPress={() => setMenuOpen(false)} />
          <View style={[st.menu, { top: insets.top + 56 }]}>
            <Text style={st.menuLabel}>{t("m.dashboard.yourDashboards", { defaultValue: "YOUR DASHBOARDS" })}</Text>
            {ROLE_META.map(([k, lb, ic]) => (
              <Pressable key={k} style={[st.menuItem, role === k && st.menuItemActive]} onPress={() => { setRole(k); setMenuOpen(false); }}>
                <View style={[st.dmiIco, role === k && { backgroundColor: T.terra }]}><Icon name={ic} size={18} color={role === k ? "#fff" : T.aubergine} /></View>
                <Text style={[st.menuItemTxt, role === k && { color: T.terra }]}>{t(`m.dashboard.role.${k}`, { defaultValue: lb })}</Text>
                {role === k && <Icon name="checkSm" size={17} color={T.terra} strokeWidth={2.6} />}
              </Pressable>
            ))}
            <View style={st.menuDiv} />
            <Pressable style={st.menuItem} onPress={() => { setMenuOpen(false); nav.goBack(); }}>
              <View style={[st.dmiIco, { backgroundColor: "rgba(97,122,146,0.16)" }]}><Icon name="user" size={18} color="#617a92" /></View>
              <View style={{ flex: 1 }}>
                <Text style={st.menuItemTxt}>{t("m.dashboard.switchToGuest", { defaultValue: "Switch to user" })}</Text>
                <Text style={st.idRole}>{t("m.dashboard.useAsCustomer", { defaultValue: "Use IstaSeva as a customer" })}</Text>
              </View>
              <Icon name="arrowUR" size={15} color={T.muted} />
            </Pressable>
          </View>
        </>
      )}

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.aubergine} colors={[T.aubergine]} />}
      >
        {/* KYC banner — signed in: only when no documents uploaded yet.
            Signed out (demo): fall back to the dash config. */}
        {showKycBanner && (
          <Pressable style={({ pressed, hovered }: PressState) => [st.kyc, hovered && { backgroundColor: "rgba(189,135,82,0.13)" }, pressed && { opacity: 0.85 }]} onPress={() => nav.navigate("Kyc")}>
            <View style={st.kycIco}><Icon name="shield" size={18} color="#8b5e4a" /></View>
            <View style={{ flex: 1 }}>
              <Text style={st.kycTitle}>{!user && d.kyc === "submitted" ? t("m.dashboard.kycUnderReviewTitle", { defaultValue: "Verification under review" }) : t("m.dashboard.kycVerifyTitle", { defaultValue: "Verify your identity to go live" })}</Text>
              <Text style={st.bkMeta}>{!user && d.kyc === "submitted" ? t("m.dashboard.kycUnderReviewMsg", { defaultValue: "We're reviewing your documents." }) : t("m.dashboard.kycVerifyMsg", { defaultValue: "Add Aadhaar + a document to start taking bookings." })}</Text>
            </View>
            <Icon name="chevR" size={16} color={T.muted} />
          </Pressable>
        )}

        {/* tabs */}
        <View style={st.tabs} ref={tabsRef}>
          {primaryTabs.map(([id, lb]) => (
            <Pressable key={id} style={({ pressed }: PressState) => [st.tab, pressed && { opacity: 0.6 }]} onPress={() => setTab(id)}>
              <Text style={[st.tabTxt, tab === id && st.tabActive]}>{tabLabel(id, lb)}</Text>
              {tab === id && <View style={st.tabUnderline} />}
            </Pressable>
          ))}
          {moreTabs.length > 0 && (
            <Pressable style={({ pressed }: PressState) => [st.tab, pressed && { opacity: 0.6 }]} onPress={openMore}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                <Text style={[st.tabTxt, activeInMore && st.tabActive]}>{t("m.dashboard.more", { defaultValue: "More" })}</Text>
                <Icon name="chevD" size={14} color={activeInMore ? T.ink : T.muted} />
              </View>
              {activeInMore && <View style={st.tabUnderline} />}
            </Pressable>
          )}
        </View>

        {/* OVERVIEW */}
        {tab === "overview" && (
          <View style={{ marginTop: 16 }}>
            {/* Discoverability nudge — visible until a payout account exists;
                suppressed while the KYC banner is up (one primary nudge). */}
            {!showKycBanner && <PayoutNudge onOpen={() => setTab("payouts")} />}
            <View style={st.welcomeRow}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={st.bkMeta}>{t("m.dashboard.welcomeBack", { defaultValue: "Welcome back" })}</Text>
                <Text style={st.welcomeName} numberOfLines={1}>{realName} · {liveListings.length} {d.listingsLabel.toLowerCase()}</Text>
              </View>
              <Pressable style={st.addBtn} onPress={() => setAdding(true)}>
                <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={st.addInner}>
                  <Icon name="plus" size={16} color="#fff" />
                  <Text style={st.addTxt}>{d.addLabel}</Text>
                </LinearGradient>
              </Pressable>
            </View>
            {/* Today / attention triage — only when there's something to act on. */}
            {todayCount > 0 && (
              <View style={st.todayRow}>
                <Pressable style={st.todayChip} onPress={() => setTab("bookings")}>
                  <Icon name="calendar" size={13} color={T.terra} />
                  <Text style={st.todayTxt}>{t("m.dashboard.todayCount", { defaultValue: "{{count}} today", count: todayCount })}</Text>
                </Pressable>
              </View>
            )}
            <View style={st.statGrid}>{stats.map((s, i) => <StatTile key={i} s={s} onPress={() => setTab(s.tab)} />)}</View>
            <View style={st.earnCard}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                <View>
                  <Text style={st.bkMeta}>{t("m.dashboard.earnTrend", { defaultValue: "Earnings trend" })}</Text>
                  <Text style={st.earnTotal}>{earnTotal}</Text>
                  {!!earnWindowLbl && <Text style={st.earnRange}>{earnWindowLbl}</Text>}
                </View>
                {earnDeltaPct !== undefined ? <TrendChip pct={earnDeltaPct} /> : null}
              </View>
              {earnFromBackend && (
                <View style={st.earnPills}>
                  {([
                    ["30d", t("m.dashboard.range30d", { defaultValue: "30d" })],
                    ["90d", t("m.dashboard.range90d", { defaultValue: "90d" })],
                    ["365d", t("m.dashboard.range1y", { defaultValue: "1y" })],
                    ["all", t("m.dashboard.rangeAll", { defaultValue: "All" })],
                  ] as const).map(([id, lb]) => (
                    <Pressable key={id} style={[st.earnPill, earnRangeId === id && st.earnPillActive]} onPress={() => setEarnRangeId(id)}>
                      <Text style={[st.earnPillTxt, earnRangeId === id && { color: "#fff" }]}>{lb}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
              {earnSeries.some((p) => p.earnings > 0)
                ? <EarningsChart series={earnSeries} />
                : <Text style={st.empty}>{t("m.dashboard.noEarnTrend", { defaultValue: "No earnings in this range yet." })}</Text>}
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 24 }}>
              <Text style={[st.secTitle, { marginBottom: 0 }]}>{t("m.dashboard.upcomingBookings", { defaultValue: "Upcoming bookings" })}</Text>
              <Pressable style={{ flexDirection: "row", gap: 6, alignItems: "center" }} onPress={() => setTab("bookings")}>
                <Text style={st.viewAll}>{t("m.dashboard.viewAll", { defaultValue: "View all" })}</Text>
                <Icon name="chevR" size={14} color={T.aubergine} />
              </Pressable>
            </View>
            <View style={{ gap: 12, marginTop: 12 }}>
              {upcoming.length ? upcoming.slice(0, 3).map((b, i) => <BookingCard key={i} b={b} onCancel={cancelBooking} onOpen={setBookingDetail} />) : <Text style={st.empty}>{t("m.dashboard.noUpcomingBookings", { defaultValue: "No upcoming bookings right now." })}</Text>}
            </View>
          </View>
        )}

        {/* LISTINGS */}
        {tab === "listings" && (
          <View style={{ marginTop: 16 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <Text style={[st.secTitle, { marginBottom: 0 }]}>{d.listingsLabel}</Text>
              <Pressable style={st.miniBtn} onPress={() => setAdding(true)}><Icon name="plus" size={14} color={T.aubergine} /><Text style={st.miniTxt}>{d.addLabel}</Text></Pressable>
            </View>
            <View style={{ gap: 12 }}>
              {/* Saved onboarding draft — resumable, never activatable (it
                  has no backend row yet). Mirrors the web MyListings draft
                  card: Continue onboarding picks up where the host left off;
                  Delete clears the saved progress. */}
              {draft && (
                <View style={[st.bk, st.draftRow]}>
                  <View style={[st.bkIco, { backgroundColor: "#fbf3e4" }]}><Icon name="pencil" size={20} color="#9a6c2e" /></View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={st.draftChip}><Text style={st.draftChipTxt}>{t("m.dashboard.draft", { defaultValue: "Draft" })}</Text></View>
                    <Text style={st.listingName}>
                      {draft.env.form?.name?.trim?.() || t("m.dashboard.untitledDraft", { defaultValue: "Untitled {{kind}} draft", kind: role === "host" ? t("m.dashboard.kindProperty", { defaultValue: "property" }) : role === "transport" ? t("m.dashboard.kindVehicle", { defaultValue: "vehicle" }) : t("m.dashboard.kindService", { defaultValue: "service" }) })}
                    </Text>
                    <Text style={st.bkMeta}>
                      {t("m.dashboard.draftSaved", { defaultValue: "Saved {{when}} · not visible to customers until published", when: draft.savedAt ? describeAge(draft.savedAt) : t("m.dashboard.earlier", { defaultValue: "earlier" }) })}
                    </Text>
                    <View style={st.actions}>
                      <Pressable style={st.act} onPress={() => { setResumingDraft(true); setAdding(true); }}>
                        <Icon name="arrowR" size={14} color={T.ink} /><Text style={st.actTxt}>{t("m.dashboard.continueOnboarding", { defaultValue: "Continue onboarding" })}</Text>
                      </Pressable>
                      <Pressable style={st.act} onPress={deleteDraft}>
                        <Icon name="trash" size={14} color={T.coral} /><Text style={[st.actTxt, { color: T.coral }]}>{t("m.dashboard.delete", { defaultValue: "Delete" })}</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              )}
              {liveListings.map((l, i) => <ListingRow key={i} l={l} role={role} onView={setViewFor} onEdit={setEditing} onToggle={toggleListing} onCalendar={setCalendarFor} onSchedule={setScheduleFor} onServiceSchedule={setServiceScheduleFor} onRooms={setRoomsFor} />)}
              {liveListings.length === 0 && !draft && <Text style={st.empty}>{t("m.dashboard.noListingsYet", { defaultValue: "No {{listings}} yet. Tap “{{add}}” to create one.", listings: d.listingsLabel.toLowerCase(), add: d.addLabel })}</Text>}
            </View>
          </View>
        )}

        {/* BOOKINGS */}
        {tab === "bookings" && (
          <View style={{ marginTop: 16 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <Text style={[st.secTitle, { marginBottom: 0 }]}>{bkLabel}</Text>
              {/* All three partner roles — mirrors the web dashboards. */}
              <Pressable style={st.miniBtn} onPress={() => setBookingForGuest(true)}>
                <Icon name="plus" size={14} color={T.aubergine} />
                <Text style={st.miniTxt}>
                  {role === "host"
                    ? t("m.bfg.title", { defaultValue: "Book for a guest" })
                    : t("m.bfg.titleService", { defaultValue: "Book for a customer" })}
                </Text>
              </Pressable>
            </View>
            <View style={st.pills}>
              {SUBS.map(([k, lb]) => (
                <Pressable key={k} style={[st.pill, sub === k && st.pillActive]} onPress={() => setSub(k)}>
                  <Text style={[st.pillTxt, sub === k && { color: "#fff" }]}>{t(`m.dashboard.sub.${k}`, { defaultValue: lb })} · {counts[k]}</Text>
                </Pressable>
              ))}
            </View>
            <View style={{ gap: 12 }}>
              {liveBookings.filter((b) => b.status === sub).length
                ? liveBookings.filter((b) => b.status === sub).map((b, i) => <BookingCard key={i} b={b} onCancel={cancelBooking} onOpen={setBookingDetail} />)
                : <Text style={st.empty}>{t("m.dashboard.noBookingsOfStatus", { defaultValue: "No {{status}} {{label}}.", status: t(`m.dashboard.sub.${sub}`, { defaultValue: sub }).toLowerCase(), label: bkLabel.toLowerCase() })}</Text>}
            </View>
          </View>
        )}

        {tab === "earnings" && <DashEarnings role={role} onOpenPayouts={() => setTab("payouts")} />}

        {/* PAYOUTS — pending balance, payout account, history */}
        {tab === "payouts" && <PayoutsCard role={role} />}

        {tab === "insights" && <DashInsights role={role} />}

        {tab === "coupons" && (
          <View style={{ marginTop: 16 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <Text style={[st.secTitle, { marginBottom: 0 }]}>{t("m.dashboard.coupons", { defaultValue: "Coupons" })}</Text>
              <Pressable style={({ pressed, hovered }: PressState) => [st.miniBtn, hovered && { borderColor: "rgba(139,94,74,0.4)" }, pressed && { opacity: 0.8 }]} onPress={() => setCreatingCoupon(true)}><Icon name="plus" size={14} color={T.aubergine} /><Text style={st.miniTxt}>{t("m.dashboard.create", { defaultValue: "Create" })}</Text></Pressable>
            </View>
            <View style={{ gap: 12 }}>
              {(couponsFromBackend ? myCoupons : coupons).map((c, i) => (
                <CouponCard key={c.id || i} c={c} onToggle={() => toggleCoupon(c)} onDelete={() => removeCoupon(c)} />
              ))}
              {couponsFromBackend && myCoupons.length === 0 && <Text style={st.empty}>{t("m.dashboard.noCouponsYet", { defaultValue: "No coupons yet. Tap “Create” to add one." })}</Text>}
            </View>
          </View>
        )}

        {tab === "reviews" && <DashReviews d={d} real={provReviews} />}

        {tab === "profile" && (
          <View style={{ marginTop: 16 }}>
            {/* Identity card — real avatar + display name, edit opens the shared ProfileEdit screen */}
            <View style={st.profileCard}>
              <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                <LinearGradient colors={["#2b2436", "#c08a5a"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[st.profileAv, { overflow: "hidden" }]}>
                  {profileQ.data?.avatarUrl ? (
                    <Image source={{ uri: profileQ.data.avatarUrl }} style={StyleSheet.absoluteFill as object} />
                  ) : (
                    <Text style={st.profileAvTxt}>{realAvatar}</Text>
                  )}
                </LinearGradient>
                <View style={{ flex: 1 }}>
                  <Text style={st.profileName} numberOfLines={1}>{profileQ.data?.displayName || realName}</Text>
                  <Text style={st.bkMeta} numberOfLines={1}>{user?.email || ""}</Text>
                  {(kycQ.data?.length ?? 0) > 0 && (
                    <View style={st.verifyChip}><Icon name="badge" size={12} color="#2f7d55" /><Text style={st.verifyTxt}>{t("m.dashboard.documentsSubmitted", { defaultValue: "Documents submitted" })}</Text></View>
                  )}
                </View>
                <Pressable style={st.profileEditBtn} onPress={() => nav.navigate("ProfileEdit")} hitSlop={8}>
                  <Icon name="pencil" size={15} color={T.terra} />
                </Pressable>
              </View>
            </View>

            {/* Role stats — listings / reviews / rating at a glance */}
            <View style={st.profileStatRow}>
              {[
                [String(liveListings.length), d.listingsLabel],
                [String(provReviews.count), t("m.dashboard.reviews", { defaultValue: "Reviews" })],
                [provReviews.count ? provReviews.rating.toFixed(1) : "—", t("m.dashboard.rating", { defaultValue: "Rating" })],
              ].map(([v, l]) => (
                <View key={l} style={st.profileStat}>
                  <Text style={st.profileStatVal}>{v}</Text>
                  <Text style={st.profileStatLbl} numberOfLines={1}>{l}</Text>
                </View>
              ))}
            </View>

            {/* Contact details */}
            <View style={[st.profileCard, { marginTop: 12 }]}>
              {([
                [t("m.dashboard.email", { defaultValue: "Email" }), user?.email || "—"],
                [t("m.dashboard.phone", { defaultValue: "Phone" }), profileQ.data?.phone || user?.phone || "—"],
              ] as [string, string][]).map(([k, v], i, arr) => (
                <View key={k} style={[st.profileRow, i < arr.length - 1 && { borderBottomWidth: 1, borderBottomColor: T.line }]}>
                  <Text style={st.bkMeta}>{k}</Text>
                  <Text style={st.profileVal} numberOfLines={1}>{v}</Text>
                </View>
              ))}
            </View>

            {/* Business details — what the host offers + languages (mirrors web) */}
            {liveListings.length > 0 && (
              <View style={[st.profileCard, { marginTop: 12 }]}>
                <Text style={st.profileSecTitle}>{t("m.dashboard.businessDetails", { defaultValue: "Business details" })}</Text>
                {([
                  [d.listingsLabel, liveListings.map((l) => l.name).join(", ")],
                  [t("m.dashboard.languages", { defaultValue: "Languages" }), formatLanguageList(liveListings.flatMap((l) => l.languages ?? [])) || "—"],
                ] as [string, string][]).map(([k, v], i, arr) => (
                  <View key={k} style={[st.profileRow, { alignItems: "flex-start" }, i < arr.length - 1 && { borderBottomWidth: 1, borderBottomColor: T.line }]}>
                    <Text style={[st.bkMeta, { flexShrink: 0, maxWidth: "40%" }]}>{k}</Text>
                    <Text style={st.profileVal} numberOfLines={3}>{v}</Text>
                  </View>
                ))}
              </View>
            )}

            <Pressable style={[st.miniBtn, { marginTop: 14, minHeight: 50, justifyContent: "center" }]} onPress={() => nav.navigate("ProfileEdit")}>
              <Icon name="pencil" size={15} color={T.aubergine} />
              <Text style={st.miniTxt}>{t("m.dashboard.editProfile", { defaultValue: "Edit profile" })}</Text>
            </Pressable>
            <Pressable style={{ marginTop: 8 }} onPress={() => nav.goBack()}>
              <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={st.switchBtn}>
                <Icon name="user" size={17} color="#fff" />
                <Text style={st.addTxt}>{t("m.dashboard.switchToGuest", { defaultValue: "Switch to user" })}</Text>
              </LinearGradient>
            </Pressable>
          </View>
        )}
      </ScrollView>

      {/* "More" overflow dropdown — anchored below the tab row */}
      <Modal visible={moreOpen} transparent animationType="fade" onRequestClose={() => setMoreOpen(false)}>
        <Pressable style={{ flex: 1 }} onPress={() => setMoreOpen(false)}>
          <View style={[st.moreMenu, { top: moreY }]}>
            {moreTabs.map(([id, lb, ic]) => (
              <Pressable key={id} style={({ pressed }: PressState) => [st.menuItem, tab === id && st.menuItemActive, pressed && { opacity: 0.8 }]} onPress={() => { setTab(id); setMoreOpen(false); }}>
                <View style={[st.dmiIco, tab === id && { backgroundColor: T.terra }]}><Icon name={ic} size={17} color={tab === id ? "#fff" : T.aubergine} /></View>
                <Text style={[st.menuItemTxt, tab === id && { color: T.terra }]}>{tabLabel(id, lb)}</Text>
                {tab === id && <Icon name="checkSm" size={16} color={T.terra} strokeWidth={2.6} />}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* Owner read-only listing detail (View action) */}
      {viewFor && (
        <ListingDetailsSheet apiId={viewFor.apiId} name={viewFor.name} status={viewFor.status} onClose={() => setViewFor(null)} />
      )}

      {/* Host booking detail — same amount breakdown the guest sees */}
      <Modal visible={!!bookingDetail} transparent animationType="slide" onRequestClose={() => setBookingDetail(null)}>
        <Pressable style={st.bdBackdrop} onPress={() => setBookingDetail(null)} />
        {bookingDetail && (
          <View style={[st.bdSheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
            <View style={st.bdHandle} />
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={st.bdTitle} numberOfLines={2}>{bookingDetail.item}</Text>
                <Text style={st.bkMeta}>{bookingDetail.guest}</Text>
              </View>
              <StatusChip status={bookingDetail.status} />
            </View>

            <View style={st.bdCard}>
              <BdRow icon="calendar" label={t("m.dashboard.when", { defaultValue: "When" })} value={bookingDetail.meta || "—"} />
              {bookingDetail.kind === "stay" && !!bookingDetail.roomCount && (
                <BdRow icon="bed" label={t("m.dashboard.rooms", { defaultValue: "Rooms" })} value={t("m.dashboard.roomCount", { defaultValue: "{{count}} room{{plural}}", count: bookingDetail.roomCount, plural: bookingDetail.roomCount > 1 ? "s" : "" })} />
              )}
              {!!bookingDetail.guestCount && (
                <BdRow
                  icon="users"
                  label={bookingDetail.kind === "transport" ? t("m.dashboard.passengers", { defaultValue: "Passengers" }) : t("m.dashboard.guests", { defaultValue: "Guests" })}
                  value={bookingDetail.kind === "transport"
                    ? t("m.dashboard.passengerCount", { defaultValue: "{{count}} passenger{{plural}}", count: bookingDetail.guestCount, plural: bookingDetail.guestCount > 1 ? "s" : "" })
                    : t("m.dashboard.guestCount", { defaultValue: "{{count}} guest{{plural}}", count: bookingDetail.guestCount, plural: bookingDetail.guestCount > 1 ? "s" : "" })}
                />
              )}
              {/* Guest's number — tap to call. On-behalf bookings carry the
                  walk-up guest's contact; otherwise it's the profile phone. */}
              {!!bookingDetail.guestPhone && (
                <Pressable onPress={() => Linking.openURL(`tel:${bookingDetail.guestPhone}`).catch(() => {})}>
                  <BdRow icon="phone" label={t("m.dashboard.guestPhone", { defaultValue: "Guest phone" })} value={bookingDetail.guestPhone} />
                </Pressable>
              )}
              {/* Booked vehicle identity (the car the rider booked). */}
              {bookingDetail.kind === "transport" && !!bookingDetail.vehicleModel && <BdRow icon="car" label={t("m.dashboard.vehicle", { defaultValue: "Vehicle" })} value={bookingDetail.vehicleModel} />}
              {bookingDetail.kind === "transport" && !!bookingDetail.vehicleColor && <BdRow icon="car" label={t("m.dashboard.vehicleColor", { defaultValue: "Colour" })} value={bookingDetail.vehicleColor} />}
              {bookingDetail.kind === "transport" && !!bookingDetail.vehiclePlate && <BdRow icon="tag" label={t("m.dashboard.vehiclePlate", { defaultValue: "Number plate" })} value={bookingDetail.vehiclePlate} />}
            </View>

            {bookingDetail.breakdown && (
              <View style={st.bdCard}>
                <Text style={st.bdSecTitle}>{t("m.dashboard.payment", { defaultValue: "Payment" })}</Text>
                {bookingDetail.breakdown.subtotal > 0 && <BdBill label={t("m.dashboard.subtotal", { defaultValue: "Subtotal" })} value={rupee(bookingDetail.breakdown.subtotal)} />}
                {bookingDetail.breakdown.discount > 0 && <BdBill label={t("m.dashboard.discount", { defaultValue: "Discount" })} value={`-${rupee(bookingDetail.breakdown.discount)}`} accent />}
                {bookingDetail.breakdown.fee > 0 && <BdBill label={t("m.dashboard.platformFee", { defaultValue: "Platform fee" })} value={rupee(bookingDetail.breakdown.fee)} />}
                {bookingDetail.breakdown.tax > 0 && <BdBill label={t("m.dashboard.gst", { defaultValue: "GST" })} value={rupee(bookingDetail.breakdown.tax)} />}
                {bookingDetail.breakdown.insurance > 0 && <BdBill label={t("m.dashboard.tripProtection", { defaultValue: "Trip protection" })} value={rupee(bookingDetail.breakdown.insurance)} />}
                <View style={st.bdDivider} />
                <BdBill label={t("m.dashboard.totalPaidByGuest", { defaultValue: "Total paid by guest" })} value={rupee(bookingDetail.amount)} strong />
              </View>
            )}

            <Pressable style={({ pressed }) => [st.bdClose, pressed && { opacity: 0.85 }]} onPress={() => setBookingDetail(null)}>
              <Text style={st.bdCloseTxt}>{t("m.dashboard.close", { defaultValue: "Close" })}</Text>
            </Pressable>
          </View>
        )}
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  appbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 14, paddingBottom: 8 },
  id: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1, minWidth: 0, padding: 4, borderRadius: 14 },
  idAv: { width: 40, height: 40, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  idAvTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 14.5 },
  idName: { fontSize: 15, fontFamily: font.head, color: T.ink },
  idRole: { fontSize: 11.5, color: T.muted, fontFamily: font.bodyBold },
  bell: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.7)" },
  notifBadge: { position: "absolute", top: 5, right: 5, minWidth: 17, height: 17, paddingHorizontal: 4, borderRadius: 999, backgroundColor: T.coral, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: "#f4efe9" },
  notifBadgeTxt: { fontSize: 9.5, fontFamily: font.bodyHeavy, color: "#fff", lineHeight: 12 },
  trend: { flexDirection: "row", alignItems: "center", gap: 2, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999 },
  trendTxt: { fontSize: 10.5, fontFamily: font.bodyHeavy },
  todayRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14, marginTop: -2 },
  todayChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: "rgba(139,94,74,0.28)", backgroundColor: "rgba(139,94,74,0.08)" },
  todayTxt: { fontSize: 12.5, fontFamily: font.bodyHeavy, color: T.terra },
  scrim: { ...StyleSheet.absoluteFillObject, zIndex: 24 },
  menu: { position: "absolute", left: 16, zIndex: 26, width: 250, padding: 8, borderRadius: 18, backgroundColor: "#fff", borderWidth: 1, borderColor: T.line, shadowColor: "#241e1c", shadowOffset: { width: 0, height: 20 }, shadowOpacity: 0.22, shadowRadius: 44, elevation: 20 },
  menuLabel: { fontSize: 10.5, fontFamily: font.bodyHeavy, letterSpacing: 0.5, color: T.muted, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 8 },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 11, padding: 10, borderRadius: 12 },
  menuItemActive: { backgroundColor: "rgba(139,94,74,0.09)" },
  menuItemTxt: { flex: 1, fontSize: 14, fontFamily: font.bodyBold, color: T.ink },
  dmiIco: { width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: T.greenSoft },
  menuDiv: { height: 1, backgroundColor: T.line, marginVertical: 7, marginHorizontal: 6 },
  moreMenu: { position: "absolute", right: 20, top: 0, zIndex: 26, width: 212, padding: 8, borderRadius: 16, backgroundColor: "#fff", borderWidth: 1, borderColor: T.line, shadowColor: "#241e1c", shadowOffset: { width: 0, height: 20 }, shadowOpacity: 0.22, shadowRadius: 44, elevation: 20 },
  kyc: { flexDirection: "row", alignItems: "center", gap: 11, padding: 13, borderRadius: 18, marginTop: 4, borderWidth: 1, borderColor: "rgba(189,135,82,0.28)", backgroundColor: "rgba(189,135,82,0.08)" },
  kycIco: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(189,135,82,0.16)" },
  kycTitle: { fontSize: 13, fontFamily: font.bodyBold, color: T.ink },
  tabs: { flexDirection: "row", justifyContent: "space-between", gap: 6, borderBottomWidth: 1, borderBottomColor: T.line, marginTop: 16 },
  tab: { paddingTop: 11, paddingBottom: 13, alignItems: "center" },
  tabTxt: { fontSize: 12.5, fontFamily: font.bodyBold, color: T.muted },
  tabActive: { color: T.ink },
  tabUnderline: { position: "absolute", left: 0, right: 0, bottom: -1, height: 2.5, borderTopLeftRadius: 3, borderTopRightRadius: 3, backgroundColor: T.terra },
  welcomeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12 },
  welcomeName: { fontFamily: font.headHeavy, fontSize: 16, marginTop: 1, color: T.ink },
  addBtn: { borderRadius: 12, overflow: "hidden" },
  addInner: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 40, paddingHorizontal: 14 },
  addTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 14 },
  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  statTile: { width: "47%", flexGrow: 1, padding: 15, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.85)" },
  dsIco: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(189,135,82,0.14)" },
  // headHeavy (800 ExtraBold) so the headline numbers carry more weight than
  // surrounding 700-bold text (web parity: font-extrabold on the same tiles).
  statVal: { fontSize: 23, fontFamily: font.headHeavy, color: T.ink, marginTop: 12 },
  statLabel: { fontSize: 12, color: T.muted, marginTop: 1, fontFamily: font.body },
  statDesc: { fontSize: 10.5, color: T.muted, fontFamily: font.body },
  earnCard: { padding: 16, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.85)", marginTop: 16 },
  earnTotal: { fontSize: 24, fontFamily: font.head, color: T.ink },
  earnRange: { fontSize: 11, color: T.muted, fontFamily: font.body, marginTop: 2 },
  earnPills: { flexDirection: "row", gap: 6, marginTop: 12 },
  earnPill: { flex: 1, paddingVertical: 7, borderRadius: 999, alignItems: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.56)" },
  earnPillActive: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  earnPillTxt: { fontSize: 11.5, color: T.muted, fontFamily: font.bodyHeavy },
  secTitle: { fontSize: 16, fontFamily: font.headHeavy, color: T.ink, marginBottom: 12 },
  viewAll: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 13 },
  empty: { color: T.muted, fontSize: 13, textAlign: "center", padding: 20, fontFamily: font.body },
  bk: { flexDirection: "row", gap: 13, padding: 12, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.85)" },
  draftRow: { borderColor: "rgba(213,170,96,0.55)", backgroundColor: "rgba(253,248,238,0.92)" },
  draftChip: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: "#f6e7c8", borderWidth: 1, borderColor: "#e3c98f" },
  draftChipTxt: { fontSize: 10, fontFamily: font.bodyHeavy, color: "#8a6420", letterSpacing: 0.3 },
  bkIco: { width: 56, height: 56, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  guestAv: { width: 24, height: 24, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(189,135,82,0.16)" },
  guestAvTxt: { fontSize: 10, fontFamily: font.bodyHeavy, color: "#8b5e4a" },
  guest: { fontSize: 14, fontFamily: font.bodyBold, color: T.ink, flex: 1 },
  bkMeta: { color: T.muted, fontSize: 12, marginTop: 4, fontFamily: font.body },
  bkAmt: { fontSize: 14, fontFamily: font.bodyHeavy, color: T.ink },
  bkWhen: { fontSize: 12, color: T.muted, fontFamily: font.body },
  cancelBtn: { minHeight: 32, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: T.line, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.6)" },
  cancelTxt: { color: T.coral, fontFamily: font.bodyHeavy, fontSize: 12 },
  listingName: { fontSize: 15, fontFamily: font.head, color: T.ink, marginTop: 8 },
  listingPrice: { fontSize: 13, fontFamily: font.bodyBold, color: T.ink },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 11, paddingTop: 11, borderTopWidth: 1, borderTopColor: T.line },
  act: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 7, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  actTxt: { fontSize: 12, fontFamily: font.bodyBold, color: T.ink },
  miniBtn: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 40, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.6)" },
  miniTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 13 },
  pills: { flexDirection: "row", gap: 8, marginBottom: 14, flexWrap: "wrap" },
  pill: { paddingVertical: 8, paddingHorizontal: 15, borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.5)" },
  pillActive: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  pillTxt: { fontFamily: font.bodyBold, fontSize: 13, color: T.muted },
  coupon: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.85)" },
  couponTag: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(189,135,82,0.14)" },
  couponCode: { fontSize: 14, fontFamily: font.bodyHeavy, color: T.ink, letterSpacing: 0.4 },
  couponOff: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999, backgroundColor: "rgba(47,125,85,0.1)" },
  couponOffTxt: { fontSize: 11, fontFamily: font.bodyHeavy, color: "#2f7d55" },
  couponSwitch: { width: 44, height: 26, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.18)", justifyContent: "center", paddingHorizontal: 3 },
  couponKnob: { width: 20, height: 20, borderRadius: 999, backgroundColor: "#fff" },
  couponDel: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(58,50,71,0.12)" },
  profileCard: { padding: 18, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.85)" },
  profileAv: { width: 64, height: 64, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  profileAvTxt: { color: "#fff", fontFamily: font.headHeavy, fontSize: 24 },
  profileName: { fontSize: 18, fontFamily: font.head, color: T.ink },
  verifyChip: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", marginTop: 8, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: "rgba(47,125,85,0.1)", borderWidth: 1, borderColor: "rgba(47,125,85,0.25)" },
  verifyTxt: { color: "#2f7d55", fontSize: 12, fontFamily: font.bodyHeavy },
  profileRow: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 12 },
  profileEditBtn: { width: 38, height: 38, borderRadius: 999, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(139,94,74,0.28)", backgroundColor: "rgba(139,94,74,0.08)" },
  profileStatRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  profileStat: { flex: 1, alignItems: "center", paddingVertical: 14, borderRadius: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.85)" },
  profileStatVal: { fontSize: 18, fontFamily: font.headHeavy, color: T.ink },
  profileStatLbl: { fontSize: 11, fontFamily: font.bodySemi, color: T.muted, marginTop: 2 },
  profileSecTitle: { fontSize: 15, fontFamily: font.head, color: T.ink, marginBottom: 4 },
  profileVal: { fontSize: 13, fontFamily: font.bodySemi, color: T.ink, textAlign: "right", flex: 1 },
  switchBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 50, borderRadius: 16 },

  // Host booking detail sheet
  bdBackdrop: { flex: 1, backgroundColor: "rgba(23,20,29,0.4)" },
  bdSheet: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: "#f4efe9", borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 20, gap: 14 },
  bdHandle: { alignSelf: "center", width: 40, height: 4, borderRadius: 999, backgroundColor: "rgba(23,20,29,0.18)", marginBottom: 4 },
  bdTitle: { fontSize: 18, fontFamily: font.head, color: T.ink },
  bdCard: { padding: 16, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.85)", gap: 12 },
  bdSecTitle: { fontSize: 15, fontFamily: font.headHeavy, color: T.ink },
  bdInfoRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  bdInfoIco: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(58,50,71,0.08)" },
  bdInfoLabel: { fontSize: 11, fontFamily: font.bodyHeavy, letterSpacing: 0.4, color: T.muted, textTransform: "uppercase" },
  bdInfoVal: { fontSize: 14, fontFamily: font.bodyBold, color: T.ink, marginTop: 1 },
  bdBillRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  bdBillLabel: { fontSize: 13.5, fontFamily: font.body, color: T.muted },
  bdBillVal: { fontSize: 13.5, fontFamily: font.bodyBold, color: T.ink },
  bdBillStrong: { fontSize: 15, fontFamily: font.headHeavy, color: T.ink },
  bdDivider: { height: 1, backgroundColor: T.line, marginVertical: 2 },
  bdClose: { minHeight: 50, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  bdCloseTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 15 },
});
