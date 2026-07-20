// design/screens/FilterSheet.tsx — segment-aware filters bottom sheet (ported from detail.jsx FilterSheet).
// Controlled: the sheet edits a DRAFT of the caller's `value` and only commits
// it via `onApply` when the user taps "Apply filters" (Reset commits defaults
// immediately). ExploreScreen owns the applied state and does the filtering.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, Modal, ScrollView, PanResponder, StyleSheet, LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Icon } from "../Icon";
import { IconBtn, rupee } from "../primitives";
import { T, font } from "../theme";
import { useLanguage } from "@/contexts/LanguageContext";

const STAY_TYPES = ["Hotel", "Homestay", "Lodge", "Village stay", "Farm stay", "Heritage", "Sathram"];
const STAY_AMENITIES = ["WiFi", "AC", "Parking", "Kitchen", "Breakfast", "Pool", "Pet friendly", "Workspace", "Hot water", "Power backup", "Restaurant", "Laundry"];
const SVC_CATS = ["Beard trim", "Haircut", "Salon", "Shaving"];
const LANGS = ["English", "Hindi", "Telugu", "Tamil", "Kannada", "Marathi", "Malayalam"];
// Mirrors TRANSPORT_LABEL in api/listings.ts — the only vehicle types backend
// transport categories (driver-cab/auto/van/bus) map to.
const VEH_TYPES = ["Cab", "Auto", "Van", "Bus"];
const BOOK_MODES = ["Hourly", "Day rental", "Tour package"];
const RATINGS = ["Any", "3.5+", "4+", "4.5+"];

/** Applied filter state. Defaults mean "no constraint" — sliders at their max
 *  (price) or min (guests/seats) and empty chip sets are treated as off. */
export type Filters = {
  rating: string; // "Any" | "3.5+" | "4+" | "4.5+"
  langs: string[];
  // stays
  propTypes: string[];
  stayPrice: number; // 10000 (slider max) = no cap
  guests: number;    // 1 = any
  bedrooms: number;  // 0 = any
  amenities: string[];
  // services
  svcCats: string[];
  svcModes: string[]; // "At home" | "Visit provider" | "Online" — no UI chips anymore, kept for saved patches / match loop
  svcPrice: number;   // 5000 (slider max) = no cap
  // transport
  vehTypes: string[];
  bookModes: string[]; // labels from BOOK_MODES
  perDay: number;      // 0 = any
  seats: number;       // 1 = any
};

export const EMPTY_FILTERS: Filters = {
  rating: "Any", langs: [],
  propTypes: [], stayPrice: 10000, guests: 1, bedrooms: 0, amenities: [],
  svcCats: [], svcModes: [], svcPrice: 5000,
  vehTypes: [], bookModes: [], perDay: 0, seats: 1,
};

/** How many filter sections deviate from defaults for the given segment —
 *  drives the "N filters on" chip in ExploreScreen. */
export function countActiveFilters(f: Filters, seg: string): number {
  let n = f.rating !== "Any" ? 1 : 0;
  if (seg === "stays") {
    // Guests is intentionally excluded — it lives in the dedicated "Who" stepper
    // (GuestsSheet), not this sheet, so it isn't counted as a filter here.
    n += (f.propTypes.length ? 1 : 0) + (f.stayPrice < 10000 ? 1 : 0)
      + (f.bedrooms > 0 ? 1 : 0) + (f.amenities.length ? 1 : 0);
  } else if (seg === "services") {
    n += (f.svcCats.length ? 1 : 0) + (f.svcModes.length ? 1 : 0) + (f.svcPrice < 5000 ? 1 : 0)
      + (f.langs.length ? 1 : 0);
  } else {
    n += (f.vehTypes.length ? 1 : 0) + (f.bookModes.length ? 1 : 0) + (f.perDay > 0 ? 1 : 0)
      + (f.seats > 1 ? 1 : 0) + (f.langs.length ? 1 : 0);
  }
  return n;
}

/** Normalized payload the assistant's `apply_filters` action becomes once
 *  translated for the Explore screen: which segment to show, the top-level
 *  service/transport mode tab, a search needle, and a Filters patch. */
export type ExploreFilterIntent = {
  seg?: "stays" | "services" | "transport";
  query?: string;
  /** Top-level services mode tab: at-home | visit-provider | online. */
  svcMode?: string;
  /** Top-level transport mode tab: hourly | day | package. */
  trMode?: string;
  filters?: Partial<Filters>;
};

const SEG_FOR_CATEGORY: Record<string, "stays" | "services" | "transport"> = {
  stay: "stays",
  service: "services",
  transport: "transport",
};

/** Snap a numeric minRating onto the discrete RATINGS chips the sheet offers. */
const ratingLabelFor = (n: number): string =>
  n >= 4.5 ? "4.5+" : n >= 4 ? "4+" : n >= 3.5 ? "3.5+" : "Any";

/**
 * Snap free-text values from the model ("homestays", "haircut") onto the exact
 * chip option labels (STAY_TYPES / SVC_CATS) so the filter sheet renders them
 * SELECTED. The sheet's predicate matches loosely, but a chip only highlights on
 * an exact `sel.includes(label)` check — so "homestays" would filter yet leave
 * the Homestay chip unlit. Falls back to the raw value when nothing matches.
 */
function canonicalizeToOptions(values: unknown[], options: string[]): string[] {
  const norm = (v: unknown) => String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]/g, "");
  const out: string[] = [];
  for (const v of values) {
    const nv = norm(v);
    if (!nv) continue;
    const hit =
      options.find((o) => norm(o) === nv) ??
      options.find((o) => { const no = norm(o); return no.length > 0 && (no.includes(nv) || nv.includes(no)); });
    const label = hit ?? String(v);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * Translate the backend `apply_filters` action payload
 * (`{ category, filters: { q, maxPrice, minRating, categories, serviceMode,
 * transportMode, subcategories } }`) into an ExploreFilterIntent. Mirrors the
 * web bus mapping in ClientRedesign.useMarketplaceAgentFilters so chat-driven
 * filtering behaves the same on both clients. Returns null when nothing in the
 * payload is actionable (caller can skip navigating).
 */
export function intentFromApplyFilters(
  params: { category?: string; filters?: Record<string, any> } | null | undefined,
): ExploreFilterIntent | null {
  if (!params) return null;
  const seg = params.category ? SEG_FOR_CATEGORY[params.category] : undefined;
  const f = params.filters || {};
  const out: ExploreFilterIntent = {};
  if (seg) out.seg = seg;
  if (typeof f.q === "string" && f.q.trim()) out.query = f.q.trim();
  if (typeof f.serviceMode === "string") out.svcMode = f.serviceMode;
  if (typeof f.transportMode === "string") out.trMode = f.transportMode;

  const filters: Partial<Filters> = {};
  if (typeof f.minRating === "number") filters.rating = ratingLabelFor(f.minRating);
  if (typeof f.maxPrice === "number") {
    // The price slider differs per segment; route the cap to the right field.
    if (seg === "services") filters.svcPrice = f.maxPrice;
    else if (seg === "transport") filters.perDay = f.maxPrice;
    else filters.stayPrice = f.maxPrice;
  }
  // Stay property-type chips (web sends these as `categories`). Snap to exact
  // STAY_TYPES labels so the chip highlights, not just the loose-match filter.
  if (Array.isArray(f.categories) && f.categories.length && (seg === "stays" || !seg)) {
    filters.propTypes = canonicalizeToOptions(f.categories, STAY_TYPES);
  }
  // Service subcategory chips → exact SVC_CATS labels.
  if (Array.isArray(f.subcategories) && f.subcategories.length) {
    filters.svcCats = canonicalizeToOptions(f.subcategories, SVC_CATS);
  }
  if (Object.keys(filters).length) out.filters = filters;

  return out.seg || out.query || out.svcMode || out.trMode || out.filters ? out : null;
}

/* ── filter predicates (shared by ExploreScreen + MapSearchScreen) ──
 * Chip labels are matched against listing fields with a normalized
 * bidirectional substring ("Village stay" ≈ "village-stay", "Haircut" ≈
 * "Men's Haircut") — the same approach as the web's MarketplaceControls. */
const nk = (v: any) => String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]/g, "");
const minRatingOf = (r: string) => (r === "Any" ? 0 : parseFloat(r) || 0);
const looseHas = (sel: string[], vals: any[]) =>
  sel.length === 0 ||
  vals.some((v) => {
    const t = nk(v);
    if (!t) return false;
    return sel.some((s0) => {
      const u = nk(s0);
      return t === u || (u.length >= 3 && t.includes(u)) || (t.length >= 3 && u.includes(t));
    });
  });
const SVC_MODE_SLUG: Record<string, string> = { "At home": "at-home", "Visit provider": "visit-provider", Online: "online" };
const BOOK_MODE_SLUG: Record<string, string> = { Hourly: "hourly", "Day rental": "day", "Tour package": "package" };

export const stayPass = (s: any, f: Filters) =>
  looseHas(f.propTypes, [s.type]) &&
  (f.stayPrice >= 10000 || s.price <= f.stayPrice) &&
  s.rating >= minRatingOf(f.rating) &&
  (f.guests <= 1 || s.guests >= f.guests) &&
  (f.bedrooms <= 0 || s.rooms >= f.bedrooms) &&
  f.amenities.every((a: string) => looseHas([a], s.amenityLabels || []));

export const svcPass = (s: any, f: Filters) =>
  looseHas(f.svcCats, [s.category, s.subcategory, s.title]) &&
  (f.svcModes.length === 0 || f.svcModes.some((m) => (s.mode || []).includes(SVC_MODE_SLUG[m]))) &&
  (f.svcPrice >= 5000 || s.price <= f.svcPrice) &&
  looseHas(f.langs, s.languages || []) &&
  s.rating >= minRatingOf(f.rating);

export const trPass = (t: any, f: Filters) =>
  looseHas(f.vehTypes, [t.type, t.vehicle]) &&
  (f.bookModes.length === 0 || f.bookModes.some((m) => (t.modes || []).includes(BOOK_MODE_SLUG[m]))) &&
  (f.perDay <= 0 || (t.day > 0 && t.day <= f.perDay)) &&
  (f.seats <= 1 || t.seats >= f.seats) &&
  looseHas(f.langs, t.languages || []) &&
  t.rating >= minRatingOf(f.rating);

type ArrayKey = "langs" | "propTypes" | "amenities" | "svcCats" | "svcModes" | "vehTypes" | "bookModes";

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed, hovered }: any) => [s.chip, active && s.chipActive, !active && hovered && { backgroundColor: "rgba(58,50,71,0.06)" }, pressed && { opacity: 0.8 }]}>
      <Text style={[s.chipTxt, active && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

function ChipGroup({ options, sel, toggle, labelFor }: { options: string[]; sel: string[]; toggle: (v: string) => void; labelFor?: (v: string) => string }) {
  return <View style={s.chipWrap}>{options.map((o) => <Chip key={o} label={labelFor ? labelFor(o) : o} active={sel.includes(o)} onPress={() => toggle(o)} />)}</View>;
}

function Slider({ min, max, step = 1, value, onChange }: { min: number; max: number; step?: number; value: number; onChange: (v: number) => void }) {
  const [w, setW] = useState(0);
  const wRef = useRef(0);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => move(e.nativeEvent.locationX),
      onPanResponderMove: (e) => move(e.nativeEvent.locationX),
    })
  ).current;
  const move = (x: number) => {
    const width = wRef.current || 1;
    const pct = Math.max(0, Math.min(1, x / width));
    const raw = min + pct * (max - min);
    const stepped = Math.round(raw / step) * step;
    onChange(Math.max(min, Math.min(max, stepped)));
  };
  const onLayout = (e: LayoutChangeEvent) => { wRef.current = e.nativeEvent.layout.width; setW(e.nativeEvent.layout.width); };
  const pct = (value - min) / (max - min);
  return (
    <View style={s.sliderRow} onLayout={onLayout} {...pan.panHandlers}>
      <View style={s.sliderTrack}>
        <View style={[s.sliderFill, { width: `${pct * 100}%` }]} />
      </View>
      <View style={[s.sliderThumb, { left: Math.max(0, pct * w - 11) }]} />
    </View>
  );
}

function RatingRow({ value, onChange, anyLabel }: { value: string; onChange: (v: string) => void; anyLabel: string }) {
  return (
    <View style={s.chipWrap}>
      {RATINGS.map((r) => (
        <Pressable key={r} onPress={() => onChange(r)} style={({ pressed }: any) => [s.chip, value === r && s.chipActive, pressed && { opacity: 0.8 }]}>
          {r !== "Any" && <Icon name="star" size={14} color={value === r ? "#fff" : T.aubergine} />}
          <Text style={[s.chipTxt, value === r && { color: "#fff" }]}>{r === "Any" ? anyLabel : r}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Sec({ title }: { title: string }) { return <Text style={s.sec}>{title}</Text>; }

export function FilterSheet({ seg, visible, value, onApply, onClose, svcCatOptions }: {
  seg: string;
  visible: boolean;
  value: Filters;
  onApply: (f: Filters) => void;
  onClose: () => void;
  /** Category chips derived from the live catalog (mirrors the web's
   *  categoryOptions) — falls back to the static list while loading. */
  svcCatOptions?: string[];
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  // Translate a chip's human label while keeping its logic value (the raw
  // string in the option arrays) intact. Falls back to the raw value.
  const lbl = (group: string) => (v: string) =>
    t(`m.filter.opt.${group}.${nk(v)}`, { defaultValue: v });
  const anyLabel = t("m.filter.any", { defaultValue: "Any" });

  // Draft copy of the applied filters — edits stay local until Apply.
  const [f, setF] = useState<Filters>(value);
  useEffect(() => { if (visible) setF(value); }, [visible]); // re-seed on every open
  const set = <K extends keyof Filters>(k: K) => (v: Filters[K]) => setF((p) => ({ ...p, [k]: v }));
  const tog = (k: ArrayKey) => (v: string) =>
    setF((p) => ({ ...p, [k]: p[k].includes(v) ? p[k].filter((x) => x !== v) : [...p[k], v] }));

  // Reset commits immediately so the list visibly un-filters; Apply commits the
  // draft. Guests is owned by the separate "Who" stepper, so Reset preserves it
  // instead of silently clearing a value this sheet no longer surfaces.
  const reset = () => { const next = { ...EMPTY_FILTERS, guests: f.guests }; setF(next); onApply(next); };
  const apply = () => { onApply(f); onClose(); };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={s.handle} />
        <View style={s.headRow}>
          <Text style={s.title}>{t("m.filter.title", { defaultValue: "Filters" })}</Text>
          <IconBtn name="x" onPress={onClose} bare />
        </View>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 16 }}>
          {seg === "stays" && (
            <>
              <Sec title={t("m.filter.sec.propertyType", { defaultValue: "Property type" })} /><ChipGroup options={STAY_TYPES} sel={f.propTypes} toggle={tog("propTypes")} labelFor={lbl("stayType")} />
              <Sec title={t("m.filter.sec.priceUpTo", { defaultValue: "Price up to {{value}}", value: f.stayPrice >= 10000 ? anyLabel : t("m.filter.perNightValue", { defaultValue: "{{price}}/night", price: rupee(f.stayPrice) }) })} /><Slider min={500} max={10000} step={100} value={f.stayPrice} onChange={set("stayPrice")} />
              <Sec title={t("m.filter.sec.minRating", { defaultValue: "Minimum rating" })} /><RatingRow value={f.rating} onChange={set("rating")} anyLabel={anyLabel} />
              <Sec title={t("m.filter.sec.bedrooms", { defaultValue: "Bedrooms: {{value}}", value: f.bedrooms === 0 ? anyLabel : f.bedrooms + "+" })} /><Slider min={0} max={8} value={f.bedrooms} onChange={set("bedrooms")} />
              <Sec title={t("m.filter.sec.amenities", { defaultValue: "Amenities" })} /><ChipGroup options={STAY_AMENITIES} sel={f.amenities} toggle={tog("amenities")} labelFor={lbl("amenity")} />
            </>
          )}
          {seg === "services" && (
            <>
              <Sec title={t("m.filter.sec.category", { defaultValue: "Category" })} /><ChipGroup options={svcCatOptions?.length ? svcCatOptions : SVC_CATS} sel={f.svcCats} toggle={tog("svcCats")} labelFor={lbl("svcCat")} />
              {/* "Service mode" (At home / Visit provider / Online) chips removed
                  per product feedback — redundant. `svcModes` stays on the filter
                  state so the match loop and any saved patches remain valid; it's
                  just always empty (= "any") from this sheet. Mirrors web's
                  ServiceFilterBody in src/redesign/MarketplaceControls.tsx. */}
              <Sec title={t("m.filter.sec.priceUpToPlain", { defaultValue: "Price up to {{value}}", value: f.svcPrice >= 5000 ? anyLabel : rupee(f.svcPrice) })} /><Slider min={100} max={5000} step={100} value={f.svcPrice} onChange={set("svcPrice")} />
              <Sec title={t("m.filter.sec.languages", { defaultValue: "Languages spoken" })} /><ChipGroup options={LANGS} sel={f.langs} toggle={tog("langs")} labelFor={lbl("lang")} />
              <Sec title={t("m.filter.sec.minRating", { defaultValue: "Minimum rating" })} /><RatingRow value={f.rating} onChange={set("rating")} anyLabel={anyLabel} />
            </>
          )}
          {seg === "transport" && (
            <>
              <Sec title={t("m.filter.sec.vehicleType", { defaultValue: "Vehicle / service type" })} /><ChipGroup options={VEH_TYPES} sel={f.vehTypes} toggle={tog("vehTypes")} labelFor={lbl("vehType")} />
              <Sec title={t("m.filter.sec.bookingMode", { defaultValue: "Booking mode" })} /><ChipGroup options={BOOK_MODES} sel={f.bookModes} toggle={tog("bookModes")} labelFor={lbl("bookMode")} />
              <Sec title={t("m.filter.sec.perDayPrice", { defaultValue: "Per-day price: {{value}}", value: f.perDay === 0 ? anyLabel : rupee(f.perDay) })} /><Slider min={0} max={10000} step={100} value={f.perDay} onChange={set("perDay")} />
              <Sec title={t("m.filter.sec.minSeats", { defaultValue: "Minimum seats: {{count}}", count: f.seats })} /><Slider min={1} max={20} value={f.seats} onChange={set("seats")} />
              <Sec title={t("m.filter.sec.languages", { defaultValue: "Languages spoken" })} /><ChipGroup options={LANGS} sel={f.langs} toggle={tog("langs")} labelFor={lbl("lang")} />
              <Sec title={t("m.filter.sec.minRating", { defaultValue: "Minimum rating" })} /><RatingRow value={f.rating} onChange={set("rating")} anyLabel={anyLabel} />
            </>
          )}
        </ScrollView>
        <View style={s.footer}>
          <Pressable style={({ pressed }: any) => [s.ghost, pressed && { opacity: 0.8 }]} onPress={reset}><Text style={s.ghostTxt}>{t("m.filter.reset", { defaultValue: "Reset" })}</Text></Pressable>
          <Pressable style={({ pressed }: any) => [s.apply, pressed && { opacity: 0.9 }]} onPress={apply}>
            <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.applyInner}>
              <Text style={s.applyTxt}>{t("m.filter.apply", { defaultValue: "Apply filters" })}</Text>
            </LinearGradient>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(23,20,29,0.5)" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "88%", backgroundColor: "#faf8fa", borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 8 },
  handle: { width: 42, height: 5, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.2)", alignSelf: "center", marginBottom: 8 },
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6, marginBottom: 4 },
  title: { fontSize: 20, fontFamily: font.head, color: T.ink },
  sec: { fontSize: 16, fontFamily: font.headHeavy, color: T.ink, marginTop: 22, marginBottom: 12 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 34, paddingVertical: 7, paddingHorizontal: 13, borderRadius: 999, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.7)" },
  chipActive: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  chipTxt: { color: T.aubergine, fontSize: 12.5, fontFamily: font.bodyBold },
  sliderRow: { height: 28, justifyContent: "center" },
  sliderTrack: { height: 6, borderRadius: 999, backgroundColor: T.line, overflow: "hidden" },
  sliderFill: { height: "100%", backgroundColor: T.terra, borderRadius: 999 },
  sliderThumb: { position: "absolute", width: 22, height: 22, borderRadius: 999, backgroundColor: "#fff", borderWidth: 2, borderColor: T.terra, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3 },
  footer: { flexDirection: "row", gap: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: T.line },
  ghost: { flex: 1, minHeight: 54, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.6)" },
  ghostTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 16 },
  apply: { flex: 2, borderRadius: 18, overflow: "hidden" },
  applyInner: { minHeight: 54, alignItems: "center", justifyContent: "center" },
  applyTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 16 },
});
