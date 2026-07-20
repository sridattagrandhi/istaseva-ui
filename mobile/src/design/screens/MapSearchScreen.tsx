// design/screens/MapSearchScreen.tsx — stays on a real map (react-native-maps),
// fed by the real catalog (useCatalog). Price-pin markers at the listing's
// lat/lng + draggable 3-snap bottom sheet + tap-a-pin peek card. Listings
// without coordinates still appear in the sheet list, just not on the map.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, Pressable, Animated, PanResponder, StyleSheet, LayoutChangeEvent, Image } from "react-native";
import { MapCanvas, type MapCanvasHandle, type MapMarker, type MapRegion } from "./MapCanvas";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../Icon";
import { Ph, IconBtn, SearchBar } from "../primitives";
import { FilterSheet, Filters, EMPTY_FILTERS, countActiveFilters, stayPass } from "./FilterSheet";
import { StayCard } from "./cards";
import { useCatalog } from "../api/hooks";
import { useDesign } from "../DesignContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { T, font, rupee } from "../theme";
import { placePredictions, placeDetails, distanceKm, adminMatches, SEARCH_RADIUS_KM, PlaceDetails, PlacePrediction } from "../api/geocode";
import type { RootParamList } from "../Navigator";

type PickedPlace = PlaceDetails & { label: string };

// The place-ish fields the geo filter below reads off a listing (all optional).
type GeoItem = { lat?: number; lng?: number; location?: string; district?: string; city?: string; area?: string; locality?: string };

const SNAPS = [0.84, 0.46, 0.08]; // collapsed / partial / full (fraction translated down)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// Default map view if no listing has coordinates yet (Kakinada, AP).
const DEFAULT_REGION: MapRegion = { latitude: 16.99, longitude: 82.24, latitudeDelta: 0.5, longitudeDelta: 0.5 };

function priceTag(n: number) {
  if (n >= 1000) { const k = n / 1000; return "₹" + (k % 1 === 0 ? k : k.toFixed(1)) + "k"; }
  return "₹" + n;
}

const norm = (v: unknown) => String(v == null ? "" : v).toLowerCase();

export function MapSearchScreen() {
  const { t } = useLanguage();
  const nav = useNavigation<NativeStackNavigationProp<RootParamList>>();
  const route = useRoute<RouteProp<RootParamList, "MapSearch">>();
  const insets = useSafeAreaInsets();
  const { wish } = useDesign();
  const allStays = useCatalog().stays;

  // Search + filters — seeded with whatever was applied on Explore so the map
  // opens showing the same result set, then editable in place. A place the
  // user had PICKED on Explore arrives applied (geo-filter + map centered on
  // it); the inferred greeting city arrives as bar text only.
  const initialPlace: PickedPlace | null = route.params?.place ?? null;
  const [query, setQuery] = useState(initialPlace?.label ?? route.params?.city ?? "Hyderabad");
  const [place, setPlace] = useState<PickedPlace | null>(initialPlace);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>(route.params?.filters ?? EMPTY_FILTERS);
  const activeFilters = countActiveFilters(filters, "stays");
  const mapRef = useRef<MapCanvasHandle>(null);

  // Live place predictions (debounced) — same flow as Explore's search bar.
  // skipPred starts true when the bar is pre-filled so arriving on the screen
  // doesn't immediately pop the dropdown.
  const [preds, setPreds] = useState<PlacePrediction[]>([]);
  const [predOpen, setPredOpen] = useState(false);
  const predTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipPred = useRef(query.length > 0);
  useEffect(() => {
    if (skipPred.current) { skipPred.current = false; return; }
    if (predTimer.current) clearTimeout(predTimer.current);
    const qv = query.trim();
    if (qv.length < 3) { setPreds([]); setPredOpen(false); return; }
    predTimer.current = setTimeout(async () => {
      const list = await placePredictions(qv);
      setPreds(list);
      setPredOpen(list.length > 0);
    }, 300);
    return () => { if (predTimer.current) clearTimeout(predTimer.current); };
  }, [query]);

  const pickPlace = async (pr: PlacePrediction) => {
    skipPred.current = true;
    setQuery(pr.mainText || pr.description);
    setPredOpen(false);
    setPreds([]);
    const d = await placeDetails(pr.id);
    if (d) {
      setPlace({ ...d, label: pr.mainText || pr.description });
      mapRef.current?.animateTo({ latitude: d.lat, longitude: d.lng, latitudeDelta: 0.35, longitudeDelta: 0.35 }, 600);
    }
  };
  const clearSearch = () => { setPlace(null); skipPred.current = true; setQuery(""); setPredOpen(false); setPreds([]); };

  // With a place applied, the geo-filter drives results (the bar just holds the
  // place name); otherwise the text is a free-text match — mirrors Explore.
  const q = place ? "" : query.trim().toLowerCase();
  const matchesPlace = (x: GeoItem) => {
    if (!place) return true;
    if (distanceKm(x, place) <= SEARCH_RADIUS_KM) return true;
    return [x.location, x.district, x.city, x.area, x.locality].some(
      (n) => adminMatches(n, place.locality) || adminMatches(n, place.district),
    );
  };
  const stays = useMemo(
    () =>
      allStays.filter(
        (s) =>
          (!q || [s.title, s.type, s.location, s.district, s.owner, s.address].some((v) => norm(v).includes(q))) &&
          matchesPlace(s) &&
          stayPass(s, filters),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allStays, q, place, filters],
  );

  const mapped = useMemo(() => stays.filter((s) => typeof s.lat === "number" && typeof s.lng === "number"), [stays]);
  const initialRegion: MapRegion = initialPlace
    ? { latitude: initialPlace.lat, longitude: initialPlace.lng, latitudeDelta: 0.35, longitudeDelta: 0.35 }
    : mapped.length
      ? { latitude: mapped[0].lat as number, longitude: mapped[0].lng as number, latitudeDelta: 0.4, longitudeDelta: 0.4 }
      : DEFAULT_REGION;

  const [h, setH] = useState(798);
  const [picked, setPicked] = useState<string | null>(null);
  const focus = picked ? stays.find((x) => x.id === picked) : null;

  // Settled sheet TOP (px from the screen top) for each snap: collapsed /
  // partial / full. The full (top-most) snap is clamped to just below the
  // floating search header so the sheet can NEVER be dragged into it.
  const TOP_LIMIT = insets.top + 64;
  const posFor = (hh: number) => [SNAPS[0] * hh, SNAPS[1] * hh, TOP_LIMIT];
  const positions = posFor(h);
  // PanResponder is created once; read the live positions through a ref so a
  // layout change (rotation / different device height) is always respected.
  const posRef = useRef(positions);
  posRef.current = positions;

  // The sheet is bottom-pinned (bottom: 0) and we animate its TOP. That makes
  // its height always exactly the on-screen region, so the inner list can be a
  // plain flex:1 ScrollView that fills it and scrolls reliably at every snap —
  // unlike a full-height sheet translated down, whose list frame runs off the
  // bottom of the screen and won't scroll. `top` is a layout prop, hence
  // useNativeDriver:false.
  const sheetTop = useRef(new Animated.Value(SNAPS[1] * 798)).current;
  const snapRef = useRef(1);
  const baseRef = useRef(SNAPS[1] * 798);
  // Mirrors snapRef in state so the list's scrollEnabled re-renders on snap.
  const [snap, setSnap] = useState(1);
  // Live scroll offset of the inner list — pulling DOWN from the very top of
  // a fully-expanded list drags the sheet instead of rubber-banding.
  const scrollYRef = useRef(0);

  const animateTo = (idx: number) => {
    snapRef.current = idx;
    setSnap(idx);
    Animated.spring(sheetTop, { toValue: posRef.current[idx], useNativeDriver: false, bounciness: 4 }).start();
  };

  // Handlers live on the WHOLE sheet (grip + list), with capture-phase
  // arbitration against the inner ScrollView — handlers on just the grip made
  // the list area a gesture dead-zone (the ScrollView ate every drag, so the
  // sheet couldn't be pulled down from the list):
  //   - below full height, the list doesn't scroll; vertical drags move the sheet
  //   - at full height the list scrolls; dragging DOWN from scroll offset 0
  //     hands the gesture back to the sheet (standard bottom-sheet behavior)
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) => {
        if (Math.abs(g.dy) < 6 || Math.abs(g.dy) <= Math.abs(g.dx)) return false;
        if (snapRef.current !== 2) return true;
        return g.dy > 0 && scrollYRef.current <= 0;
      },
      onPanResponderGrant: () => { baseRef.current = posRef.current[snapRef.current]; },
      onPanResponderMove: (_, g) => {
        const lo = posRef.current[2], hi = posRef.current[0];
        sheetTop.setValue(clamp(baseRef.current + g.dy, lo, hi));
      },
      onPanResponderRelease: (_, g) => {
        const cur = baseRef.current + g.dy;
        let best = 0, bestD = Infinity;
        posRef.current.forEach((p, i) => { const d = Math.abs(p - cur); if (d < bestD) { bestD = d; best = i; } });
        animateTo(best);
      },
      onPanResponderTerminationRequest: () => false,
    })
  ).current;

  const onLayout = (e: LayoutChangeEvent) => {
    const nh = e.nativeEvent.layout.height;
    setH(nh);
    sheetTop.setValue(posFor(nh)[snapRef.current]);
  };

  const pickPin = (id: string) => {
    setPicked(id);
    Animated.timing(sheetTop, { toValue: h, duration: 320, useNativeDriver: false }).start();
  };
  const dismissPeek = () => { setPicked(null); animateTo(0); };

  // Price-pin markers for the map. Custom pin content per listing; the pill
  // highlights when its listing is the picked one.
  const markers: MapMarker[] = mapped.map((st2) => ({
    id: st2.id,
    coordinate: { latitude: st2.lat as number, longitude: st2.lng as number },
    onPress: () => pickPin(st2.id),
    render: () => {
      const selected = picked === st2.id;
      return (
        <View style={[s.pin, selected && s.pinSel]}>
          {wish.has(st2.id) && <Icon name="heartFill" size={11} color={T.coral} />}
          <Text style={[s.pinTxt, selected && { color: "#fff" }]}>{priceTag(st2.price)}</Text>
        </View>
      );
    },
  }));

  return (
    <View style={{ flex: 1, backgroundColor: "#eef1f4" }} onLayout={onLayout}>
      {/* real map */}
      <MapCanvas
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        onPress={() => picked && dismissPeek()}
        markers={markers}
      />

      {/* floating header: back + search (with place predictions) + filters */}
      <View style={[s.searchRow, { top: insets.top + 6 }]}>
        <IconBtn name="chevL" onPress={() => nav.goBack()} />
        <View style={{ flex: 1 }}>
          <SearchBar
            solid
            value={query}
            onChange={(v: string) => { if (place) setPlace(null); setQuery(v); }}
            onClear={clearSearch}
            placeholder={t("m.mapsearch.searchPlaceholder", { defaultValue: "Search city or area…" })}
          />
        </View>
        <View>
          <IconBtn name="sliders" onPress={() => setFilterOpen(true)} />
          {activeFilters > 0 && (
            <View style={s.filterBadge}><Text style={s.filterBadgeTxt}>{activeFilters}</Text></View>
          )}
        </View>
      </View>
      {predOpen && preds.length > 0 && (
        <View style={[s.predBox, { top: insets.top + 62 }]}>
          {preds.map((pr) => (
            <Pressable key={pr.id} onPress={() => pickPlace(pr)} style={({ pressed }) => [s.predRow, pressed && { backgroundColor: "rgba(58,50,71,0.06)" }]}>
              <Icon name="mappin" size={15} color={T.muted} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.predMain} numberOfLines={1}>{pr.mainText || pr.description}</Text>
                {!!pr.secondaryText && <Text style={s.predSub} numberOfLines={1}>{pr.secondaryText}</Text>}
              </View>
            </Pressable>
          ))}
        </View>
      )}

      {/* peek card */}
      {focus && (
        <Pressable style={[s.peek, { bottom: insets.bottom + 20 }]} onPress={() => nav.navigate("StayDetail", { id: focus.id })}>
          <Pressable style={s.peekX} onPress={dismissPeek}><Icon name="x" size={17} color={T.ink} /></Pressable>
          <View style={s.peekMedia}>
            {focus.photoUrls && focus.photoUrls[0]
              ? <Image source={{ uri: focus.photoUrls[0] }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              : <Ph tone={focus.tone} icon="bedDouble" style={StyleSheet.absoluteFill} />}
          </View>
          <View style={{ flex: 1, paddingRight: 24 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Icon name="starFill" size={12} color={T.saffron} />
              <Text style={s.peekRating}>{focus.rating}</Text>
              <Text style={s.peekMuted}>({focus.reviews})</Text>
              {focus.superhost && <><Icon name="badge" size={12} color={T.terra} /><Text style={s.peekVerified}>{t("m.mapsearch.superhost", { defaultValue: "Superhost" })}</Text></>}
            </View>
            <Text style={s.peekTitle} numberOfLines={1}>{focus.title}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 5 }}>
              <Icon name="mappin" size={13} color={T.muted} />
              {(() => {
                // Prefer the full stored address; else de-dupe location/district
                // (a listing with no city stores both as the same street, which
                // would otherwise render "Tank Bund Rd, Tank Bund Rd").
                const parts = [focus.location, focus.district].map((x) => String(x || "").trim()).filter(Boolean);
                const deduped = parts.filter((p, i) => parts.findIndex((y) => y.toLowerCase() === p.toLowerCase()) === i).join(", ");
                const locText = (focus.address && focus.address.trim()) || deduped;
                return <Text style={[s.peekMuted, { flex: 1 }]} numberOfLines={1}>{locText}</Text>;
              })()}
            </View>
            <View style={s.peekFoot}>
              <Text style={s.peekPrice}>{rupee(focus.price)}<Text style={s.peekPriceSmall}>{t("m.mapsearch.perNight", { defaultValue: "/night" })}</Text></Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                <Text style={s.peekCta}>{t("m.mapsearch.viewDetails", { defaultValue: "View details" })}</Text>
                <Icon name="arrowR" size={15} color={T.terra} />
              </View>
            </View>
          </View>
        </Pressable>
      )}

      {/* draggable sheet */}
      <Animated.View style={[s.sheet, { top: sheetTop }]} {...pan.panHandlers}>
        <View style={s.grip}>
          <View style={s.handle} />
          <View style={s.sheetHead}>
            <Text style={s.sheetTitle}>{t("m.mapsearch.staysCount", { defaultValue: "{{count}} stays", count: stays.length })}</Text>
          </View>
        </View>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 28, gap: 16 }}
          showsVerticalScrollIndicator={false}
          // The list only scrolls at the FULL snap; lower snaps give the whole
          // sheet surface to the drag gesture (see PanResponder above).
          scrollEnabled={snap === 2}
          onScroll={(e) => { scrollYRef.current = e.nativeEvent.contentOffset.y; }}
          scrollEventThrottle={16}
        >
          {stays.map((st2) => (
            <StayCard key={st2.id} stay={st2} onOpen={() => nav.navigate("StayDetail", { id: st2.id })} />
          ))}
          {stays.length === 0 && (
            <Text style={s.emptyTxt}>
              {q || activeFilters > 0
                ? t("m.mapsearch.emptyFiltered", { defaultValue: "No stays match your search and filters." })
                : t("m.mapsearch.emptyNone", { defaultValue: "No stays to show yet." })}
            </Text>
          )}
        </ScrollView>
      </Animated.View>

      <FilterSheet seg="stays" visible={filterOpen} value={filters} onApply={setFilters} onClose={() => setFilterOpen(false)} />
    </View>
  );
}

const s = StyleSheet.create({
  grid: { position: "absolute", backgroundColor: "rgba(58,50,71,0.05)" },
  bay: { position: "absolute", right: "-14%", top: "-10%", width: "42%", height: "130%", borderTopLeftRadius: 220, borderBottomLeftRadius: 220, backgroundColor: "rgba(97,122,146,0.22)" },
  river: { position: "absolute", left: "-12%", bottom: "-6%", width: "70%", height: "40%", backgroundColor: "rgba(97,122,146,0.18)", borderTopRightRadius: 160, transform: [{ rotate: "-8deg" }] },
  green: { position: "absolute", borderRadius: 60, backgroundColor: "rgba(118,150,110,0.18)" },
  road: { position: "absolute", height: 13, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.95)" },
  roadThin: { height: 8, backgroundColor: "rgba(255,255,255,0.82)" },
  label: { position: "absolute", fontSize: 11, fontFamily: font.bodyHeavy, letterSpacing: 0.4, color: "rgba(58,50,71,0.42)" },
  labelSea: { color: "rgba(97,122,146,0.6)", fontStyle: "italic", fontFamily: font.body },

  pin: { flexDirection: "row", alignItems: "center", gap: 4, height: 32, paddingHorizontal: 12, borderRadius: 999, backgroundColor: "#fff", borderWidth: 1, borderColor: "rgba(58,50,71,0.08)", shadowColor: "#221f27", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.22, shadowRadius: 14, elevation: 6 },
  pinSel: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  pinTxt: { fontSize: 13, fontFamily: font.bodyHeavy, color: T.ink },

  searchRow: { position: "absolute", left: 14, right: 14, flexDirection: "row", alignItems: "center", gap: 10, zIndex: 40 },
  filterBadge: { position: "absolute", top: -4, right: -4, minWidth: 18, height: 18, borderRadius: 999, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", backgroundColor: T.terra },
  filterBadgeTxt: { color: "#fff", fontSize: 10.5, fontFamily: font.bodyHeavy },
  emptyTxt: { color: T.muted, textAlign: "center", paddingVertical: 30, fontFamily: font.body },
  predBox: { position: "absolute", left: 66, right: 66, zIndex: 50, borderRadius: 16, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", overflow: "hidden", shadowColor: "#221f27", shadowOffset: { width: 0, height: 14 }, shadowOpacity: 0.18, shadowRadius: 28, elevation: 14 },
  predRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 15, borderBottomWidth: 1, borderBottomColor: "rgba(58,50,71,0.06)" },
  predMain: { fontSize: 14, fontFamily: font.bodyBold, color: T.ink },
  predSub: { fontSize: 12, fontFamily: font.body, color: T.muted, marginTop: 1 },

  peek: { position: "absolute", left: 16, right: 16, zIndex: 30, flexDirection: "row", gap: 12, padding: 12, borderRadius: 22, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.97)", shadowColor: "#221f27", shadowOffset: { width: 0, height: 24 }, shadowOpacity: 0.3, shadowRadius: 50, elevation: 18 },
  peekX: { position: "absolute", top: 10, right: 10, zIndex: 2, width: 30, height: 30, alignItems: "center", justifyContent: "center", borderRadius: 999, backgroundColor: "rgba(255,255,255,0.9)" },
  peekMedia: { width: 104, borderRadius: 14, overflow: "hidden" },
  peekRating: { fontFamily: font.bodyBold, fontSize: 13, color: T.ink },
  peekMuted: { color: T.muted, fontSize: 12, fontFamily: font.body },
  peekVerified: { color: T.terra, fontFamily: font.bodyBold, fontSize: 12 },
  peekTitle: { fontSize: 15.5, fontFamily: font.head, color: T.ink, marginTop: 8 },
  peekFoot: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: 8, marginTop: 11 },
  peekPrice: { fontSize: 16, fontFamily: font.bodyHeavy, color: T.ink },
  peekPriceSmall: { color: T.muted, fontSize: 11.5, fontFamily: font.bodySemi },
  peekCta: { fontSize: 12.5, fontFamily: font.bodyHeavy, color: T.terra },

  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopLeftRadius: 28, borderTopRightRadius: 28, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.8)", backgroundColor: "rgba(250,248,250,0.98)", shadowColor: "#221f27", shadowOffset: { width: 0, height: -22 }, shadowOpacity: 0.26, shadowRadius: 50, elevation: 20 },
  grip: { paddingHorizontal: 20, paddingBottom: 12 },
  handle: { width: 42, height: 5, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.2)", alignSelf: "center", marginTop: 12, marginBottom: 4 },
  sheetHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 10 },
  sheetTitle: { fontSize: 17, fontFamily: font.head, color: T.ink },
});
