// design/screens/admin/AdminScreen.tsx — mobile admin analytics.
// A tap-to-open side drawer switches between the seven sections (parity with
// the web dashboard pages), each reading the same /api/admin/metrics/*.
// Structured so more admin tooling can slot in under screens/admin/ later.
import React, { useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Modal } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "../../Icon";
import { IconBtn } from "../../primitives";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { T, font } from "../../theme";
import { fetchFreshness, adminFilterActive, EMPTY_ADMIN_FILTER, type AdminMetricFilter, type AdminRange } from "../../api/adminMetrics";
import { DateRangeSheet } from "../DateRangeSheet";
import { OverviewTab, RevenueTab, DiscoveryTab, ConversionTab, EngagementTab, ProvidersTab, GeographicTab, CustomersTab } from "./adminTabs";
import { BookingsOpsTab, FraudOpsTab, ListingsOpsTab, CouponsOpsTab, AuditOpsTab } from "./adminOpsTabs";
import { FeesOpsTab, PayoutsOpsTab } from "./adminMoneyTabs";
import { MultiSelectChip, useAdminFacetOptions, ListingPickerSheet } from "./adminOpsUi";

const pad = (n: number) => String(n).padStart(2, "0");
const today = () => new Date().toISOString().slice(0, 10);
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate(); // m is 1-based
const fyLabel = (startYear: number) => `FY ${startYear}-${String(startYear + 1).slice(2)}`;

/** "12 Mar – 4 Apr 2026" (year only on `from` when the ends differ). */
function customRangeLabel(from: string, to: string): string {
  const f = new Date(`${from}T00:00:00`);
  const t = new Date(`${to}T00:00:00`);
  const short: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const fs = f.toLocaleDateString("en-IN", f.getFullYear() === t.getFullYear() ? short : { ...short, year: "numeric" });
  return `${fs} – ${t.toLocaleDateString("en-IN", { ...short, year: "numeric" })}`;
}

// Dynamically built each render so the financial-year options (India Apr–Mar)
// roll forward automatically every year — no yearly code change needed.
function buildChips(): Array<{ key: string; label: string; range: AdminRange }> {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1; // 1-based
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  const fyStart = m >= 4 ? y : y - 1; // FY starts in April
  return [
    { key: "7d", label: "7d", range: { days: 7 } },
    { key: "30d", label: "30d", range: { days: 30 } },
    { key: "90d", label: "90d", range: { days: 90 } },
    { key: "month", label: "This month", range: { from: `${y}-${pad(m)}-01`, to: today() } },
    { key: "lastMonth", label: "Last month", range: { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(lastDay(py, pm))}` } },
    { key: "year", label: "This year", range: { from: `${y}-01-01`, to: today() } },
    { key: "fy", label: fyLabel(fyStart), range: { from: `${fyStart}-04-01`, to: today() } },
    { key: "fyLast", label: fyLabel(fyStart - 1), range: { from: `${fyStart - 1}-04-01`, to: `${fyStart}-03-31` } },
  ];
}

// Ops tabs own their filters and don't read the analytics range picker; the
// `ops` flag hides the range chip row and drops the range prop. `filterable`
// marks the analytics tabs whose tiles honour the listing filter bar
// (vertical/category/geo/one listing) — parity with the web dashboard.
const TABS = [
  { key: "overview", label: "Overview", icon: "chart", Comp: OverviewTab, ops: false, filterable: true, section: "Analytics" },
  { key: "revenue", label: "Revenue", icon: "card", Comp: RevenueTab, ops: false, filterable: false, section: "Analytics" },
  { key: "discovery", label: "Discovery", icon: "compass", Comp: DiscoveryTab, ops: false, filterable: false, section: "Analytics" },
  { key: "conversion", label: "Conversion", icon: "arrowUR", Comp: ConversionTab, ops: false, filterable: false, section: "Analytics" },
  { key: "engagement", label: "Engagement", icon: "message", Comp: EngagementTab, ops: false, filterable: false, section: "Analytics" },
  { key: "providers", label: "Providers", icon: "store", Comp: ProvidersTab, ops: false, filterable: true, section: "Analytics" },
  { key: "geographic", label: "Geographic", icon: "mappin", Comp: GeographicTab, ops: false, filterable: true, section: "Analytics" },
  { key: "customers", label: "Customers", icon: "users", Comp: CustomersTab, ops: false, filterable: true, section: "Analytics" },
  { key: "ops-bookings", label: "Bookings", icon: "calendar", Comp: BookingsOpsTab, ops: true, filterable: false, section: "Operations" },
  { key: "ops-fraud", label: "Fraud", icon: "shield", Comp: FraudOpsTab, ops: true, filterable: false, section: "Operations" },
  { key: "ops-listings", label: "Listings", icon: "store", Comp: ListingsOpsTab, ops: true, filterable: false, section: "Operations" },
  { key: "ops-coupons", label: "Coupons", icon: "ticket", Comp: CouponsOpsTab, ops: true, filterable: false, section: "Operations" },
  { key: "ops-fees", label: "Fees", icon: "card", Comp: FeesOpsTab, ops: true, filterable: false, section: "Operations" },
  { key: "ops-payouts", label: "Payouts", icon: "wallet", Comp: PayoutsOpsTab, ops: true, filterable: false, section: "Operations" },
  { key: "ops-audit", label: "Audit", icon: "shield", Comp: AuditOpsTab, ops: true, filterable: false, section: "Operations" },
] as const;

const SECTIONS = ["Analytics", "Operations"] as const;

/**
 * Listing filter bar for the filterable analytics tabs: Vertical → Category
 * (narrows to vertical) + State → City (narrows to state) + a single-listing
 * search. Reuses the ops-console chips/sheets so both surfaces feel the same.
 * Tiles the rollups can't slice carry a "Platform-wide" tag instead.
 */
function AnalyticsFilterBar({ filter, onChange }: { filter: AdminMetricFilter; onChange: (f: AdminMetricFilter) => void }) {
  const { t } = useLanguage();
  const [pickerOpen, setPickerOpen] = useState(false);
  const { stateOptions, cityOptions, typeOptions, categoryOptions } = useAdminFacetOptions(filter.states, filter.types);
  const active = adminFilterActive(filter);
  const set = (patch: Partial<AdminMetricFilter>) => onChange({ ...filter, ...patch });

  // Keep dependent selections honest: when a vertical/state is dropped, prune
  // any picked category/city its narrowed list no longer offers. Guarded on a
  // non-empty option list so an in-flight facet fetch never wipes a valid pick.
  React.useEffect(() => {
    const validCats = new Set(categoryOptions.map((o) => o.value.toLowerCase()));
    const validCities = new Set(cityOptions.map((o) => o.value.toLowerCase()));
    const nextCats = categoryOptions.length ? filter.categories.filter((c) => validCats.has(c.toLowerCase())) : filter.categories;
    const nextCities = cityOptions.length ? filter.cities.filter((c) => validCities.has(c.toLowerCase())) : filter.cities;
    if (nextCats.length !== filter.categories.length || nextCities.length !== filter.cities.length) {
      onChange({ ...filter, categories: nextCats, cities: nextCities });
    }
  }, [categoryOptions, cityOptions, filter, onChange]);

  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filterRow}>
        <MultiSelectChip label={t("m.admin.vertical", { defaultValue: "Vertical" })} values={filter.types}
          onChange={(types) => set({ types })} options={typeOptions} />
        <MultiSelectChip label={t("m.adminOps.category", { defaultValue: "Category" })} searchable values={filter.categories}
          onChange={(categories) => set({ categories })} options={categoryOptions} />
        <MultiSelectChip label={t("m.adminOps.state", { defaultValue: "State" })} searchable values={filter.states}
          onChange={(states) => set({ states })} options={stateOptions} />
        <MultiSelectChip label={t("m.adminOps.city", { defaultValue: "City" })} searchable values={filter.cities}
          onChange={(cities) => set({ cities })} options={cityOptions} />
        <Pressable
          style={({ pressed }) => [
            s.listingChip,
            !!filter.listingId && s.listingChipOn,
            pressed && { backgroundColor: "rgba(58,50,71,0.10)", borderColor: T.aubergine },
          ]}
          onPress={() => setPickerOpen(true)}
        >
          <Icon name="store" size={14} color={filter.listingId ? T.aubergine : T.muted} />
          <Text style={[s.listingChipTxt, !!filter.listingId && s.listingChipTxtOn]} numberOfLines={1}>
            {filter.listingId ? (filter.listingLabel ?? t("m.admin.listing", { defaultValue: "Listing" })) : t("m.admin.findListing", { defaultValue: "Find a listing" })}
          </Text>
          {!!filter.listingId && (
            <Pressable hitSlop={8} onPress={() => set({ listingId: null, listingLabel: null })}>
              <Icon name="x" size={13} color={T.aubergine} />
            </Pressable>
          )}
        </Pressable>
        {active && (
          <Pressable onPress={() => onChange(EMPTY_ADMIN_FILTER)} style={({ pressed }) => [s.clearChip, pressed && { backgroundColor: "rgba(58,50,71,0.08)" }]} hitSlop={6}>
            <Icon name="x" size={13} color={T.muted} />
            <Text style={s.clearChipTxt}>{t("m.admin.clearFilters", { defaultValue: "Clear all" })}</Text>
          </Pressable>
        )}
      </ScrollView>
      <ListingPickerSheet
        visible={pickerOpen}
        title={t("m.admin.findListingTitle", { defaultValue: "Filter by listing" })}
        subtitle={t("m.admin.findListingSub", { defaultValue: "Analytics narrow to just this listing" })}
        anyState
        onPick={(l) => { set({ listingId: l.id, listingLabel: l.name }); setPickerOpen(false); }}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

export function AdminScreen() {
  const nav = useNavigation();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { t } = useLanguage();
  const isAdmin = user?.role === "admin";
  const tabLabel = (key: string, fallback: string) => t(`m.admin.tab.${key}`, { defaultValue: fallback });
  const sectionLabel = (name: string) => t(`m.admin.section.${name.toLowerCase()}`, { defaultValue: name });
  const [rangeKey, setRangeKey] = useState("30d");
  const [tab, setTab] = useState<string>("overview");
  const [drawer, setDrawer] = useState(false);
  // Free-form from→to calendar range ("custom" chip); only a complete pair
  // is ever stored, so rangeKey === "custom" implies customRange is set.
  const [customRange, setCustomRange] = useState<{ from: string; to: string } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  // Listing filter shared by the filterable analytics tabs — persists while
  // switching between them so a drill-down survives tab hops.
  const [filter, setFilter] = useState<AdminMetricFilter>(EMPTY_ADMIN_FILTER);
  // Rollups are written nightly — show how fresh the analytics actually are
  // so "today looks empty" reads as staleness, not a drop.
  const freshQ = useQuery({ queryKey: ["m-admin-fresh"], queryFn: fetchFreshness, enabled: isAdmin, staleTime: 5 * 60_000 });
  const CHIPS = useMemo(buildChips, []);
  const range = useMemo<AdminRange>(() => {
    if (rangeKey === "custom" && customRange) return customRange;
    return CHIPS.find((c) => c.key === rangeKey)?.range ?? { days: 30 };
  }, [CHIPS, rangeKey, customRange]);
  const rangeChipLabel =
    rangeKey === "custom" && customRange
      ? customRangeLabel(customRange.from, customRange.to)
      : CHIPS.find((c) => c.key === rangeKey)?.label;
  const active = TABS.find((t) => t.key === tab) ?? TABS[0];
  // Analytics tabs take `range` (+ `filter` on the filterable ones), ops tabs
  // take none — widen to satisfy all call sites below.
  const ActiveTab = active.Comp as React.ComponentType<{ range?: AdminRange; filter?: AdminMetricFilter }>;
  const isOps = active.ops;
  const isFilterable = active.filterable;

  if (!isAdmin) {
    return (
      <View style={s.screen}>
        <View style={[s.head, { paddingTop: insets.top + 8 }]}>
          <IconBtn name="chevL" onPress={() => nav.goBack()} bare />
          <Text style={s.title}>{t("m.admin.title", { defaultValue: "Admin Dashboard" })}</Text>
        </View>
        <View style={s.center}>
          <Icon name="chart" size={40} color={T.muted} />
          <Text style={s.emptyTitle}>{t("m.admin.adminsOnly", { defaultValue: "Admins only" })}</Text>
          <Text style={s.emptyBody}>{t("m.admin.adminsOnlyBody", { defaultValue: "This area needs the admin role on your account." })}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <View style={[s.head, { paddingTop: insets.top + 8 }]}>
        <IconBtn name="chevL" onPress={() => nav.goBack()} bare />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>{t("m.admin.title", { defaultValue: "Admin Dashboard" })}</Text>
          <Text style={s.sub} numberOfLines={1}>
            {isOps
              ? tabLabel(active.key, active.label)
              : `${rangeChipLabel}${freshQ.data?.latestDay ? ` · data through ${freshQ.data.latestDay}` : ""}`}
          </Text>
        </View>
        <Pressable style={({ pressed }) => [s.menuBtn, pressed && { backgroundColor: "rgba(58,50,71,0.08)", borderColor: T.aubergine }]} onPress={() => setDrawer(true)} hitSlop={8}>
          <Icon name={active.icon} size={15} color={T.aubergine} />
          <Text style={s.menuTxt}>{tabLabel(active.key, active.label)}</Text>
          <Icon name="chevD" size={15} color={T.muted} />
        </Pressable>
      </View>

      {!isOps && (
        <View style={s.controls}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow}>
            {CHIPS.map((c) => (
              <Pressable key={c.key} onPress={() => setRangeKey(c.key)} style={({ pressed }) => [s.chip, rangeKey === c.key && s.chipOn, pressed && rangeKey !== c.key && { backgroundColor: "rgba(58,50,71,0.08)", borderColor: T.aubergine }]}>
                <Text style={[s.chipTxt, rangeKey === c.key && s.chipTxtOn]}>{c.label}</Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => setCustomOpen(true)}
              style={({ pressed }) => [s.chip, s.customChip, rangeKey === "custom" && s.chipOn, pressed && rangeKey !== "custom" && { backgroundColor: "rgba(58,50,71,0.08)", borderColor: T.aubergine }]}
            >
              <Icon name="calendar" size={13} color={rangeKey === "custom" ? "#fff" : T.muted} />
              <Text style={[s.chipTxt, rangeKey === "custom" && s.chipTxtOn]}>
                {rangeKey === "custom" && customRange ? customRangeLabel(customRange.from, customRange.to) : t("m.admin.customRange", { defaultValue: "Custom" })}
              </Text>
            </Pressable>
          </ScrollView>
          {isFilterable && <AnalyticsFilterBar filter={filter} onChange={setFilter} />}
        </View>
      )}

      <DateRangeSheet
        visible={customOpen}
        title={t("m.admin.customRangeTitle", { defaultValue: "Custom range" })}
        value={{ start: customRange?.from ?? null, end: customRange?.to ?? null }}
        // Analytics are historical: allow any past date, nothing after today.
        minDate={null}
        maxDate={today()}
        onApply={(r) => {
          if (!r.start || !r.end) return; // need a complete pair to re-query
          setCustomRange({ from: r.start, to: r.end });
          setRangeKey("custom");
        }}
        onClose={() => setCustomOpen(false)}
      />

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {isOps ? <ActiveTab /> : <ActiveTab range={range} filter={isFilterable ? filter : EMPTY_ADMIN_FILTER} />}
      </ScrollView>

      {/* Pop-out side navbar */}
      <Modal visible={drawer} transparent animationType="fade" onRequestClose={() => setDrawer(false)}>
        <Pressable style={s.overlay} onPress={() => setDrawer(false)}>
          <Pressable style={[s.drawer, { paddingTop: insets.top + 16 }]} onPress={(e) => e.stopPropagation()}>
            <Text style={s.drawerTitle}>{t("m.admin.title", { defaultValue: "Admin Dashboard" })}</Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              {SECTIONS.map((section) => (
                <View key={section} style={{ marginTop: 8 }}>
                  <Text style={s.drawerSub}>{sectionLabel(section)}</Text>
                  {TABS.filter((tb) => tb.section === section).map((tb) => {
                    const on = tb.key === tab;
                    return (
                      <Pressable key={tb.key} onPress={() => { setTab(tb.key); setDrawer(false); }} style={({ pressed }) => [s.navRow, on && s.navRowOn, pressed && !on && { backgroundColor: "rgba(58,50,71,0.05)" }]}>
                        <Icon name={tb.icon} size={18} color={on ? T.aubergine : T.muted} />
                        <Text style={[s.navTxt, on && s.navTxtOn]}>{tabLabel(tb.key, tb.label)}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: T.bg },
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingBottom: 8, backgroundColor: "#fff" },
  title: { fontSize: 18, fontFamily: font.head, color: T.ink },
  sub: { fontSize: 12, color: T.muted, fontFamily: font.body },
  menuBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 12, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  menuTxt: { fontSize: 13, fontFamily: font.head, color: T.aubergine },
  center: { alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 48 },
  emptyTitle: { fontSize: 16, fontFamily: font.head, color: T.ink },
  emptyBody: { fontSize: 13, color: T.muted, fontFamily: font.body, textAlign: "center", paddingHorizontal: 24 },
  controls: { backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: T.line, paddingBottom: 4 },
  chipRow: { gap: 8, paddingHorizontal: 14, paddingVertical: 8 },
  filterRow: { gap: 8, paddingHorizontal: 14, paddingBottom: 8, alignItems: "center" },
  listingChip: { flexDirection: "row", alignItems: "center", gap: 6, height: 40, borderRadius: 12, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", paddingHorizontal: 12 },
  listingChipOn: { borderColor: T.aubergine, backgroundColor: "rgba(58,50,71,0.08)" },
  listingChipTxt: { fontSize: 13.5, fontFamily: font.body, color: T.muted, maxWidth: 150 },
  listingChipTxtOn: { color: T.aubergine, fontFamily: font.head },
  clearChip: { flexDirection: "row", alignItems: "center", gap: 4, height: 40, paddingHorizontal: 10, borderRadius: 12 },
  clearChipTxt: { fontSize: 12.5, fontFamily: font.head, color: T.muted },
  chip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  customChip: { flexDirection: "row", alignItems: "center", gap: 5 },
  chipOn: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  chipTxt: { fontSize: 12.5, fontFamily: font.head, color: T.muted },
  chipTxtOn: { color: "#fff" },
  overlay: { flex: 1, flexDirection: "row", backgroundColor: "rgba(23,22,28,0.4)" },
  drawer: { width: "74%", maxWidth: 320, maxHeight: "100%", backgroundColor: "#fff", paddingHorizontal: 16, paddingBottom: 24, borderTopRightRadius: 20, borderBottomRightRadius: 20 },
  drawerTitle: { fontSize: 18, fontFamily: font.head, color: T.ink },
  drawerSub: { fontSize: 11, color: T.muted, fontFamily: font.body, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 12 },
  navRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 13, borderRadius: 14 },
  navRowOn: { backgroundColor: "rgba(58,50,71,0.08)" },
  navTxt: { fontSize: 15, fontFamily: font.head, color: T.muted },
  navTxtOn: { color: T.ink },
});
