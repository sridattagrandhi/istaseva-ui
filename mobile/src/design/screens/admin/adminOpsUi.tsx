// Shared building blocks for the mobile admin OPERATIONS tabs — filter bar
// chips, list rows, a bottom-sheet detail container, status badges, and a
// searchable option/user picker. Kept separate from adminUi.tsx (analytics).
import React, { useState } from "react";
import { View, Text, TextInput, Pressable, Modal, ScrollView, ActivityIndicator, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../Icon";
import { IconBtn } from "../../primitives";
import { T, font, noOutline } from "../../theme";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { DateRangeSheet, type DateRange } from "../DateRangeSheet";
import { adminOps, type DateFilter } from "../../api/adminOps";

// Press-feedback tints — a colour "pops" while the finger is down. Kept here
// so every ops control shares one feel.
const PRESS = {
  soft: "rgba(58,50,71,0.10)",   // neutral surfaces (chips, rows, cards)
  danger: "rgba(164,93,98,0.14)", // destructive pills
};

// ── formatters ──
const nf = new Intl.NumberFormat("en-IN");
export const rupees = (paise: number | null | undefined) =>
  `₹${(Number(paise ?? 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
export function dateLabel(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
export function dateTimeLabel(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

// ── screen shell bits ──
export function OpsLoading() {
  return <View style={s.center}><ActivityIndicator color={T.aubergine} /></View>;
}
export function OpsEmpty({ children }: { children: React.ReactNode }) {
  return <Text style={s.empty}>{children}</Text>;
}
export function FieldLabel({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return <Text style={[s.fieldLabel, first && { marginTop: 0 }]}>{children}</Text>;
}

/** Compact bordered pill for inline row actions (Ban / Deactivate / Unban) —
 *  reads as a button, not a text link. */
export function PillAction({ label, onPress, tone = "neutral" }: {
  label: string; onPress?: () => void; tone?: "neutral" | "danger";
}) {
  const danger = tone === "danger";
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        s.pill,
        { borderColor: danger ? "rgba(164,93,98,0.4)" : T.line },
        pressed && { backgroundColor: danger ? PRESS.danger : PRESS.soft, transform: [{ scale: 0.97 }] },
      ]}
      hitSlop={6}
    >
      <Text style={[s.pillTxt, { color: danger ? T.coral : T.ink }]}>{label}</Text>
    </Pressable>
  );
}

/** Plain text filter input, sized to sit in the filter bar. */
export function OpsInput({ value, onChangeText, placeholder, onSubmit }: {
  value: string; onChangeText: (v: string) => void; placeholder: string; onSubmit?: () => void;
}) {
  return (
    <TextInput
      style={[s.input, noOutline]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={T.muted}
      autoCapitalize="none"
      autoCorrect={false}
      returnKeyType="search"
      onSubmitEditing={onSubmit}
    />
  );
}

/** Solid pill button (Apply / Search). */
export function OpsButton({ label, onPress, tone = "primary", small, disabled }: {
  label: string; onPress?: () => void; tone?: "primary" | "outline" | "danger"; small?: boolean; disabled?: boolean;
}) {
  const bg = tone === "primary" ? T.aubergine : tone === "danger" ? T.coral : "#fff";
  const fg = tone === "outline" ? T.ink : "#fff";
  const border = tone === "outline" ? T.line : bg;
  // Pressed: solid buttons darken (opacity), outline buttons fill with a tint.
  const pressedStyle = tone === "outline"
    ? { backgroundColor: PRESS.soft, borderColor: T.aubergine }
    : { opacity: 0.75 };
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.btn, small && s.btnSm,
        { backgroundColor: bg, borderColor: border, opacity: disabled ? 0.5 : 1 },
        pressed && !disabled && [pressedStyle, { transform: [{ scale: 0.98 }] }],
      ]}
    >
      <Text style={[s.btnTxt, small && s.btnTxtSm, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

// ── chip-style single select (opens an options sheet) ──
export function SelectChip<T extends string>({ label, value, options, onChange }: {
  label: string; value: T | "";
  options: Array<{ value: T | ""; label: string }>;
  onChange: (v: T | "") => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <>
      <Pressable style={({ pressed }) => [s.selectChip, pressed && { backgroundColor: PRESS.soft, borderColor: T.aubergine }]} onPress={() => setOpen(true)}>
        <Text style={s.selectTxt} numberOfLines={1}>{current?.label ?? label}</Text>
        <Icon name="chevD" size={14} color={T.muted} />
      </Pressable>
      <OptionsSheet
        visible={open}
        title={label}
        options={options}
        selected={value}
        onPick={(v) => { onChange(v as T | ""); setOpen(false); }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export function OptionsSheet<V extends string>({ visible, title, options, selected, onPick, onClose }: {
  visible: boolean; title: string;
  options: Array<{ value: V; label: string }>;
  selected: V; onPick: (v: V) => void; onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={s.handle} />
        <View style={s.sheetHead}>
          <Text style={s.sheetTitle}>{title}</Text>
          <IconBtn name="x" onPress={onClose} bare />
        </View>
        <ScrollView style={{ maxHeight: 380 }}>
          {options.map((o) => (
            <Pressable key={String(o.value)} style={({ pressed }) => [s.optionRow, pressed && { backgroundColor: PRESS.soft }]} onPress={() => onPick(o.value)}>
              <Text style={[s.optionTxt, o.value === selected && s.optionTxtOn]}>{o.label}</Text>
              {o.value === selected && <Icon name="check" size={16} color={T.aubergine} />}
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** Date-range filter chip → opens the shared DateRangeSheet. Stores YYYY-MM-DD. */
export function DateRangeChip({ value, onChange }: { value: DateFilter; onChange: (v: DateFilter) => void }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const has = !!value.from;
  const label = has ? `${dateLabel(value.from)} – ${value.to ? dateLabel(value.to) : "…"}` : t("m.adminOps.anyDates", { defaultValue: "Any dates" });
  return (
    <>
      <Pressable style={({ pressed }) => [s.selectChip, pressed && { backgroundColor: PRESS.soft, borderColor: T.aubergine }]} onPress={() => setOpen(true)}>
        <Icon name="calendar" size={14} color={has ? T.aubergine : T.muted} />
        <Text style={[s.selectTxt, { maxWidth: 150 }]} numberOfLines={1}>{label}</Text>
        {has && (
          <Pressable hitSlop={8} onPress={() => onChange({})}>
            <Icon name="x" size={13} color={T.muted} />
          </Pressable>
        )}
      </Pressable>
      <DateRangeSheet
        visible={open}
        value={{ start: value.from ?? null, end: value.to ?? null } as DateRange}
        onApply={(r) => onChange({ from: r.start ?? undefined, to: r.end ?? undefined })}
        onClose={() => setOpen(false)}
        title={t("m.adminOps.dateRange", { defaultValue: "Date range" })}
        // Ops filters look back at existing records — past dates must be selectable.
        minDate={null}
      />
    </>
  );
}

// ── multi-select filters ──

// "home_cleaning" / "home-cleaning" → "Home Cleaning" for the sheets; the
// underlying filter value stays the raw DB slug. Mirrors web adminUi.tsx.
const labelizeCategory = (c: string) => c.replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

/**
 * Loads /api/admin/facets once (shared across the ops tabs) and shapes it
 * into MultiSelectChip option lists. Everything is a SELECT DISTINCT over
 * the listings table — nothing hardcoded. Cities narrow to the selected
 * states, categories narrow to the selected listing types. Mirrors
 * useAdminFacetOptions in web src/pages/admin/adminUi.tsx.
 */
export function useAdminFacetOptions(selectedStates: string[], selectedTypes: string[] = []) {
  const { t } = useLanguage();
  const facetsQuery = useQuery({
    queryKey: ["m-admin-facets"],
    queryFn: () => adminOps.facets(),
    staleTime: 5 * 60_000,
  });
  const facets = facetsQuery.data;
  return React.useMemo(() => {
    const stateSet = new Set(selectedStates.map((v) => v.toLowerCase()));
    const cityMap = new Map<string, string>();
    for (const c of facets?.cities ?? []) {
      if (stateSet.size && (!c.state || !stateSet.has(c.state.toLowerCase()))) continue;
      const key = c.city.toLowerCase();
      if (!cityMap.has(key)) cityMap.set(key, c.city);
    }
    const typeSet = new Set(selectedTypes.map((v) => v.toLowerCase()));
    const categoryMap = new Map<string, string>();
    for (const c of facets?.categories ?? []) {
      if (typeSet.size && !typeSet.has(c.type.toLowerCase())) continue;
      const key = c.value.toLowerCase();
      if (!categoryMap.has(key)) categoryMap.set(key, c.value);
    }
    // Presentation names for the DB's listing_type values (reuses the
    // existing stay/service/transport translations), falling back to a
    // capitalized form of whatever the DB holds.
    const typeLabel = (v: string) =>
      ["stay", "service", "transport"].includes(v)
        ? t(`m.adminOps.${v}`, { defaultValue: labelizeCategory(v) })
        : labelizeCategory(v);
    return {
      stateOptions: (facets?.states ?? []).map((v) => ({ value: v, label: v })),
      cityOptions: Array.from(cityMap.values()).map((v) => ({ value: v, label: v })),
      typeOptions: (facets?.types ?? []).map((v) => ({ value: v, label: typeLabel(v) })),
      categoryOptions: Array.from(categoryMap.values()).map((v) => ({ value: v, label: labelizeCategory(v) })),
    };
  }, [facets, selectedStates, selectedTypes, t]);
}

/**
 * Chip-style multi-select → checkbox bottom sheet. The chip shows the filter
 * name plus a selected-count pill and tints aubergine when active, matching
 * the SelectChip / range-chip language used across the admin console.
 */
export function MultiSelectChip({ label, values, onChange, options, searchable }: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  options: Array<{ value: string; label: string }>;
  /** Show a search box inside the sheet (for long lists like cities). */
  searchable?: boolean;
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const active = values.length > 0;
  const visible = q.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()))
    : options;
  const toggle = (v: string) =>
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  const close = () => { setOpen(false); setQ(""); };

  return (
    <>
      <Pressable
        style={({ pressed }) => [
          s.selectChip,
          active && { borderColor: T.aubergine, backgroundColor: "rgba(58,50,71,0.08)" },
          pressed && { backgroundColor: PRESS.soft, borderColor: T.aubergine },
        ]}
        onPress={() => setOpen(true)}
      >
        <Text style={[s.selectTxt, active && { color: T.aubergine, fontFamily: font.head }]} numberOfLines={1}>{label}</Text>
        {active && (
          <View style={s.countPill}><Text style={s.countPillTxt}>{values.length}</Text></View>
        )}
        <Icon name="chevD" size={14} color={active ? T.aubergine : T.muted} />
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
        <Pressable style={s.scrim} onPress={close} />
        <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={s.handle} />
          <View style={s.sheetHead}>
            <Text style={s.sheetTitle}>{label}</Text>
            <IconBtn name="x" onPress={close} bare />
          </View>
          {searchable && (
            <OpsInput value={q} onChangeText={setQ}
              placeholder={t("m.adminOps.searchOptions", { defaultValue: "Search…" })} />
          )}
          <ScrollView style={{ maxHeight: 340, marginTop: searchable ? 8 : 0 }} keyboardShouldPersistTaps="handled">
            {visible.length === 0 ? (
              <OpsEmpty>{t("m.adminOps.noOptions", { defaultValue: "No matches." })}</OpsEmpty>
            ) : (
              visible.map((o) => {
                const on = values.includes(o.value);
                return (
                  <Pressable key={o.value} style={({ pressed }) => [s.optionRow, pressed && { backgroundColor: PRESS.soft }]} onPress={() => toggle(o.value)}>
                    <Text style={[s.optionTxt, on && s.optionTxtOn]} numberOfLines={1}>{o.label}</Text>
                    <Icon name={on ? "check" : "dot"} size={16} color={on ? T.aubergine : T.line} />
                  </Pressable>
                );
              })
            )}
          </ScrollView>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
            <View style={{ flex: 1 }}>
              <OpsButton label={t("m.adminOps.clear", { defaultValue: "Clear" })} tone="outline" disabled={!active} onPress={() => onChange([])} />
            </View>
            <View style={{ flex: 2 }}>
              <OpsButton label={t("m.adminOps.done", { defaultValue: "Done" })} onPress={close} />
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

// ── status badge ──
export function Badge({ text, tone = "muted" }: { text: string; tone?: "ok" | "warn" | "danger" | "muted" | "primary" }) {
  const map = {
    ok: { bg: "rgba(97,122,146,0.14)", fg: T.blue },
    warn: { bg: "rgba(189,135,82,0.16)", fg: "#8a5a1f" },
    danger: { bg: "rgba(164,93,98,0.16)", fg: T.coral },
    muted: { bg: "rgba(23,22,28,0.06)", fg: T.muted },
    primary: { bg: "rgba(58,50,71,0.10)", fg: T.aubergine },
  }[tone];
  return (
    <View style={[s.badge, { backgroundColor: map.bg }]}>
      <Text style={[s.badgeTxt, { color: map.fg }]}>{text}</Text>
    </View>
  );
}

// ── list row card (tap to open detail) ──
export function RowCard({ children, onPress }: { children: React.ReactNode; onPress?: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [s.rowCard, pressed && onPress && { backgroundColor: PRESS.soft, borderColor: T.aubergine }]}
      onPress={onPress}
    >
      {children}
    </Pressable>
  );
}

/** key/value line used in detail sheets. */
export function KV({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <View style={s.kv}>
      <Text style={s.kvLabel}>{label}</Text>
      <Text style={s.kvValue}>{value}</Text>
    </View>
  );
}

/** Bottom sheet container for detail views (scrollable, dismissable). */
export function DetailSheet({ visible, title, subtitle, onClose, children }: {
  visible: boolean; title: string; subtitle?: string; onClose: () => void; children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={[s.detailSheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={s.handle} />
        <View style={s.sheetHead}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.sheetTitle} numberOfLines={2}>{title}</Text>
            {!!subtitle && <Text style={s.sheetSub}>{subtitle}</Text>}
          </View>
          <IconBtn name="x" onPress={onClose} bare />
        </View>
        <ScrollView style={{ maxHeight: 560 }} showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** Reason-capture sheet for destructive actions (ban/suspend/cancel). */
export function ReasonSheet({ visible, title, body, confirmLabel, onConfirm, onClose, busy, extra }: {
  visible: boolean; title: string; body?: string; confirmLabel: string;
  onConfirm: (reason: string) => void; onClose: () => void; busy?: boolean;
  extra?: React.ReactNode;
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const [reason, setReason] = useState("");
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} onShow={() => setReason("")}>
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={[s.detailSheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={s.handle} />
        <View style={s.sheetHead}>
          <Text style={s.sheetTitle}>{title}</Text>
          <IconBtn name="x" onPress={onClose} bare />
        </View>
        {!!body && <Text style={s.reasonBody}>{body}</Text>}
        {extra}
        <TextInput
          style={[s.reasonInput, noOutline]}
          value={reason}
          onChangeText={setReason}
          placeholder={t("m.adminOps.reasonPlaceholder", { defaultValue: "Reason (kept in the audit log)" })}
          placeholderTextColor={T.muted}
          multiline
        />
        <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
          <View style={{ flex: 1 }}><OpsButton label={t("m.adminOps.cancel", { defaultValue: "Cancel" })} tone="outline" onPress={onClose} /></View>
          <View style={{ flex: 1 }}>
            <OpsButton label={busy ? t("m.adminOps.working", { defaultValue: "Working…" }) : confirmLabel} tone="danger" disabled={!reason.trim() || busy} onPress={() => onConfirm(reason.trim())} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Inline searchable user picker (uuid / name / email / phone). */
export function UserPicker({ onPick, filter }: {
  onPick: (u: { user_id: string; display_name: string; email: string | null; verification_status: string | null; is_suspended: boolean }) => void;
  /** Optional gate — return a reason string to disable a row, or null to allow. */
  filter?: (u: { verification_status: string | null; is_suspended: boolean }) => string | null;
}) {
  const { t } = useLanguage();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Awaited<ReturnType<typeof adminOps.users.search>>["users"]>([]);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    if (q.trim().length <= 1) { setRows([]); return; }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await adminOps.users.search(q.trim(), 10);
        if (!cancelled) setRows(res.users);
      } catch { if (!cancelled) setRows([]); }
      finally { if (!cancelled) setLoading(false); }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [q]);

  return (
    <View>
      <OpsInput value={q} onChangeText={setQ} placeholder={t("m.adminOps.userSearchPlaceholder", { defaultValue: "Search name, email, phone, or user id…" })} />
      <View style={{ marginTop: 8, gap: 6 }}>
        {q.trim().length <= 1 ? (
          <OpsEmpty>{t("m.adminOps.type2Chars", { defaultValue: "Type at least 2 characters to search." })}</OpsEmpty>
        ) : loading ? (
          <OpsLoading />
        ) : rows.length === 0 ? (
          <OpsEmpty>{t("m.adminOps.noUsers", { defaultValue: "No users match." })}</OpsEmpty>
        ) : (
          rows.map((u) => {
            const blocked = filter?.(u) ?? null;
            return (
              <Pressable
                key={u.user_id}
                disabled={blocked !== null}
                onPress={() => onPick(u)}
                style={({ pressed }) => [s.userRow, blocked !== null && { opacity: 0.5 }, pressed && blocked === null && { backgroundColor: PRESS.soft, borderColor: T.aubergine }]}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.userName}>{u.display_name || "—"}</Text>
                  <Text style={s.userSub} numberOfLines={1}>{u.email ?? u.phone ?? u.user_id}</Text>
                </View>
                {blocked !== null
                  ? <Badge text={blocked} tone="danger" />
                  : <Badge text={t("m.adminOps.kycVerified", { defaultValue: "KYC verified" })} tone="ok" />}
              </Pressable>
            );
          })
        )}
      </View>
    </View>
  );
}

/** Bottom-sheet listing search → picks a listing (id/name/type). Defaults to
 *  live listings only; `anyState` widens to every listing (the analytics
 *  filter cares about historical data of suspended/inactive ones too). */
export function ListingPickerSheet({ visible, title, subtitle, onPick, onClose, anyState }: {
  visible: boolean; title: string; subtitle?: string;
  onPick: (l: { id: string; name: string; type: "stay" | "service" | "transport" }) => void;
  onClose: () => void;
  anyState?: boolean;
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Awaited<ReturnType<typeof adminOps.listings.search>>["listings"]>([]);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => { if (!visible) { setQ(""); setRows([]); } }, [visible]);
  React.useEffect(() => {
    if (q.trim().length <= 1) { setRows([]); return; }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await adminOps.listings.search({ q: q.trim(), state: anyState ? undefined : "live", limit: 10 });
        if (!cancelled) setRows(res.listings);
      } catch { if (!cancelled) setRows([]); }
      finally { if (!cancelled) setLoading(false); }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [q, anyState]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={s.handle} />
        <View style={s.sheetHead}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.sheetTitle}>{title}</Text>
            {!!subtitle && <Text style={s.sheetSub}>{subtitle}</Text>}
          </View>
          <IconBtn name="x" onPress={onClose} bare />
        </View>
        <OpsInput value={q} onChangeText={setQ} placeholder={t("m.adminOps.listingSearchPlaceholder", { defaultValue: "Search name, city, or listing id…" })} />
        <ScrollView style={{ maxHeight: 360, marginTop: 8 }} keyboardShouldPersistTaps="handled">
          {q.trim().length <= 1 ? (
            <OpsEmpty>{anyState
              ? t("m.adminOps.type2CharsAnyListings", { defaultValue: "Type at least 2 characters to search listings." })
              : t("m.adminOps.type2CharsListings", { defaultValue: "Type at least 2 characters to search live listings." })}</OpsEmpty>
          ) : loading ? (
            <OpsLoading />
          ) : rows.length === 0 ? (
            <OpsEmpty>{anyState
              ? t("m.adminOps.noListingsMatch", { defaultValue: "No listings match." })
              : t("m.adminOps.noLiveListings", { defaultValue: "No live listings match." })}</OpsEmpty>
          ) : (
            rows.map((l) => (
              <Pressable
                key={l.id}
                style={({ pressed }) => [s.userRow, { marginBottom: 6 }, pressed && { backgroundColor: PRESS.soft, borderColor: T.aubergine }]}
                onPress={() => onPick({ id: l.id, name: l.name ?? l.title ?? t("m.adminOps.untitled", { defaultValue: "Untitled" }), type: (l.listing_type as any) })}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.userName} numberOfLines={1}>{l.name ?? l.title ?? "Untitled"}</Text>
                  <Text style={s.userSub} numberOfLines={1}>{l.listing_type}{l.city ? ` · ${l.city}` : ""} · {l.host_name ?? l.user_id}</Text>
                </View>
                <Icon name="chevR" size={16} color={T.muted} />
              </Pressable>
            ))
          )}
          <View style={{ height: 8 }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

export const s = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", paddingVertical: 36 },
  empty: { fontSize: 13, color: T.muted, fontFamily: font.body, paddingVertical: 14, textAlign: "center" },
  fieldLabel: { fontSize: 11, color: T.muted, fontFamily: font.body, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 16, marginBottom: 6 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, backgroundColor: "#fff" },
  pillTxt: { fontSize: 12.5, fontFamily: font.head },
  input: { height: 40, borderRadius: 12, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", paddingHorizontal: 12, fontSize: 14, fontFamily: font.body, color: T.ink },
  btn: { height: 40, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  btnSm: { height: 32, paddingHorizontal: 12, borderRadius: 10 },
  btnTxt: { fontSize: 14, fontFamily: font.head },
  btnTxtSm: { fontSize: 12.5 },
  selectChip: { flexDirection: "row", alignItems: "center", gap: 6, height: 40, borderRadius: 12, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", paddingHorizontal: 12 },
  selectTxt: { fontSize: 13.5, fontFamily: font.body, color: T.ink, maxWidth: 130 },
  scrim: { flex: 1, backgroundColor: "rgba(23,22,28,0.4)" },
  sheet: { backgroundColor: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 16, paddingTop: 10 },
  detailSheet: { backgroundColor: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 16, paddingTop: 10 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 999, backgroundColor: T.line, marginBottom: 10 },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 },
  sheetTitle: { fontSize: 17, fontFamily: font.head, color: T.ink },
  sheetSub: { fontSize: 12, color: T.muted, fontFamily: font.body, marginTop: 2 },
  optionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 13, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: T.line },
  optionTxt: { fontSize: 15, fontFamily: font.body, color: T.ink },
  optionTxtOn: { fontFamily: font.head, color: T.aubergine },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, alignSelf: "flex-start" },
  badgeTxt: { fontSize: 11, fontFamily: font.head },
  rowCard: { backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: T.line, padding: 12, marginBottom: 8 },
  kv: { marginBottom: 8 },
  kvLabel: { fontSize: 11, color: T.muted, fontFamily: font.body, textTransform: "uppercase", letterSpacing: 0.3 },
  kvValue: { fontSize: 14, fontFamily: font.body, color: T.ink, marginTop: 1 },
  reasonBody: { fontSize: 13, color: T.muted, fontFamily: font.body, marginBottom: 10, lineHeight: 19 },
  reasonInput: { minHeight: 80, borderRadius: 12, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", padding: 12, fontSize: 14, fontFamily: font.body, color: T.ink, textAlignVertical: "top" },
  countPill: { minWidth: 18, height: 18, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.14)", alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  countPillTxt: { fontSize: 11, fontFamily: font.head, color: T.aubergine },
  userRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  userName: { fontSize: 14, fontFamily: font.head, color: T.ink },
  userSub: { fontSize: 12, color: T.muted, fontFamily: font.body, marginTop: 1 },
});
