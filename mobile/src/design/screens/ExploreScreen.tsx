// design/screens/ExploreScreen.tsx — ported from explore.jsx.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, findNodeHandle } from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Background } from "../Background";
import { Icon } from "../Icon";
import { Segmented, SectionHead, IconBtn } from "../primitives";
import { SearchSheet } from "./SearchSheet";
import { FilterSheet, Filters, EMPTY_FILTERS, countActiveFilters, stayPass, svcPass, trPass, ExploreFilterIntent } from "./FilterSheet";
import { StayCard, ServiceCard, TransportCard, PackageCard, transportPriceForMode } from "./cards";
import { T, font } from "../theme";
import { useLanguage } from "@/contexts/LanguageContext";
import { useCatalog } from "../api/hooks";
import { placePredictions, placeDetails, distanceKm, adminMatches, SEARCH_RADIUS_KM, PlaceDetails, PlacePrediction } from "../api/geocode";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/lib/toast";
import { useRecentSearches, RecentSearch, SearchCategory } from "../api/recentSearches";
import { logDateRange } from "../api/searchEvents";
import { track, setAnalyticsOrigin } from "../api/analyticsEvents";
import * as Location from "expo-location";
import type { DateRange } from "./DateRangeSheet";
import type { RootParamList } from "../Navigator";

type Picked = PlaceDetails & { label: string };

// Params the assistant (AiChatScreen) sends when it navigates to this tab.
type ExploreRouteParams = {
  applyIntent?: ExploreFilterIntent;
  applyNonce?: number;
  locateIntent?: { id: string; seg?: string; listingType?: string };
  locateNonce?: number;
};

// The place-ish fields the geo/search helpers below read off a catalog row —
// Stay / Service / Transport each carry a subset, all optional here.
type GeoItem = {
  lat?: number;
  lng?: number;
  location?: string;
  district?: string;
  city?: string;
  area?: string;
  locality?: string;
  address?: string;
};

// One location-permission request per app process (see origin effect below).
let didRequestOrigin = false;

const SVC_MODES: [string, string, string][] = [
  ["at-home", "home", "At home"],
  ["visit-provider", "store", "Visit"],
  ["online", "globe", "Online"],
];
const TR_MODES: [string, string, string][] = [
  ["package", "landmark", "Package"],
  ["hourly", "clock", "Hourly"],
  ["day", "calendar", "Full day"],
];
const SEGS: [string, string, string][] = [
  ["services", "sparkle", "Services"],
  ["transport", "car", "Transport"],
  ["stays", "bedDouble", "Stays"],
];

// How many stays to show inline before the "Show all on the map" CTA.
const STAY_PREVIEW = 6;
const norm = (v: unknown) => String(v == null ? "" : v).toLowerCase();

// Sort options — mirrors web's SortPopover (MarketplaceControls.tsx) plus
// "nearest" (mobile-only; web exposes distance via its separate Near-me
// button). Sorted client-side; "recommended" keeps the backend order.
type SortValue = "recommended" | "price-asc" | "price-desc" | "rating" | "nearest";
const SORT_OPTIONS: [SortValue, string][] = [
  ["recommended", "Recommended"],
  ["nearest", "Nearest first"],
  ["price-asc", "Price: low to high"],
  ["price-desc", "Price: high to low"],
  ["rating", "Top rated"],
];

/** Compact sort pill that pops an anchored dropdown (same idiom as the
 *  dashboard's DashSelect). Sits on the right of a section header; the trigger
 *  shows the CURRENT selection ("Recommended" by default) and tints terra
 *  while a non-default sort is applied so the state is visible even closed. */
function SortMenu({ value, onChange }: { value: SortValue; onChange: (v: SortValue) => void }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const active = value !== "recommended";
  const currentLabel = t(`m.explore.sort.${value}`, { defaultValue: SORT_OPTIONS.find(([v]) => v === value)?.[1] ?? "Sort" });
  return (
    <View style={styles.sortWrap}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`${t("m.explore.sortLabel", { defaultValue: "Sort" })}: ${currentLabel}`}
        style={({ pressed }) => [styles.sortBtn, active && styles.sortBtnActive, open && { borderColor: "rgba(139,94,74,0.5)" }, pressed && { opacity: 0.85 }]}
      >
        <Text style={[styles.sortBtnTxt, active && styles.sortBtnTxtActive]} numberOfLines={1}>{currentLabel}</Text>
        <Icon name="chevD" size={14} color={active ? T.terra : T.muted} />
      </Pressable>
      {open && (
        <View style={styles.sortMenu}>
          {SORT_OPTIONS.map(([v, lb]) => (
            <Pressable
              key={v}
              onPress={() => { onChange(v); setOpen(false); }}
              accessibilityRole="button"
              style={({ pressed }) => [styles.sortItem, v === value && styles.sortItemOn, pressed && { opacity: 0.8 }]}
            >
              <Text style={[styles.sortItemTxt, v === value && { color: T.terra }]} numberOfLines={1}>
                {t(`m.explore.sort.${v}`, { defaultValue: lb })}
              </Text>
              {v === value && <Icon name="checkSm" size={15} color={T.terra} strokeWidth={2.6} />}
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function SearchEmpty({ query }: { query: string }) {
  const { t } = useLanguage();
  return (
    <View style={styles.searchEmpty}>
      <Icon name="search" size={26} color={T.muted} />
      <Text style={styles.seTitle}>{t("m.explore.noMatches", { defaultValue: "No matches for “{{query}}”", query })}</Text>
    </View>
  );
}

export function ExploreScreen() {
  const { t } = useLanguage();
  const nav = useNavigation<NativeStackNavigationProp<RootParamList>>();
  const insets = useSafeAreaInsets();
  // Per-segment day filter (services/transport) — hides listings fully booked
  // or closed on the chosen day. Stays keep their own dateRange (context only).
  const [svcRange, setSvcRange] = useState<DateRange>({ start: null, end: null });
  const [trRange, setTrRange] = useState<DateRange>({ start: null, end: null });
  // (day/date/guest picker visibility lives inside SearchSheet now)
  const C = useCatalog({ serviceRange: svcRange, transportRange: trRange });
  // Localized segment / mode option labels (structure + value/icon ids kept).
  const SEGS_L = SEGS.map(([v, ic, lb]) => [v, ic, t(`m.explore.seg.${v}`, { defaultValue: lb })] as [string, string, string]);
  const SVC_MODES_L = SVC_MODES.map(([v, ic, lb]) => [v, ic, t(`m.explore.svcMode.${v}`, { defaultValue: lb })] as [string, string, string]);
  const TR_MODES_L = TR_MODES.map(([v, ic, lb]) => [v, ic, t(`m.explore.trMode.${v}`, { defaultValue: lb })] as [string, string, string]);
  // Localized count helpers (replace the English `plural` at render sites).
  const nResults = (n: number) => t("m.explore.nResults", { defaultValue: "{{count}} results", count: n });
  const nStays = (n: number) => t("m.explore.nStays", { defaultValue: "{{count}} stays", count: n });
  const nFilters = (n: number) => t("m.explore.nFilters", { defaultValue: "{{count}} filters", count: n });
  const [seg, setSeg] = useState("services");
  const [stayFilter] = useState("All");
  const [svcMode, setSvcMode] = useState("at-home");
  const [trMode, setTrMode] = useState("package");
  // Per-segment search state — each of stays / services / transport keeps its
  // own query text and picked place, so a search in one tab never bleeds into
  // another (parity with web, where each tab is a separate page). `picked` is
  // only ever set from Stays (predictions are gated to it), so isolating it
  // per-segment also stops a stay's geo filter from narrowing services/transport.
  const [queryBySeg, setQueryBySeg] = useState<Record<string, string>>({ stays: "", services: "", transport: "" });
  const [pickedBySeg, setPickedBySeg] = useState<Record<string, Picked | null>>({ stays: null, services: null, transport: null });
  const query = queryBySeg[seg] ?? "";
  const picked = pickedBySeg[seg] ?? null;
  const setQueryFor = (s: string, v: string) => setQueryBySeg((m) => ({ ...m, [s]: v }));
  const setPickedFor = (s: string, v: Picked | null) => setPickedBySeg((m) => ({ ...m, [s]: v }));
  const setQuery = (v: string) => setQueryFor(seg, v);
  const setPicked = (v: Picked | null) => setPickedFor(seg, v);
  const [filterOpen, setFilterOpen] = useState(false);
  // Full search bottom sheet — the Explore bar is now a trigger, not an
  // inline input; all search state stays here (per-segment) and applies live.
  const [searchOpen, setSearchOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // Per-segment sort (parity with web, where each tab keeps its own sort state)
  // — picking a sort in one tab never reorders another.
  const [sortBySeg, setSortBySeg] = useState<Record<string, SortValue>>({ stays: "recommended", services: "recommended", transport: "recommended" });
  const sort = sortBySeg[seg] ?? "recommended";
  const setSort = (v: SortValue) => setSortBySeg((m) => ({ ...m, [seg]: v }));
  // Device coords for "Nearest first". Fetched lazily on first pick (never at
  // mount) and cached for the session. If permission is denied or the fix
  // fails, the sort is NOT applied — the current sort stays in effect and a
  // toast explains why, so the list never silently pretends to be by-distance.
  const [device, setDevice] = useState<{ lat: number; lng: number } | null>(null);
  const handleSort = (v: SortValue) => {
    if (v !== "nearest") { setSort(v); return; }
    if (device) { setSort("nearest"); return; }
    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") throw new Error("denied");
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setDevice({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setSort("nearest");
      } catch {
        toast.info(t("m.explore.sortNearestDenied", { defaultValue: "Turn on location access to sort by distance." }));
      }
    })();
  };
  const activeFilters = countActiveFilters(filters, seg);
  const [preds, setPreds] = useState<PlacePrediction[]>([]);
  const [predOpen, setPredOpen] = useState(false);
  const predTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipPred = useRef(false);
  // Stays search extras: date range (captured context, not a catalog filter —
  // matches web), its picker sheet, and the per-user recent-search list. The
  // recents hook is keyed on the active segment, so each of stays / services /
  // transport keeps (and shows) its own last-3 list.
  const { user } = useAuth();
  const { recents, record, remove: removeRecent, clear: clearRecents } = useRecentSearches(seg as SearchCategory, user?.id);
  const [dateRange, setDateRange] = useState<DateRange>({ start: null, end: null });

  // Coarse origin for analytics (city/state only, never coordinates). One
  // request per app-process (module guard) so remounts don't re-prompt; every
  // failure path is swallowed — origin simply stays unset unless the user
  // grants location AND the reverse geocode resolves.
  useEffect(() => {
    if (didRequestOrigin) return;
    didRequestOrigin = true;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const [g] = await Location.reverseGeocodeAsync({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        const city = g?.city || g?.district || "";
        if (city) setAnalyticsOrigin(city, g?.region || "");
      } catch {
        // analytics origin is best-effort
      }
    })();
  }, []);

  // Assistant-driven filtering: the AI's `apply_filters` action navigates here
  // with a translated ExploreFilterIntent. Keyed on `applyNonce` so re-sending
  // the same filter from chat re-applies it (state may already match).
  const route = useRoute<RouteProp<{ Explore: ExploreRouteParams | undefined }, "Explore">>();
  const applyNonce = route.params?.applyNonce as number | undefined;
  useEffect(() => {
    const intent = route.params?.applyIntent as ExploreFilterIntent | undefined;
    if (!intent) return;
    // Target the intent's segment explicitly — `seg` state is stale within this
    // pass, so the plain per-segment setters would write to the old tab.
    const target = intent.seg || seg;
    if (intent.seg) setSeg(intent.seg);
    if (intent.svcMode) setSvcMode(intent.svcMode);
    if (intent.trMode) setTrMode(intent.trMode);
    if (typeof intent.query === "string") {
      setQueryFor(target, intent.query);
      setPickedFor(target, null); // a fresh text needle supersedes any picked geo filter
    }
    if (intent.filters) setFilters((prev) => ({ ...prev, ...intent.filters }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyNonce]);

  // Assistant-driven "point it out": the AI's locate_listing / highlight_listing
  // action navigates here with { id, seg, listingType }. We switch to the right
  // segment, scroll the card into view, and flash it — the mobile equivalent of
  // web's highlightMarketplaceCard (scroll + flash). If the card isn't in the
  // loaded list (filtered out / other mode), we fall back to its detail page,
  // mirroring web's highlightMarketplaceCard() returning false. Keyed on
  // locateNonce so re-asking re-runs even when the segment already matches.
  const scrollRef = useRef<ScrollView>(null);
  const cardRefs = useRef<Record<string, View | null>>({});
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const locateNonce = route.params?.locateNonce as number | undefined;
  useEffect(() => {
    const intent = route.params?.locateIntent as { id: string; seg?: string; listingType?: string } | undefined;
    if (!intent?.id) return;
    const id = intent.id;
    if (intent.seg) setSeg(intent.seg);
    let cancelled = false;
    let tries = 0;
    const attempt = () => {
      if (cancelled) return;
      const node = cardRefs.current[id];
      const scroller = scrollRef.current;
      if (node && scroller && typeof node.measureLayout === "function") {
        const handle = findNodeHandle(scroller);
        if (handle != null) {
          node.measureLayout(
            handle,
            (_x: number, y: number) => scroller.scrollTo({ y: Math.max(0, y - 90), animated: true }),
            () => {},
          );
        }
        setHighlightId(id);
        setTimeout(() => setHighlightId((cur) => (cur === id ? null : cur)), 2200);
        return;
      }
      if (tries++ < 8) { setTimeout(attempt, 120); return; }
      // Not on screen — open the detail page instead (web parity fallback).
      const screen: "StayDetail" | "ServiceDetail" | "TransportDetail" =
        intent.listingType === "service" ? "ServiceDetail"
        : intent.listingType === "transport" ? "TransportDetail"
        : "StayDetail";
      nav.navigate(screen, { id });
    };
    const tmo = setTimeout(attempt, 200); // let the setSeg re-render land first
    return () => { cancelled = true; clearTimeout(tmo); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateNonce]);

  // Live place predictions as the user types in the search bar (debounced).
  // STAYS ONLY — services/transport are plain keyword searches over the
  // catalog (driver, provider, category, …), same as web. Gating here keeps
  // those segments from calling the geocode API and popping a destination
  // dropdown over what is a text search. Switching segments closes it.
  useEffect(() => {
    if (skipPred.current) { skipPred.current = false; return; }
    if (predTimer.current) clearTimeout(predTimer.current);
    const qv = query.trim();
    if (seg !== "stays" || qv.length < 3) { setPreds([]); setPredOpen(false); return; }
    predTimer.current = setTimeout(async () => {
      const list = await placePredictions(qv);
      setPreds(list);
      setPredOpen(list.length > 0);
    }, 300);
    return () => { if (predTimer.current) clearTimeout(predTimer.current); };
  }, [query, seg]);

  const pickPlace = async (pr: PlacePrediction) => {
    skipPred.current = true;
    setQuery(pr.mainText || pr.description);
    setPredOpen(false);
    setPreds([]);
    const d = await placeDetails(pr.id);
    if (d) setPicked({ ...d, label: pr.mainText || pr.description });
  };
  const clearPicked = () => { setPicked(null); skipPred.current = true; setQuery(""); };

  // Switching tabs shows that tab's own (persisted) search — nothing carries
  // over. Close any open stays predictions and skip the next prediction run so
  // returning to a tab with a stored query doesn't auto-reopen the dropdown.
  const onSegChange = (s: string) => {
    skipPred.current = true;
    setPredOpen(false);
    setPreds([]);
    setSeg(s);
  };

  // ── Recent searches: debounced snapshot of a RESOLVED search ──
  // Mirrors the web's idle capture, but only records a settled search: either a
  // picked place (geo), or free text the user has stopped on. The `!predOpen`
  // gate is the fix for the duplicate chip — while the prediction dropdown is
  // open the user is mid-selection, so recording the partial text would create a
  // second chip alongside the place they're about to tap. Dedup/cap-3 live in
  // the hook, which is keyed on `seg` so the snapshot lands in the active
  // segment's own list. Dates/guests are stays-only inputs — services/transport
  // snapshots carry the neutral defaults so recalling one never restores stale
  // stay dates.
  // Build + store a snapshot of the CURRENT search for the active segment.
  // No-ops when nothing is settled to record (needs a picked place or 3+ typed
  // chars). Places + dates + guests are a stays-only concept (predictions are
  // gated to that segment) — services/transport snapshots are text-only, same
  // as web.
  const captureRecent = () => {
    const isStays = seg === "stays";
    const hasPlace = isStays && !!picked;
    const text = query.trim();
    if (!hasPlace && text.length < 3) return;
    record({
      search: hasPlace ? picked!.label : text,
      place: hasPlace
        ? { lat: picked!.lat, lng: picked!.lng, locality: picked!.locality, district: picked!.district, state: picked!.state, description: picked!.label }
        : null,
      // Services/transport snapshot their single availability day as
      // dateRange.start (end null) so the chip can show + restore it.
      dateRange: isStays
        ? { start: dateRange.start, end: dateRange.end }
        : (seg === "services"
            ? { start: svcRange.start, end: svcRange.end }
            : { start: trRange.start, end: trRange.end }),
      minGuests: isStays ? filters.guests : 1,
    });
    const ltype = seg === "stays" ? "stay" : seg === "services" ? "service" : "transport";
    // Count of what the user currently sees for the active segment — free-text
    // searches use the keyword-filtered lists, a picked place uses the geo
    // browse lists. Snapshot at capture time (same debounce as the recent).
    const resultCount =
      seg === "stays" ? (searching ? stayResults.length : stays.length)
      : seg === "services" ? (searching ? svcResults.length : svcs.length)
      : searching ? drvResults.length + pkgResults.length : transBrowse.length;
    void track("search_performed", {
      listingType: ltype,
      source: `explore_${seg}`,
      // Free-text term only (place-picked stay searches carry no keyword).
      // A picked place also ships its city/state (never coordinates) — feeds
      // the partner dashboards' "where customers search" panel (parity: web).
      props: {
        hasPlace,
        queryLength: text.length,
        resultCount,
        ...(text ? { q: text.toLowerCase().slice(0, 60) } : {}),
        ...(hasPlace && (picked!.locality || picked!.district) ? { city: (picked!.locality || picked!.district)! } : {}),
        ...(hasPlace && picked!.state ? { state: picked!.state } : {}),
      },
    });
  };

  // Card taps → card_clicked, then open the detail screen. Keeps the analytics
  // call out of the JSX so every card list shares one instrumented path.
  const openStay = (id: string) => { void track("card_clicked", { listingId: String(id), listingType: "stay", source: "explore" }); nav.navigate("StayDetail", { id }); };
  const openService = (id: string) => { void track("card_clicked", { listingId: String(id), listingType: "service", source: "explore" }); nav.navigate("ServiceDetail", { id }); };
  const openTransport = (id: string, mode: string) => { void track("card_clicked", { listingId: String(id), listingType: "transport", source: "explore" }); nav.navigate("TransportDetail", { id, mode }); };

  // Debounced capture for TYPING — coalesces keystrokes. The `!predOpen` gate
  // stops a partial text snapshot while the user is mid-selection in the stays
  // predictions dropdown. The stays refinements (guests / dates) are in the deps
  // so the pending timer is rescheduled with current values on each change.
  useEffect(() => {
    const isStays = seg === "stays";
    const hasPlace = isStays && !!picked;
    const text = query.trim();
    const settledText = text.length >= 3 && !predOpen;
    if (!hasPlace && !settledText) return;
    const timer = setTimeout(() => captureRecent(), 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seg, picked, query, predOpen, filters.guests, dateRange.start, dateRange.end, svcRange.start, svcRange.end, trRange.start, trRange.end]);

  // Commit a picked date range and log the completed range for analytics —
  // separate from the recents capture above (parity with web).
  const handleDates = (next: DateRange) => {
    setDateRange(next);
    if (next.start && next.end) {
      void logDateRange({
        listingType: "stay",
        fromDate: next.start,
        toDate: next.end,
        context: { q: query.trim() || undefined, place: picked?.label || undefined },
      });
    }
  };

  // One-tap recall: restore text + place + dates + guests atomically. skipPred
  // suppresses the prediction refetch the restored query text would trigger.
  // Stays recents restore place/dates/guests; services/transport restore the
  // query + their single availability day (dateRange.start).
  const applyRecent = (r: RecentSearch) => {
    skipPred.current = true;
    setQuery(r.search);
    setPicked(r.place
      ? { lat: r.place.lat, lng: r.place.lng, locality: r.place.locality, district: r.place.district, state: r.place.state, label: r.place.description }
      : null);
    if (r.category === "stays") {
      setDateRange(r.dateRange);
      setFilters((f) => ({ ...f, guests: r.minGuests }));
    } else if (r.category === "services") {
      setSvcRange({ start: r.dateRange.start ?? null, end: r.dateRange.end ?? null });
    } else if (r.category === "transport") {
      setTrRange({ start: r.dateRange.start ?? null, end: r.dateRange.end ?? null });
    }
    setPredOpen(false);
  };

  const fmtDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleString("en-IN", { day: "numeric", month: "short" });
  const datesLabel = (r: DateRange): string | null => {
    // Single-day snapshot (services/transport availability filter).
    if (r.start && !r.end) return fmtDay(r.start);
    if (!r.start || !r.end) return null;
    const a = new Date(`${r.start}T00:00:00`);
    const b = new Date(`${r.end}T00:00:00`);
    const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
    return sameMonth ? `${a.getDate()}–${b.getDate()} ${b.toLocaleString("en-IN", { month: "short" })}` : `${fmtDay(r.start)} – ${fmtDay(r.end)}`;
  };
  // SearchSheet rows split the recent into main text (left) + date (right);
  // the Explore chips below keep the combined recentLabel.
  const recentMain = (r: RecentSearch): string => {
    const parts: string[] = [];
    const where = r.place?.locality || r.place?.district || r.place?.state || r.search.trim();
    if (where) parts.push(where);
    if (r.minGuests > 1) parts.push(t("m.search.guestsCount", { defaultValue: "{{count}} guests", count: r.minGuests }));
    return parts.join(" · ");
  };
  const recentLabel = (r: RecentSearch): string => {
    const parts: string[] = [];
    const where = r.place?.locality || r.place?.district || r.place?.state || r.search.trim();
    if (where) parts.push(where);
    const dl = datesLabel(r.dateRange);
    if (dl) parts.push(dl);
    if (r.minGuests > 1) {
      parts.push(t("m.search.guestsCount", { defaultValue: "{{count}} guests", count: r.minGuests }));
    }
    return parts.join(" · ");
  };

  // Catalog geo-filter: when a place is picked, keep listings within 50 km OR
  // whose city/district matches the picked admin hierarchy (mirrors the web).
  const matchesPlace = (x: GeoItem) => {
    if (!picked) return true;
    if (distanceKm(x, picked) <= SEARCH_RADIUS_KM) return true;
    return [x.location, x.district, x.city, x.area, x.locality].some(
      (n) => adminMatches(n, picked.locality) || adminMatches(n, picked.district),
    );
  };
  const geo = <X extends GeoItem,>(arr: X[]): X[] => (picked ? arr.filter(matchesPlace) : arr);

  // Client-side sort over the browse lists (mirrors web's per-tab comparators:
  // stays/services sort on price, transport on the active mode's rate;
  // "recommended" keeps the backend order untouched). "nearest" needs device
  // coords — handleSort never sets it without them, but if they're somehow
  // absent the list falls back to the backend order rather than lying.
  // Listings without coordinates sort last (distanceKm returns Infinity).
  const sortRows = <X extends { lat?: number; lng?: number }>(arr: X[], priceOf: (x: X) => number, ratingOf: (x: X) => number): X[] => {
    if (sort === "recommended" || (sort === "nearest" && !device)) return arr;
    const out = [...arr];
    if (sort === "nearest") out.sort((a, b) => distanceKm(device!, a) - distanceKm(device!, b));
    else if (sort === "price-asc") out.sort((a, b) => priceOf(a) - priceOf(b));
    else if (sort === "price-desc") out.sort((a, b) => priceOf(b) - priceOf(a));
    else out.sort((a, b) => ratingOf(b) - ratingOf(a));
    return out;
  };

  const stays = sortRows(
    geo(stayFilter === "All" ? C.stays : C.stays.filter((s) => s.type === stayFilter)).filter((s) => stayPass(s, filters)),
    (s) => s.price, (s) => s.rating,
  );
  const svcs = sortRows(
    geo(C.services.filter((s) => s.mode.includes(svcMode))).filter((s) => svcPass(s, filters)),
    (s) => s.price, (s) => s.rating,
  );
  // A driver only appears under the mode they actually offer — a day-only
  // driver must NOT show in the Package / Hourly tabs. `modes` is computed in
  // mapTransport from which rates/packages exist.
  const transAll = geo(C.transport);
  const transBrowse = sortRows(
    transAll.filter((t) => (t.modes || []).includes(trMode) && trPass(t, filters)),
    (x) => transportPriceForMode(x, trMode)?.value ?? Number.MAX_SAFE_INTEGER, (x) => x.rating,
  );

  // When a place is picked, the geo-filter alone drives results (the text query
  // holds the place name). Otherwise free-text search filters the catalog.
  const q = query.trim().toLowerCase();
  const searching = !picked && q.length > 0;
  const hit = (...vals: unknown[]) => vals.some((v) => norm(v).includes(q));
  const stayResults = searching ? C.stays.filter((s) => hit(s.title, s.type, s.location, s.district, s.owner, s.address) && stayPass(s, filters)) : [];
  const svcResults = searching ? C.services.filter((s) => hit(s.title, s.provider, s.category, s.subcategory, s.location, s.blurb) && svcPass(s, filters)) : [];
  const drvResults = searching ? C.transport.filter((t) => hit(t.driver, t.vehicle, t.type, t.area, (t.languages || []).join(" ")) && trPass(t, filters)) : [];
  // Tour packages are derived from real transport listings' tours (no mock).
  const packages = transBrowse.flatMap((t) => (t.tours || []).map((tour, i) => ({
    id: `${t.id}-${i}`,
    photo: t.photoUrls?.[0],
    title: tour.name,
    stops: tour.places.map((p) => p.name).filter(Boolean).join(" · "),
    hours: tour.hours > 6 ? `Full day · ${tour.hours} hrs` : `Half day · ${tour.hours} hrs`,
    price: tour.price,
    tone: t.tone,
    transportId: t.id,
  })));
  const pkgResults = searching ? packages.filter((p) => hit(p.title, p.stops)) : [];

  const activeList = seg === "stays" ? C.stays : seg === "services" ? C.services : C.transport;
  const browseReady = searching || (!C.loading && activeList.length > 0);

  // Service-category chips come from the live catalog so they always match
  // real data (the static list in FilterSheet is just a loading fallback).
  const svcCatOptions = Array.from(
    new Set(C.services.map((s) => String(s.category || "").trim().replace(/\b[a-z]/g, (c) => c.toUpperCase())).filter(Boolean)),
  );

  // Location label: a picked place or a searched place wins; otherwise the
  // app's home city, Hyderabad. (The old GPS / dominant-catalog-city inference
  // was removed in favour of this fixed default.)
  const dominant = (arr: (string | undefined)[]) => {
    const counts: Record<string, number> = {}; let best = "", n = 0;
    for (const v of arr) { if (!v) continue; counts[v] = (counts[v] || 0) + 1; if (counts[v] > n) { n = counts[v]; best = v; } }
    return best;
  };
  const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  // If the search term matches a place (city/area/address) on the results,
  // surface the searched place itself — so "kakinada" → "Namaskaram Kakinada"
  // even when listings store a null/different `city` field. Otherwise fall back
  // to the dominant city of the results.
  const allResults: GeoItem[] = [...stayResults, ...svcResults, ...drvResults];
  const placeFields = (x: GeoItem) => [x.city, x.location, x.district, x.address, x.area, x.locality];
  const queryIsPlace = searching && allResults.some((x) => placeFields(x).some((v) => norm(v).includes(q)));
  const searchCity = searching
    ? (queryIsPlace ? titleCase(q) : dominant(allResults.map((x) => x.city)))
    : "";
  const greetCity = picked?.label || (searching && searchCity) || "Hyderabad";
  // Display-only label: with no picked/searched place the greeting reads
  // "Namaskaram · Bharat" instead of implying a Hyderabad default. `greetCity`
  // keeps the functional Hyderabad fallback for the map's city param.
  const greetLabel = picked?.label || (searching && searchCity) || t("m.explore.bharat", { defaultValue: "Bharat" });

  // Wrap a listing card so the assistant can scroll to + flash it by id. Returns
  // a plain View element (not a component) so cards don't remount each render.
  const locWrap = (id: string, node: React.ReactNode) => (
    <View
      key={id}
      ref={(r) => { cardRefs.current[id] = r; }}
      collapsable={false}
      style={highlightId === id ? styles.locateFlash : undefined}
    >
      {node}
    </View>
  );

  return (
    <Background>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: insets.top + 6, paddingBottom: 122 }}
        showsVerticalScrollIndicator={false}
      >
        {/* greeting */}
        <View style={styles.greetRow}>
          <View>
            <Text style={styles.greetHi}>{t("m.explore.greeting", { defaultValue: "Namaskaram 🙏" })}</Text>
            <View style={styles.greetLoc}>
              <Icon name="mappin" size={17} color={T.terra} />
              <Text style={styles.greetCity}>{greetLabel}</Text>
            </View>
          </View>
          <IconBtn name="bell" size={20} onPress={() => nav.navigate("Notifications")} />
        </View>

        {/* search trigger + persistent Filters button. The bar is a summary
            button — tapping it opens the SearchSheet (search text, dates,
            who); Places predictions render inside the sheet now. */}
        <View style={{ marginTop: 16 }}>
          <View style={styles.searchRow}>
            <Pressable
              style={({ pressed }) => [styles.searchTrigger, pressed && { opacity: 0.85 }]}
              onPress={() => setSearchOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={t("m.primitives.searchPlaceholder", { defaultValue: "Search stays, services, rides…" })}
            >
              <Icon name="search" size={20} color={T.terra} />
              <Text style={[styles.searchTriggerTxt, !(picked || query) && styles.searchTriggerPh]} numberOfLines={1}>
                {picked?.label || query || t("m.primitives.searchPlaceholder", { defaultValue: "Search stays, services, rides…" })}
              </Text>
              {(picked || query.length > 0) && (
                <Pressable onPress={clearPicked} hitSlop={8} accessibilityLabel={t("m.search.clearSearch", { defaultValue: "Clear search" })}>
                  <Icon name="x" size={17} color={T.muted} />
                </Pressable>
              )}
            </Pressable>
            <Pressable
              style={[styles.filtersBtn, activeFilters > 0 && styles.filtersBtnActive]}
              onPress={() => setFilterOpen(true)}
              accessibilityLabel={t("m.search.filters", { defaultValue: "Filters" })}
            >
              <Icon name="sliders" size={18} color={activeFilters > 0 ? "#fff" : T.terra} />
              {activeFilters > 0 && <Text style={styles.filtersBtnCount}>{activeFilters}</Text>}
            </Pressable>
          </View>
        </View>

        {/* Dates/guests entry lives in the SearchSheet now — the old pills
            were removed so there's exactly one way to set them. */}

        {/* recent searches — every segment shows its own last-3 list */}
        {recents.length > 0 && !predOpen && !searching && (
          <View style={styles.recentWrap}>
            <Text style={styles.recentLabel}>{t("m.search.recent", { defaultValue: "Recent searches" })}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentRow}>
              {recents.map((r) => (
                <View key={r.id} style={styles.recentChip}>
                  <Pressable style={styles.recentChipMain} onPress={() => applyRecent(r)}>
                    <Icon name="clock" size={13} color={T.muted} />
                    <Text style={styles.recentChipTxt} numberOfLines={1}>{recentLabel(r)}</Text>
                  </Pressable>
                  <Pressable
                    style={styles.recentChipX}
                    onPress={() => removeRecent(r.id)}
                    hitSlop={6}
                    accessibilityLabel={t("m.search.removeRecent", { defaultValue: "Remove recent search" })}
                  >
                    <Icon name="x" size={12} color={T.muted} />
                  </Pressable>
                </View>
              ))}
              <Pressable style={styles.recentClear} onPress={clearRecents}>
                <Text style={styles.recentClearTxt}>{t("m.search.clearRecents", { defaultValue: "Clear" })}</Text>
              </Pressable>
            </ScrollView>
          </View>
        )}

        {(picked || activeFilters > 0) && (
          <View style={styles.pickedRow}>
            {picked && (
              <View style={styles.pickedChip}>
                <Icon name="mappin" size={13} color={T.terra} />
                <Text style={styles.pickedTxt} numberOfLines={1}>{t("m.explore.near", { defaultValue: "Near {{label}}", label: picked.label })}</Text>
                <Pressable onPress={clearPicked} hitSlop={8}><Icon name="x" size={13} color={T.muted} /></Pressable>
              </View>
            )}
            {activeFilters > 0 && (
              <Pressable style={styles.pickedChip} onPress={() => setFilterOpen(true)}>
                <Icon name="sliders" size={13} color={T.terra} />
                <Text style={styles.pickedTxt} numberOfLines={1}>{t("m.explore.filtersOn", { defaultValue: "{{filters}} on", filters: nFilters(activeFilters) })}</Text>
                <Pressable onPress={() => setFilters(EMPTY_FILTERS)} hitSlop={8}><Icon name="x" size={13} color={T.muted} /></Pressable>
              </Pressable>
            )}
          </View>
        )}

        {/* top-level segments — underlined text tabs */}
        <View style={{ marginTop: 18 }}>
          <Segmented options={SEGS_L} value={seg} onChange={onSegChange} tabs />
        </View>

        {/* catalog loading / empty (real-data states) */}
        {!searching && C.loading && <ActivityIndicator color={T.aubergine} style={{ marginTop: 48 }} />}
        {!searching && !C.loading && activeList.length === 0 && (
          <View style={styles.catalogEmpty}>
            <Icon name="search" size={26} color={T.muted} />
            <Text style={styles.catalogEmptyTxt}>
              {C.error
                ? t("m.explore.loadError", { defaultValue: "Couldn't load listings. Check your connection and try again." })
                : t(`m.explore.noneAvailable.${seg}`, { defaultValue: `No ${seg} available yet.` })}
            </Text>
          </View>
        )}

        {/* STAYS */}
        {seg === "stays" && browseReady &&
          (searching ? (
            <View style={{ marginTop: 16 }}>
              {stayResults.length > 0 ? (
                <>
                  <Text style={styles.searchCount}>{t("m.explore.resultsFor", { defaultValue: "{{results}} for “{{query}}”", results: nResults(stayResults.length), query })}</Text>
                  <View style={{ gap: 16, marginTop: 12 }}>
                    {stayResults.map((s) => locWrap(s.id, <StayCard stay={s} onOpen={() => openStay(s.id)} />))}
                  </View>
                </>
              ) : <SearchEmpty query={query} />}
            </View>
          ) : (
            <>
              {/* Option-A header: title + twin pills. "Show on map" is a pill
                  matching Sort (icon + short label) instead of the old bare
                  text link, so the two controls read as one aligned cluster. */}
              <View style={styles.headRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <SectionHead title={stayFilter === "All" ? t("m.explore.allStays", { defaultValue: "All stays" }) : stayFilter + "s"} />
                </View>
                <Pressable
                  onPress={() => nav.navigate("MapSearch", { filters, city: greetCity, place: picked ?? undefined })}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={t("m.explore.showOnMap", { defaultValue: "Show on map" })}
                  style={({ pressed }) => [styles.sortBtn, styles.headPillAlign, pressed && { opacity: 0.85 }]}
                >
                  <Icon name="mappin" size={13} color={T.terra} />
                  <Text style={styles.sortBtnTxt}>{t("m.explore.mapLabel", { defaultValue: "Map" })}</Text>
                </Pressable>
                <SortMenu value={sort} onChange={handleSort} />
              </View>
              <View style={{ gap: 16 }}>
                {stays.slice(0, STAY_PREVIEW).map((s) => locWrap(s.id, <StayCard stay={s} onOpen={() => openStay(s.id)} />))}
                {stays.length === 0 && <Text style={styles.emptyMode}>{t("m.explore.noStaysMatch", { defaultValue: "No stays match your filters." })}</Text>}
              </View>
              {stays.length > STAY_PREVIEW && (
                <Pressable style={styles.showMore} onPress={() => nav.navigate("MapSearch", { filters, city: greetCity, place: picked ?? undefined })}>
                  <Text style={styles.showMoreTxt}>{t("m.explore.showAllStaysMap", { defaultValue: "Show all {{count}} stays on the map", count: stays.length })}</Text>
                  <Icon name="arrowR" size={16} color={T.terra} />
                </Pressable>
              )}
            </>
          ))}

        {/* SERVICES */}
        {seg === "services" && browseReady &&
          (searching ? (
            <View style={{ marginTop: 16 }}>
              {svcResults.length > 0 ? (
                <>
                  <Text style={styles.searchCount}>{t("m.explore.resultsFor", { defaultValue: "{{results}} for “{{query}}”", results: nResults(svcResults.length), query })}</Text>
                  <View style={{ gap: 16, marginTop: 12 }}>
                    {svcResults.map((s) => locWrap(s.id, <ServiceCard service={s} onOpen={() => openService(s.id)} />))}
                  </View>
                </>
              ) : <SearchEmpty query={query} />}
            </View>
          ) : (
            <>
              <View style={{ marginTop: 16 }}>
                <Segmented options={SVC_MODES_L} value={svcMode} onChange={setSvcMode} small />
              </View>
              <Text style={styles.modeHint}>
                {svcMode === "at-home"
                  ? t("m.explore.svcHint.atHome", { defaultValue: "Provider visits your address" })
                  : svcMode === "visit-provider"
                    ? t("m.explore.svcHint.visit", { defaultValue: "Book a shop, studio, or class slot" })
                    : t("m.explore.svcHint.online", { defaultValue: "Remote session where it makes sense" })}
              </Text>
              {/* Day filter moved into the SearchSheet's Dates tile. */}
              <View style={styles.headRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <SectionHead title={t("m.explore.availableNow", { defaultValue: "Available now" })} />
                </View>
                <SortMenu value={sort} onChange={handleSort} />
              </View>
              <View style={{ gap: 16 }}>
                {svcs.map((s) => locWrap(s.id, <ServiceCard service={s} onOpen={() => openService(s.id)} />))}
                {svcs.length === 0 && <Text style={styles.emptyMode}>{svcRange.start ? t("m.explore.noneOnDay", { defaultValue: "Nothing available on {{day}}. Try other dates.", day: datesLabel(svcRange) ?? "" }) : activeFilters > 0 ? t("m.explore.noServicesMatch", { defaultValue: "No services match your filters." }) : t("m.explore.noServicesMode", { defaultValue: "No services for this mode yet." })}</Text>}
              </View>
            </>
          ))}

        {/* TRANSPORT */}
        {seg === "transport" && browseReady &&
          (searching ? (
            <View style={{ marginTop: 16 }}>
              {pkgResults.length + drvResults.length > 0 ? (
                <>
                  <Text style={styles.searchCount}>{t("m.explore.resultsFor", { defaultValue: "{{results}} for “{{query}}”", results: nResults(pkgResults.length + drvResults.length), query })}</Text>
                  {pkgResults.length > 0 && (
                    <>
                      <SectionHead title={t("m.explore.packages", { defaultValue: "Packages" })} />
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
                        {pkgResults.map((p) => <PackageCard key={p.id} pkg={p} onOpen={() => openTransport(p.transportId, "package")} />)}
                      </ScrollView>
                    </>
                  )}
                  {drvResults.length > 0 && (
                    <View style={{ gap: 16, marginTop: 12 }}>
                      {drvResults.map((t) => locWrap(t.id, <TransportCard item={t} mode={trMode} onOpen={() => openTransport(t.id, trMode)} />))}
                    </View>
                  )}
                </>
              ) : <SearchEmpty query={query} />}
            </View>
          ) : (
            <>
              <View style={{ marginTop: 16 }}>
                <Segmented options={TR_MODES_L} value={trMode} onChange={setTrMode} small />
              </View>
              <Text style={styles.modeHint}>
                {trMode === "package"
                  ? t("m.explore.trHint.package", { defaultValue: "Driver-led temple & day tours" })
                  : trMode === "hourly"
                    ? t("m.explore.trHint.hourly", { defaultValue: "Rent a vehicle by the hour" })
                    : t("m.explore.trHint.day", { defaultValue: "A driver with you for the whole day" })}
              </Text>
              {/* Day filter moved into the SearchSheet's Dates tile. */}
              {/* All three transport modes share the hourly layout: one
                  section head + a vertical list of TransportCards (package
                  mode's cards price per tour). The old horizontal package
                  rail and the "Plan a ride" header action are gone. */}
              <View style={styles.headRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <SectionHead title={trMode === "package" ? t("m.explore.verifiedDrivers", { defaultValue: "Verified drivers" }) : t("m.explore.availableDrivers", { defaultValue: "Available drivers" })} />
                </View>
                <SortMenu value={sort} onChange={handleSort} />
              </View>
              <View style={{ gap: 16 }}>
                {transBrowse.map((tr) => locWrap(tr.id, <TransportCard item={tr} mode={trMode} onOpen={() => openTransport(tr.id, trMode)} />))}
                {transBrowse.length === 0 && <Text style={styles.emptyMode}>{trRange.start ? t("m.explore.noneOnDay", { defaultValue: "Nothing available on {{day}}. Try other dates.", day: datesLabel(trRange) ?? "" }) : activeFilters > 0 ? t("m.explore.noDriversMatch", { defaultValue: "No drivers match your filters." }) : t("m.explore.noDriversMode", { defaultValue: "No drivers for this mode yet." })}</Text>}
              </View>
            </>
          ))}
      </ScrollView>
      {/* The date/guest pickers render NESTED inside the SearchSheet — iOS
          can't present two sibling Modals, so they must not live here. */}
      <SearchSheet
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
        seg={seg}
        segOptions={SEGS_L}
        onSeg={onSegChange}
        query={query}
        onQuery={(v: string) => { if (picked) setPicked(null); setQuery(v); }}
        picked={picked}
        onClearPicked={clearPicked}
        preds={preds}
        predOpen={predOpen}
        onPickPlace={pickPlace}
        datesValue={seg === "stays" ? datesLabel(dateRange) : seg === "services" ? datesLabel(svcRange) : datesLabel(trRange)}
        stayRange={dateRange}
        onApplyStayRange={handleDates}
        dayRange={seg === "services" ? svcRange : trRange}
        onApplyDayRange={(r: DateRange) => { if (seg === "services") setSvcRange(r); else setTrRange(r); }}
        guests={filters.guests}
        onApplyGuests={(n: number) => setFilters((f) => ({ ...f, guests: n }))}
        seats={filters.seats}
        onSeats={(n: number) => setFilters((f) => ({ ...f, seats: n }))}
        resultCount={seg === "stays" ? (searching ? stayResults.length : stays.length) : seg === "services" ? (searching ? svcResults.length : svcs.length) : (searching ? drvResults.length + pkgResults.length : transBrowse.length)}
        recents={recents}
        recentMain={recentMain}
        recentSide={(r: RecentSearch) => datesLabel(r.dateRange)}
        onApplyRecent={(r: RecentSearch) => { applyRecent(r); setSearchOpen(false); }}
        onRemoveRecent={removeRecent}
        onClearRecents={clearRecents}
      />
      <FilterSheet
        seg={seg}
        visible={filterOpen}
        value={filters}
        onApply={setFilters}
        onClose={() => setFilterOpen(false)}
        svcCatOptions={svcCatOptions}
      />
    </Background>
  );
}

const styles = StyleSheet.create({
  greetRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingTop: 4 },
  greetHi: { color: T.muted, fontSize: 13, fontFamily: font.bodySemi },
  greetLoc: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 },
  greetCity: { fontSize: 17, fontFamily: font.head, color: T.ink },
  predBox: { position: "absolute", top: 56, left: 0, right: 0, borderRadius: 16, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", overflow: "hidden", shadowColor: "#221f27", shadowOffset: { width: 0, height: 14 }, shadowOpacity: 0.18, shadowRadius: 28, elevation: 14 },
  predRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 15, borderBottomWidth: 1, borderBottomColor: "rgba(58,50,71,0.06)" },
  predMain: { fontSize: 14, fontFamily: font.bodyBold, color: T.ink },
  predSub: { fontSize: 12, fontFamily: font.body, color: T.muted, marginTop: 1 },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  // Summary trigger that replaced the inline SearchBar — same silhouette
  // (52px, radius 16) so the header reads unchanged; tapping opens SearchSheet.
  searchTrigger: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10, height: 52, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.85)" },
  searchTriggerTxt: { flex: 1, fontSize: 15, fontFamily: font.bodyMed, color: T.ink },
  searchTriggerPh: { color: "rgba(101,114,109,0.8)", fontFamily: font.body },
  filtersBtn: { flexDirection: "row", alignItems: "center", gap: 5, height: 52, paddingHorizontal: 15, borderRadius: 16, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  filtersBtnActive: { borderColor: T.terra, backgroundColor: T.terra },
  filtersBtnCount: { fontSize: 13, fontFamily: font.bodyHeavy, color: "#fff" },
  pillsRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  // Services/transport single-day filter pill, sits under the mode hint.
  dayPillRow: { flexDirection: "row", marginTop: 12 },
  pill: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 42, paddingVertical: 9, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  pillActive: { borderColor: T.terra, backgroundColor: T.terra },
  pillTxt: { fontSize: 13, fontFamily: font.bodyBold, color: T.ink, flexShrink: 1 },
  pillTxtActive: { color: "#fff" },
  recentWrap: { marginTop: 14 },
  recentLabel: { fontSize: 11, fontFamily: font.bodyHeavy, color: T.muted, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 8, paddingLeft: 2 },
  recentRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 8 },
  recentChip: { flexDirection: "row", alignItems: "center", borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", overflow: "hidden" },
  recentChipMain: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 7, paddingLeft: 12, paddingRight: 9, maxWidth: 220 },
  recentChipTxt: { fontSize: 12.5, fontFamily: font.bodyBold, color: T.ink, flexShrink: 1 },
  recentChipX: { paddingHorizontal: 9, paddingVertical: 8, borderLeftWidth: 1, borderLeftColor: T.line },
  recentClear: { paddingVertical: 8, paddingHorizontal: 10 },
  recentClearTxt: { fontSize: 12, fontFamily: font.bodyBold, color: T.muted },
  pickedRow: { flexDirection: "row", marginTop: 12 },
  pickedChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: "rgba(139,94,74,0.4)", backgroundColor: "rgba(139,94,74,0.08)", maxWidth: "100%" },
  pickedTxt: { fontSize: 13, fontFamily: font.bodyBold, color: T.aubergine, flexShrink: 1 },
  rail: { gap: 14, paddingVertical: 4, paddingRight: 20 },
  showMore: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, marginTop: 16, paddingVertical: 14, borderRadius: 16, borderWidth: 1, borderColor: "rgba(139,94,74,0.4)", backgroundColor: "rgba(139,94,74,0.07)" },
  showMoreTxt: { fontSize: 14, fontFamily: font.bodyHeavy, color: T.terra },
  searchCount: { fontSize: 13, fontFamily: font.bodyBold, color: T.muted, paddingLeft: 2 },
  modeHint: { color: T.muted, fontSize: 13, marginTop: 12, paddingLeft: 2, fontFamily: font.body },
  emptyMode: { color: T.muted, textAlign: "center", padding: 30, fontFamily: font.body },
  // Transient ring the assistant flashes around a card when it "points it out".
  locateFlash: { borderRadius: 22, borderWidth: 2, borderColor: T.coral, backgroundColor: "rgba(164,93,98,0.08)" },
  catalogEmpty: { alignItems: "center", gap: 12, paddingVertical: 56, paddingHorizontal: 28 },
  catalogEmptyTxt: { fontFamily: font.body, fontSize: 14, color: T.muted, textAlign: "center", lineHeight: 20 },
  searchEmpty: { alignItems: "center", gap: 5, paddingVertical: 46, paddingHorizontal: 24 },
  seTitle: { marginTop: 6, fontSize: 15, fontFamily: font.bodyHeavy, color: T.ink },
  // Section header + "Sort ⌄" pill row. The row (not just the menu) carries the
  // zIndex so the open dropdown overlays the card list rendered below it.
  headRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, zIndex: 30 },
  // Aligns a plain header pill (e.g. Map) with the SortMenu, whose wrapper
  // carries the same offset to sit level with the SectionHead title.
  headPillAlign: { marginBottom: 13 },
  sortWrap: { position: "relative", zIndex: 40, marginBottom: 13 },
  sortBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  sortBtnActive: { borderColor: "rgba(139,94,74,0.5)", backgroundColor: "rgba(139,94,74,0.08)" },
  sortBtnTxt: { fontSize: 13, fontFamily: font.bodyBold, color: T.ink },
  sortBtnTxtActive: { color: T.terra },
  sortMenu: { position: "absolute", top: 40, right: 0, width: 205, backgroundColor: "#fff", borderRadius: 14, padding: 6, borderWidth: 1, borderColor: T.line, shadowColor: "#241e1c", shadowOffset: { width: 0, height: 16 }, shadowOpacity: 0.18, shadowRadius: 32, elevation: 18, zIndex: 60 },
  sortItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 10 },
  sortItemOn: { backgroundColor: "rgba(139,94,74,0.09)" },
  sortItemTxt: { fontSize: 13.5, fontFamily: font.bodySemi, color: T.ink, flexShrink: 1 },
});
