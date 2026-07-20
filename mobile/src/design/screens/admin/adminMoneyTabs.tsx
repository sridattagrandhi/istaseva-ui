// design/screens/admin/adminMoneyTabs.tsx — the two money ops tabs:
//   FeesOpsTab    — platform-fee rules (mirror of web /admin/fees): customer
//                   fees + business commission, most-specific-wins resolver
//                   (listing > city > tier > state > global), append-only
//                   rules (create / edit-as-replace / deactivate), city-tier
//                   mapping, and a "test a booking" simulator.
//   PayoutsOpsTab — payouts ledger (mirror of web /admin/payouts): who is
//                   owed what (net of commission), record-a-payout, history.
// Uses the shared ops kit (adminOpsUi) so filters/sheets/badges feel
// identical to the other Operations tabs.
import React, { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Modal, ScrollView, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../../Icon";
import { IconBtn } from "../../primitives";
import { T, font, noOutline } from "../../theme";
import { useLanguage } from "@/contexts/LanguageContext";
import { DateRangeSheet } from "../DateRangeSheet";
import {
  adminOps,
  type AdminFeeRuleRow,
  type AdminOwedRow,
  type AdminPartnerBusinessRow,
  type AdminPayoutRow,
  type CreateFeeRuleInput,
  type FeeSimulationResult,
} from "../../api/adminOps";
import {
  Badge, DetailSheet, FieldLabel, KV, ListingPickerSheet, OpsButton, OpsEmpty, OpsInput,
  OpsLoading, PillAction, ReasonSheet, RowCard, SelectChip, dateLabel, rupees, useAdminFacetOptions,
} from "./adminOpsUi";

type Audience = "customer" | "business";
type ScopeType = AdminFeeRuleRow["scope_type"];

const errMsg = (e: unknown, fallback: string) =>
  (e instanceof Error && e.message) ? e.message : fallback;

/** "2% + ₹5 (min ₹3, max ₹99)" — the fee formula in one glance. */
function feeLabel(r: AdminFeeRuleRow): string {
  const parts: string[] = [];
  const pct = Number(r.percent_bps) / 100;
  if (pct > 0) parts.push(`${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}%`);
  if (Number(r.fixed_paise) > 0 || pct === 0) parts.push(rupees(r.fixed_paise));
  let label = parts.join(" + ");
  const caps: string[] = [];
  if (r.min_fee_paise != null) caps.push(`min ${rupees(r.min_fee_paise)}`);
  if (r.max_fee_paise != null) caps.push(`max ${rupees(r.max_fee_paise)}`);
  if (caps.length) label += ` (${caps.join(", ")})`;
  return label;
}

const TIER_LABEL: Record<string, string> = { tier1: "Tier 1", tier2: "Tier 2", tier3: "Tier 3" };

function scopeLabel(r: AdminFeeRuleRow): string {
  switch (r.scope_type) {
    case "listing": return r.listing_name ? `Listing: ${r.listing_name}` : "One listing";
    case "city": return `${r.scope_city}, ${r.scope_state}`;
    case "city_tier": return `${TIER_LABEL[r.scope_tier ?? ""] ?? r.scope_tier} cities`;
    case "state": return r.scope_state ?? "State";
    default: return "Everywhere (global default)";
  }
}

// Fee-rule verticals are plural; the listing facets key on the singular
// listing_type — map before narrowing the type options.
const VERTICAL_TO_LISTING_TYPE: Record<string, string> = { stays: "stay", services: "service", transport: "transport" };

// "driver-cab" → "Driver Cab" for display; the stored value stays the raw slug.
const labelize = (v: string) => v.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Facet-driven service types (raw listing categories) within one vertical;
 *  empty until a vertical is chosen, so dependent pickers can hide. */
function useServiceTypeOptions(vertical: string) {
  const { categoryOptions } = useAdminFacetOptions(
    [],
    vertical ? [VERTICAL_TO_LISTING_TYPE[vertical] ?? vertical] : [],
  );
  return vertical ? categoryOptions : [];
}

/** "Services · Salon" / "Services" / fallback — the rule's category axis. */
function categoryDisplay(r: AdminFeeRuleRow, allLabel: string): string {
  if (!r.category) return allLabel;
  const base = r.category[0].toUpperCase() + r.category.slice(1);
  return r.subcategory ? `${base} · ${labelize(r.subcategory)}` : base;
}

/** "YYYY-MM-DD" (DateRangeSheet) → ISO datetime the API's zod schema takes. */
const dayStartIso = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toISOString() : null);
const dayEndIso = (d: string | null) => (d ? new Date(`${d}T23:59:59`).toISOString() : null);

/** Rupee text field → integer paise, or null when blank/invalid. */
function rupeesToPaise(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/* ─────────────────────────── FEES ─────────────────────────── */

export function FeesOpsTab() {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const [audience, setAudience] = useState<Audience>("customer");
  const [category, setCategory] = useState<"" | "stays" | "services" | "transport">("");
  const [subcategory, setSubcategory] = useState("");
  const [scopeType, setScopeType] = useState<"" | ScopeType>("");
  const [showInactive, setShowInactive] = useState<"" | "all">("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editSource, setEditSource] = useState<AdminFeeRuleRow | null>(null);
  const [deactTarget, setDeactTarget] = useState<AdminFeeRuleRow | null>(null);
  const [deactBusy, setDeactBusy] = useState(false);
  const isBusiness = audience === "business";

  const filterTypeOptions = useServiceTypeOptions(category);
  const rules = useQuery({
    queryKey: ["m-ops-fee-rules", audience, category, subcategory, scopeType, showInactive],
    queryFn: () => adminOps.fees.rules.list({
      audience,
      category: category || undefined,
      subcategory: subcategory || undefined,
      scopeType: scopeType || undefined,
      includeInactive: showInactive === "all",
    }),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["m-ops-fee-rules"] });

  const doDeactivate = async (reason: string) => {
    if (!deactTarget) return;
    setDeactBusy(true);
    try {
      await adminOps.fees.rules.deactivate(deactTarget.id, reason);
      setDeactTarget(null);
      invalidate();
    } catch (e: unknown) {
      Alert.alert(t("m.adminOps.feeDeactivateFail", { defaultValue: "Couldn't deactivate" }), errMsg(e, t("m.adminOps.tryAgain", { defaultValue: "Please try again." })));
    } finally { setDeactBusy(false); }
  };

  const rows = rules.data?.rules ?? [];

  return (
    <View>
      {/* audience: customer fees price bookings; business = payout commission */}
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
        {(["customer", "business"] as const).map((a) => (
          <Pressable key={a} onPress={() => setAudience(a)} style={[m.audChip, audience === a && m.audChipOn]}>
            <Text style={[m.audTxt, audience === a && m.audTxtOn]}>
              {a === "customer"
                ? t("m.adminOps.customerFees", { defaultValue: "Customer fees" })
                : t("m.adminOps.businessCommission", { defaultValue: "Business commission" })}
            </Text>
          </Pressable>
        ))}
      </View>
      {isBusiness && (
        <View style={m.note}>
          <Text style={m.noteTxt}>
            {t("m.adminOps.commissionNote", { defaultValue: "Commission rules are stored, audited, and testable — payout deduction isn't wired yet, so partners aren't charged off them until payouts go live." })}
          </Text>
        </View>
      )}

      <View style={m.filterRow}>
        <SelectChip
          label={t("m.adminOps.allCategories", { defaultValue: "All categories" })}
          value={category}
          onChange={(v) => { setCategory((v || "") as typeof category); setSubcategory(""); }}
          options={[
            { value: "", label: t("m.adminOps.allCategories", { defaultValue: "All categories" }) },
            { value: "stays", label: t("m.adminOps.stays", { defaultValue: "Stays" }) },
            { value: "services", label: t("m.adminOps.services", { defaultValue: "Services" }) },
            { value: "transport", label: t("m.adminOps.transport", { defaultValue: "Transport" }) },
          ]}
        />
        {category ? (
          <SelectChip
            label={t("m.adminOps.allTypes", { defaultValue: "All types" })}
            value={subcategory}
            onChange={(v) => setSubcategory(v || "")}
            options={[{ value: "", label: t("m.adminOps.allTypes", { defaultValue: "All types" }) }, ...filterTypeOptions]}
          />
        ) : null}
        <SelectChip
          label={t("m.adminOps.allScopes", { defaultValue: "All scopes" })}
          value={scopeType}
          onChange={(v) => setScopeType((v || "") as typeof scopeType)}
          options={[
            { value: "", label: t("m.adminOps.allScopes", { defaultValue: "All scopes" }) },
            { value: "global", label: t("m.adminOps.scopeGlobal", { defaultValue: "Global" }) },
            { value: "state", label: t("m.adminOps.scopeState", { defaultValue: "State" }) },
            { value: "city_tier", label: t("m.adminOps.scopeTier", { defaultValue: "City tier" }) },
            { value: "city", label: t("m.adminOps.scopeCity", { defaultValue: "City" }) },
            { value: "listing", label: t("m.adminOps.scopeListing", { defaultValue: "Listing" }) },
          ]}
        />
        <SelectChip
          label={t("m.adminOps.activeOnly", { defaultValue: "Active" })}
          value={showInactive}
          onChange={(v) => setShowInactive((v || "") as typeof showInactive)}
          options={[
            { value: "", label: t("m.adminOps.activeOnly", { defaultValue: "Active" }) },
            { value: "all", label: t("m.adminOps.inclInactive", { defaultValue: "All (incl. inactive)" }) },
          ]}
        />
      </View>
      <OpsButton
        label={t("m.adminOps.newRule", { defaultValue: "New rule" })}
        onPress={() => { setEditSource(null); setSheetOpen(true); }}
      />
      <View style={{ height: 12 }} />

      {rules.isLoading ? <OpsLoading /> : rules.error ? (
        <OpsEmpty>{t("m.adminOps.loadFeesFail", { defaultValue: "Couldn't load fee rules." })}</OpsEmpty>
      ) : rows.length === 0 ? (
        <OpsEmpty>{t("m.adminOps.noFeeRules", { defaultValue: "No rules match these filters." })}</OpsEmpty>
      ) : (
        rows.map((r) => (
          <RowCard key={r.id}>
            <View style={m.rowTop}>
              <Text style={m.rowTitle} numberOfLines={1}>{scopeLabel(r)}</Text>
              <Badge
                text={r.active ? t("m.adminOps.active", { defaultValue: "Active" }) : t("m.adminOps.inactive", { defaultValue: "Inactive" })}
                tone={r.active ? "ok" : "muted"}
              />
            </View>
            <Text style={m.rowSub} numberOfLines={1}>
              {categoryDisplay(r, t("m.adminOps.allCategories", { defaultValue: "All categories" }))} · {feeLabel(r)}
            </Text>
            <Text style={m.rowMeta} numberOfLines={1}>
              {dateLabel(r.effective_from)}{r.effective_to ? ` → ${dateLabel(r.effective_to)}` : " →"}{r.reason ? ` · ${r.reason}` : ""}
            </Text>
            {r.active && (
              <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                <PillAction label={t("m.adminOps.edit", { defaultValue: "Edit" })} onPress={() => { setEditSource(r); setSheetOpen(true); }} />
                <PillAction label={t("m.adminOps.deactivate", { defaultValue: "Deactivate" })} tone="danger" onPress={() => setDeactTarget(r)} />
              </View>
            )}
          </RowCard>
        ))
      )}

      <SimulatorCard audience={audience} />
      <TiersCard />

      <RuleSheet
        visible={sheetOpen}
        audience={audience}
        editSource={editSource}
        onClose={() => { setSheetOpen(false); setEditSource(null); }}
        onSaved={() => { setSheetOpen(false); setEditSource(null); invalidate(); }}
      />
      <ReasonSheet
        visible={deactTarget != null}
        title={t("m.adminOps.deactivateRuleTitle", { defaultValue: "Deactivate this rule?" })}
        body={deactTarget ? `${scopeLabel(deactTarget)} · ${feeLabel(deactTarget)} — ${t("m.adminOps.deactivateRuleBody", { defaultValue: "it stays in history; create a replacement if a different rate should apply." })}` : undefined}
        confirmLabel={t("m.adminOps.deactivate", { defaultValue: "Deactivate" })}
        busy={deactBusy}
        onConfirm={doDeactivate}
        onClose={() => setDeactTarget(null)}
      />
    </View>
  );
}

/* Create/edit sheet. Editing saves as a REPLACEMENT (server retires the
 * original atomically) — rules are immutable because bookings snapshot the
 * rule id that priced them. */
function RuleSheet({ visible, audience, editSource, onClose, onSaved }: {
  visible: boolean; audience: Audience; editSource: AdminFeeRuleRow | null;
  onClose: () => void; onSaved: () => void;
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const { stateOptions } = useAdminFacetOptions([]);
  const [category, setCategory] = useState<"" | "stays" | "services" | "transport">("");
  const [subcategory, setSubcategory] = useState("");
  const formTypeOptions = useServiceTypeOptions(category);
  const [scopeType, setScopeType] = useState<ScopeType>("global");
  const [scopeState, setScopeState] = useState("");
  const [scopeCity, setScopeCity] = useState("");
  const [scopeTier, setScopeTier] = useState<"tier1" | "tier2" | "tier3">("tier1");
  const [listing, setListing] = useState<{ id: string; name: string } | null>(null);
  const [listingOpen, setListingOpen] = useState(false);
  const [percentText, setPercentText] = useState("0");
  const [fixedText, setFixedText] = useState("3");
  const [minText, setMinText] = useState("");
  const [maxText, setMaxText] = useState("");
  const [effFrom, setEffFrom] = useState<string | null>(null);
  const [effTo, setEffTo] = useState<string | null>(null);
  const [datesOpen, setDatesOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const init = () => {
    if (editSource) {
      const pct = Number(editSource.percent_bps) / 100;
      setCategory((editSource.category ?? "") as typeof category);
      setSubcategory(editSource.subcategory ?? "");
      setScopeType(editSource.scope_type);
      setScopeState(editSource.scope_state ?? "");
      setScopeCity(editSource.scope_city ?? "");
      setScopeTier((editSource.scope_tier as typeof scopeTier) ?? "tier1");
      setListing(editSource.scope_listing_id ? { id: editSource.scope_listing_id, name: editSource.listing_name ?? "This listing" } : null);
      setPercentText(pct % 1 === 0 ? String(pct) : pct.toFixed(2));
      setFixedText(String(Number(editSource.fixed_paise) / 100));
      setMinText(editSource.min_fee_paise != null ? String(Number(editSource.min_fee_paise) / 100) : "");
      setMaxText(editSource.max_fee_paise != null ? String(Number(editSource.max_fee_paise) / 100) : "");
      setEffFrom(editSource.effective_from ? editSource.effective_from.slice(0, 10) : null);
      setEffTo(editSource.effective_to ? editSource.effective_to.slice(0, 10) : null);
      setReason(editSource.reason ?? "");
    } else {
      setCategory(""); setSubcategory(""); setScopeType("global"); setScopeState(""); setScopeCity("");
      setScopeTier("tier1"); setListing(null);
      setPercentText("0"); setFixedText(audience === "business" ? "0" : "3");
      setMinText(""); setMaxText(""); setEffFrom(null); setEffTo(null); setReason("");
    }
  };

  const submit = async () => {
    const percent = Number(percentText);
    const fixedPaise = rupeesToPaise(fixedText);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      Alert.alert(t("m.adminOps.badPercentTitle", { defaultValue: "Check the percent" }), t("m.adminOps.badPercent", { defaultValue: "Percent must be between 0 and 100." }));
      return;
    }
    if (fixedPaise == null) {
      Alert.alert(t("m.adminOps.badFixedTitle", { defaultValue: "Check the fixed fee" }), t("m.adminOps.badFixed", { defaultValue: "Fixed fee must be ₹0 or more." }));
      return;
    }
    const input: CreateFeeRuleInput = {
      audience,
      category: category || null,
      subcategory: category ? (subcategory || null) : null,
      scopeType,
      scopeState: scopeType === "state" || scopeType === "city" ? scopeState : null,
      scopeCity: scopeType === "city" ? scopeCity : null,
      scopeTier: scopeType === "city_tier" ? scopeTier : null,
      scopeListingId: scopeType === "listing" ? listing?.id ?? null : null,
      percentBps: Math.round(percent * 100),
      fixedPaise,
      minFeePaise: rupeesToPaise(minText),
      maxFeePaise: rupeesToPaise(maxText),
      effectiveFrom: dayStartIso(effFrom),
      effectiveTo: dayEndIso(effTo),
      reason: reason.trim() || null,
    };
    setBusy(true);
    try {
      if (editSource) await adminOps.fees.rules.replace(editSource.id, input);
      else await adminOps.fees.rules.create(input);
      onSaved();
    } catch (e: unknown) {
      Alert.alert(t("m.adminOps.saveRuleFail", { defaultValue: "Couldn't save the rule" }), errMsg(e, t("m.adminOps.tryAgain", { defaultValue: "Please try again." })));
    } finally { setBusy(false); }
  };

  const needsState = scopeType === "state" || scopeType === "city";
  const canSubmit = !busy
    && (!needsState || !!scopeState)
    && (scopeType !== "city" || !!scopeCity.trim())
    && (scopeType !== "listing" || (!!listing && !!reason.trim()));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} onShow={init}>
      <Pressable style={m.scrim} onPress={onClose} />
      <View style={[m.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={m.handle} />
        <View style={m.sheetHead}>
          <Text style={m.sheetTitle}>
            {editSource
              ? t("m.adminOps.editRuleTitle", { defaultValue: "Edit rule (saves as replacement)" })
              : t("m.adminOps.newRuleTitle", { defaultValue: "New fee rule" })}
          </Text>
          <IconBtn name="x" onPress={onClose} bare />
        </View>
        <ScrollView style={{ maxHeight: 520 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <FieldLabel first>{t("m.adminOps.category", { defaultValue: "Category" })}</FieldLabel>
              <SelectChip label={t("m.adminOps.allCategories", { defaultValue: "All categories" })} value={category}
                onChange={(v) => { setCategory((v || "") as typeof category); setSubcategory(""); }}
                options={[
                  { value: "", label: t("m.adminOps.allCategories", { defaultValue: "All categories" }) },
                  { value: "stays", label: t("m.adminOps.stays", { defaultValue: "Stays" }) },
                  { value: "services", label: t("m.adminOps.services", { defaultValue: "Services" }) },
                  { value: "transport", label: t("m.adminOps.transport", { defaultValue: "Transport" }) },
                ]} />
            </View>
            <View style={{ flex: 1 }}>
              <FieldLabel first>{t("m.adminOps.scope", { defaultValue: "Scope" })}</FieldLabel>
              <SelectChip label={t("m.adminOps.scopeGlobal", { defaultValue: "Global" })} value={scopeType}
                onChange={(v) => { setScopeType((v || "global") as ScopeType); setListing(null); }}
                options={[
                  { value: "global", label: t("m.adminOps.scopeGlobalLong", { defaultValue: "Global (everywhere)" }) },
                  { value: "state", label: t("m.adminOps.scopeState", { defaultValue: "State" }) },
                  { value: "city_tier", label: t("m.adminOps.scopeTier", { defaultValue: "City tier" }) },
                  { value: "city", label: t("m.adminOps.scopeCityLong", { defaultValue: "Specific city" }) },
                  { value: "listing", label: t("m.adminOps.scopeListingLong", { defaultValue: "One listing" }) },
                ]} />
            </View>
          </View>

          {category ? (
            <>
              <FieldLabel>{t("m.adminOps.serviceType", { defaultValue: "Service type (optional — narrows to one type)" })}</FieldLabel>
              <SelectChip
                label={t("m.adminOps.allTypes", { defaultValue: "All types" })}
                value={subcategory}
                onChange={(v) => setSubcategory(v || "")}
                options={[{ value: "", label: t("m.adminOps.allTypes", { defaultValue: "All types" }) }, ...formTypeOptions]}
              />
            </>
          ) : null}

          {needsState && (
            <>
              <FieldLabel>{t("m.adminOps.state", { defaultValue: "State" })}</FieldLabel>
              <SelectChip label={t("m.adminOps.pickState", { defaultValue: "Pick a state…" })} value={scopeState}
                onChange={(v) => setScopeState(v || "")}
                options={[{ value: "", label: t("m.adminOps.pickState", { defaultValue: "Pick a state…" }) }, ...stateOptions]} />
            </>
          )}
          {scopeType === "city" && (
            <>
              <FieldLabel>{t("m.adminOps.city", { defaultValue: "City" })}</FieldLabel>
              <TextInput style={[m.input, noOutline]} value={scopeCity} onChangeText={setScopeCity} placeholder="e.g. Jaipur" placeholderTextColor={T.muted} />
            </>
          )}
          {scopeType === "city_tier" && (
            <>
              <FieldLabel>{t("m.adminOps.tier", { defaultValue: "Tier (map cities below)" })}</FieldLabel>
              <SelectChip label="Tier 1" value={scopeTier} onChange={(v) => setScopeTier((v || "tier1") as typeof scopeTier)}
                options={[{ value: "tier1", label: "Tier 1" }, { value: "tier2", label: "Tier 2" }, { value: "tier3", label: "Tier 3" }]} />
            </>
          )}
          {scopeType === "listing" && (
            <>
              <FieldLabel>{t("m.adminOps.listing", { defaultValue: "Listing" })}</FieldLabel>
              <Pressable style={[m.input, { justifyContent: "center" }]} onPress={() => setListingOpen(true)}>
                <Text style={{ fontSize: 14, fontFamily: font.body, color: listing ? T.ink : T.muted }} numberOfLines={1}>
                  {listing ? listing.name : t("m.adminOps.pickListing", { defaultValue: "Pick a listing…" })}
                </Text>
              </Pressable>
            </>
          )}

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <FieldLabel>{t("m.adminOps.percentOfSubtotal", { defaultValue: "Percent (%)" })}</FieldLabel>
              <TextInput style={[m.input, noOutline]} value={percentText} onChangeText={setPercentText} keyboardType="decimal-pad" placeholderTextColor={T.muted} />
            </View>
            <View style={{ flex: 1 }}>
              <FieldLabel>{t("m.adminOps.plusFixed", { defaultValue: "Plus fixed (₹)" })}</FieldLabel>
              <TextInput style={[m.input, noOutline]} value={fixedText} onChangeText={setFixedText} keyboardType="decimal-pad" placeholderTextColor={T.muted} />
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <FieldLabel>{t("m.adminOps.minFee", { defaultValue: "Min fee (₹, optional)" })}</FieldLabel>
              <TextInput style={[m.input, noOutline]} value={minText} onChangeText={setMinText} keyboardType="decimal-pad" placeholder="—" placeholderTextColor={T.muted} />
            </View>
            <View style={{ flex: 1 }}>
              <FieldLabel>{t("m.adminOps.maxFee", { defaultValue: "Max fee (₹, optional)" })}</FieldLabel>
              <TextInput style={[m.input, noOutline]} value={maxText} onChangeText={setMaxText} keyboardType="decimal-pad" placeholder="—" placeholderTextColor={T.muted} />
            </View>
          </View>

          <FieldLabel>{t("m.adminOps.effectiveWindow", { defaultValue: "Effective window (optional)" })}</FieldLabel>
          <Pressable style={[m.input, { flexDirection: "row", alignItems: "center", gap: 8 }]} onPress={() => setDatesOpen(true)}>
            <Icon name="calendar" size={14} color={effFrom ? T.aubergine : T.muted} />
            <Text style={{ fontSize: 14, fontFamily: font.body, color: effFrom ? T.ink : T.muted }}>
              {effFrom ? `${dateLabel(effFrom)}${effTo ? ` → ${dateLabel(effTo)}` : " →"}` : t("m.adminOps.startsNow", { defaultValue: "Starts now, no end" })}
            </Text>
            {effFrom ? (
              <Pressable style={{ marginLeft: "auto" }} onPress={() => { setEffFrom(null); setEffTo(null); }}>
                <Icon name="x" size={14} color={T.muted} />
              </Pressable>
            ) : null}
          </Pressable>

          <FieldLabel>
            {scopeType === "listing"
              ? t("m.adminOps.reasonRequired", { defaultValue: "Reason (required for listing rules)" })
              : t("m.adminOps.reasonOptional", { defaultValue: "Reason (optional, audit log)" })}
          </FieldLabel>
          <TextInput style={[m.input, noOutline]} value={reason} onChangeText={setReason} placeholder={t("m.adminOps.reasonExample", { defaultValue: "e.g. Diwali promo for Tier 2 cities" })} placeholderTextColor={T.muted} />

          <View style={{ height: 16 }} />
          <OpsButton
            label={busy
              ? t("m.adminOps.saving", { defaultValue: "Saving…" })
              : editSource
                ? t("m.adminOps.saveChanges", { defaultValue: "Save changes" })
                : t("m.adminOps.createRule", { defaultValue: "Create rule" })}
            onPress={submit}
            disabled={!canSubmit}
          />
          <View style={{ height: 8 }} />
        </ScrollView>
      </View>
      {/* iOS gotcha: stacked sheets must be descendants of the presented modal. */}
      <ListingPickerSheet
        visible={listingOpen}
        title={t("m.adminOps.pickListing", { defaultValue: "Pick a listing…" })}
        onPick={(l: { id: string; name: string }) => { setListing({ id: l.id, name: l.name }); setListingOpen(false); }}
        onClose={() => setListingOpen(false)}
      />
      <DateRangeSheet
        visible={datesOpen}
        value={{ start: effFrom, end: effTo }}
        onApply={(r) => { setEffFrom(r.start); setEffTo(r.end); }}
        onClose={() => setDatesOpen(false)}
      />
    </Modal>
  );
}

/** "Test a booking" — same resolver bookings use; business shows host-receives. */
function SimulatorCard({ audience }: { audience: Audience }) {
  const { t } = useLanguage();
  const { stateOptions } = useAdminFacetOptions([]);
  const [category, setCategory] = useState<"stays" | "services" | "transport">("stays");
  // Optional specific type — when picked, the simulator resolves with the
  // REAL listing category so subcategory-scoped rules can win.
  const [simType, setSimType] = useState("");
  const simTypeOptions = useServiceTypeOptions(category);
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [amountText, setAmountText] = useState("1000");
  const [result, setResult] = useState<FeeSimulationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const isBusiness = audience === "business";

  // Results from one audience shouldn't linger on the other tab.
  React.useEffect(() => { setResult(null); }, [audience]);

  const run = async () => {
    setBusy(true);
    try {
      const res = await adminOps.fees.simulate({
        audience,
        // A picked type IS a raw listing category (so subcategory rules can
        // match); otherwise a representative value for the vertical.
        category: simType || (category === "stays" ? "hotel" : category === "transport" ? "driver-cab" : "salon"),
        state: state || null,
        city: city.trim() || null,
        subtotalPaise: Math.max(0, Math.round(Number(amountText) * 100)) || 0,
      });
      setResult(res);
    } catch (e: unknown) {
      Alert.alert(t("m.adminOps.simulateFail", { defaultValue: "Couldn't run the test" }), errMsg(e, t("m.adminOps.tryAgain", { defaultValue: "Please try again." })));
    } finally { setBusy(false); }
  };

  return (
    <View style={m.card}>
      <Text style={m.cardTitle}>{t("m.adminOps.testBooking", { defaultValue: "Test a booking" })}</Text>
      <Text style={m.cardSub}>
        {isBusiness
          ? t("m.adminOps.testBookingSubBiz", { defaultValue: "Which commission rule wins, and what does the host receive?" })
          : t("m.adminOps.testBookingSub", { defaultValue: "Which rule wins, and what does the customer pay?" })}
      </Text>
      <View style={m.filterRow}>
        <SelectChip label={t("m.adminOps.stays", { defaultValue: "Stays" })} value={category}
          onChange={(v) => { setCategory((v || "stays") as typeof category); setSimType(""); }}
          options={[
            { value: "stays", label: t("m.adminOps.stays", { defaultValue: "Stays" }) },
            { value: "services", label: t("m.adminOps.services", { defaultValue: "Services" }) },
            { value: "transport", label: t("m.adminOps.transport", { defaultValue: "Transport" }) },
          ]} />
        <SelectChip label={t("m.adminOps.anyType", { defaultValue: "Any type" })} value={simType}
          onChange={(v) => setSimType(v || "")}
          options={[{ value: "", label: t("m.adminOps.anyType", { defaultValue: "Any type" }) }, ...simTypeOptions]} />
        <SelectChip label={t("m.adminOps.anyState", { defaultValue: "Any state" })} value={state}
          onChange={(v) => setState(v || "")}
          options={[{ value: "", label: t("m.adminOps.anyState", { defaultValue: "Any state" }) }, ...stateOptions]} />
      </View>
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
        <View style={{ flex: 1 }}>
          <OpsInput value={city} onChangeText={setCity} placeholder={t("m.adminOps.cityOptional", { defaultValue: "City (optional)" })} />
        </View>
        <View style={{ width: 110 }}>
          <TextInput style={[m.input, noOutline, { height: 40 }]} value={amountText} onChangeText={setAmountText} keyboardType="number-pad" placeholder="₹" placeholderTextColor={T.muted} />
        </View>
        <OpsButton small label={busy ? "…" : t("m.adminOps.test", { defaultValue: "Test" })} onPress={run} disabled={busy} />
      </View>
      {result && (
        <View style={m.resultBox}>
          <Text style={m.resultRule} numberOfLines={2}>
            {result.matched.rule
              ? `${scopeLabel(result.matched.rule)} · ${categoryDisplay(result.matched.rule, t("m.adminOps.allCategories", { defaultValue: "All categories" }))} · ${feeLabel(result.matched.rule)}`
              : t("m.adminOps.legacyFallback", { defaultValue: "No rule matched — legacy flat ₹3 fallback" })}
          </Text>
          <ResultRow label={t("m.adminOps.subtotal", { defaultValue: "Subtotal" })} value={rupees(result.breakdown.subtotalPaise)} />
          <ResultRow
            label={isBusiness ? t("m.adminOps.commission", { defaultValue: "Commission" }) : t("m.adminOps.platformFee", { defaultValue: "Platform fee" })}
            value={`${isBusiness ? "−" : ""}${rupees(result.breakdown.platformFeePaise)}`}
          />
          {!isBusiness && <ResultRow label={`GST (${Math.round(result.breakdown.gstRate * 100)}%)`} value={rupees(result.breakdown.taxesPaise)} />}
          <ResultRow
            bold
            label={isBusiness ? t("m.adminOps.hostReceives", { defaultValue: "Host receives" }) : t("m.adminOps.customerPays", { defaultValue: "Customer pays" })}
            value={rupees(result.breakdown.totalPaise)}
          />
        </View>
      )}
    </View>
  );
}

function ResultRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={m.resultRow}>
      <Text style={[m.resultLbl, bold && { color: T.ink, fontFamily: font.head }]}>{label}</Text>
      <Text style={[m.resultVal, bold && { fontFamily: font.head }]}>{value}</Text>
    </View>
  );
}

/** City → tier mapping consumed by tier-scoped rules. */
function TiersCard() {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const { stateOptions } = useAdminFacetOptions([]);
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [tier, setTier] = useState<"tier1" | "tier2" | "tier3">("tier1");
  const [busy, setBusy] = useState(false);

  const tiers = useQuery({ queryKey: ["m-ops-fee-tiers"], queryFn: () => adminOps.fees.tiers.list() });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["m-ops-fee-tiers"] });

  const add = async () => {
    if (!city.trim() || !state) return;
    setBusy(true);
    try { await adminOps.fees.tiers.upsert({ city: city.trim(), state, tier }); setCity(""); invalidate(); }
    catch (e: unknown) { Alert.alert(t("m.adminOps.tierFail", { defaultValue: "Couldn't map the city" }), errMsg(e, t("m.adminOps.tryAgain", { defaultValue: "Please try again." }))); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try { await adminOps.fees.tiers.remove(id); invalidate(); }
    catch (e: unknown) { Alert.alert(t("m.adminOps.tierFail", { defaultValue: "Couldn't map the city" }), errMsg(e, t("m.adminOps.tryAgain", { defaultValue: "Please try again." }))); }
  };

  const rows = tiers.data?.tiers ?? [];
  return (
    <View style={m.card}>
      <Text style={m.cardTitle}>{t("m.adminOps.cityTiers", { defaultValue: "City tiers" })}</Text>
      <Text style={m.cardSub}>{t("m.adminOps.cityTiersSub", { defaultValue: "Which cities count as Tier 1/2/3 for tier-scoped rules. Unmapped cities fall through to their state rule." })}</Text>
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 6 }}>
        <View style={{ flex: 1 }}>
          <OpsInput value={city} onChangeText={setCity} placeholder={t("m.adminOps.city", { defaultValue: "City" })} />
        </View>
        <SelectChip label={t("m.adminOps.stateShort", { defaultValue: "State…" })} value={state} onChange={(v) => setState(v || "")}
          options={[{ value: "", label: t("m.adminOps.stateShort", { defaultValue: "State…" }) }, ...stateOptions]} />
      </View>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <SelectChip label="Tier 1" value={tier} onChange={(v) => setTier((v || "tier1") as typeof tier)}
          options={[{ value: "tier1", label: "Tier 1" }, { value: "tier2", label: "Tier 2" }, { value: "tier3", label: "Tier 3" }]} />
        <OpsButton small label={busy ? "…" : t("m.adminOps.mapCity", { defaultValue: "Map city" })} onPress={add} disabled={busy || !city.trim() || !state} />
      </View>
      {rows.length === 0 ? (
        <Text style={m.rowMeta}>{t("m.adminOps.noTiers", { defaultValue: "No cities mapped yet — tier rules won't match anything until you add some." })}</Text>
      ) : (
        rows.map((tr) => (
          <View key={tr.id} style={m.tierRow}>
            <Text style={m.tierCity} numberOfLines={1}>{tr.city}</Text>
            <Text style={m.rowMeta} numberOfLines={1}>{tr.state}</Text>
            <Badge text={TIER_LABEL[tr.tier] ?? tr.tier} tone="primary" />
            <PillAction label={t("m.adminOps.remove", { defaultValue: "Remove" })} tone="danger" onPress={() => remove(tr.id)} />
          </View>
        ))
      )}
    </View>
  );
}

/* ─────────────────────────── PAYOUTS ─────────────────────────── */

export function PayoutsOpsTab() {
  const { t } = useLanguage();
  const qc = useQueryClient();
  // Tap a row → detail sheet with the full picture + the record action.
  // Rows themselves stay to two calm lines (name+amount / bookings+status).
  const [detail, setDetail] = useState<AdminOwedRow | null>(null);
  const [payoutDetail, setPayoutDetail] = useState<AdminPayoutRow | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const owed = useQuery({ queryKey: ["m-ops-payouts-owed"], queryFn: () => adminOps.payouts.summary() });
  const ledger = useQuery({ queryKey: ["m-ops-payouts-ledger"], queryFn: () => adminOps.payouts.ledger({ limit: 50 }) });
  // The tapped partner's businesses (their listings), grouped by vertical in
  // the detail sheet — informational; recording stays per-partner.
  const businesses = useQuery({
    queryKey: ["m-ops-partner-biz", detail?.providerUserId],
    queryFn: () => adminOps.payouts.partnerBusinesses(detail!.providerUserId),
    enabled: detail != null,
  });

  const owedRows = owed.data?.owed ?? [];
  const history = ledger.data?.payouts ?? [];

  const destination = (p: AdminPayoutRow) => {
    const snap = p.accountSnapshot;
    if (!snap) return p.method.toUpperCase();
    if (snap.method === "upi") return snap.upiIdMasked ?? "UPI";
    return [snap.accountNumberMasked, snap.ifsc].filter(Boolean).join(" · ") || "Bank";
  };

  const record = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await adminOps.payouts.record(detail.providerUserId, note.trim() || undefined);
      setDetail(null);
      qc.invalidateQueries({ queryKey: ["m-ops-payouts-owed"] });
      qc.invalidateQueries({ queryKey: ["m-ops-payouts-ledger"] });
    } catch (e: unknown) {
      Alert.alert(t("m.adminOps.recordFail", { defaultValue: "Couldn't record the payout" }), errMsg(e, t("m.adminOps.tryAgain", { defaultValue: "Please try again." })));
    } finally { setBusy(false); }
  };

  return (
    <View>
      <Text style={m.secTitle}>{t("m.adminOps.owedTitle", { defaultValue: "Owed to partners" })}</Text>
      <Text style={m.cardSub}>{t("m.adminOps.owedSub", { defaultValue: "Completed, paid, unrefunded bookings not yet covered by a payout — net of commission. Tap a partner for details." })}</Text>
      {owed.isLoading ? <OpsLoading /> : owed.error ? (
        <OpsEmpty>{t("m.adminOps.loadOwedFail", { defaultValue: "Couldn't load the owed summary." })}</OpsEmpty>
      ) : owedRows.length === 0 ? (
        <OpsEmpty>{t("m.adminOps.nothingOwed", { defaultValue: "Nothing owed right now — every payable booking is covered." })}</OpsEmpty>
      ) : (
        owedRows.map((o) => (
          <RowCard key={o.providerUserId} onPress={() => { setNote(""); setDetail(o); }}>
            <View style={m.rowTop}>
              <Text style={m.rowTitle} numberOfLines={1}>{o.name}</Text>
              <Text style={m.owedAmt}>{rupees(o.pendingPaise)}</Text>
            </View>
            <View style={[m.rowTop, { marginTop: 5 }]}>
              <Text style={m.rowMeta} numberOfLines={1}>
                {t("m.adminOps.owedBookings", { defaultValue: "{{count}} bookings", count: o.bookings })}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Badge
                  text={o.accountMethod
                    ? t("m.adminOps.readyToPay", { defaultValue: "ready to pay" })
                    : t("m.adminOps.noAccount", { defaultValue: "no account" })}
                  tone={o.accountMethod ? "ok" : "warn"}
                />
                <Icon name="chevR" size={14} color={T.muted} />
              </View>
            </View>
          </RowCard>
        ))
      )}

      <Text style={[m.secTitle, { marginTop: 18 }]}>{t("m.adminOps.payoutHistory", { defaultValue: "Payout history" })}</Text>
      {ledger.isLoading ? <OpsLoading /> : history.length === 0 ? (
        <OpsEmpty>{t("m.adminOps.noPayouts", { defaultValue: "No payouts recorded yet." })}</OpsEmpty>
      ) : (
        history.map((p) => (
          <RowCard key={p.id} onPress={() => setPayoutDetail(p)}>
            <View style={m.rowTop}>
              <Text style={m.rowTitle} numberOfLines={1}>{p.name}</Text>
              <Text style={m.owedAmt}>{rupees(p.amountPaise)}</Text>
            </View>
            <View style={[m.rowTop, { marginTop: 5 }]}>
              <Text style={m.rowMeta} numberOfLines={1}>
                {dateLabel(p.createdAt)} · {t("m.adminOps.owedBookings", { defaultValue: "{{count}} bookings", count: p.bookings })}
              </Text>
              <Icon name="chevR" size={14} color={T.muted} />
            </View>
          </RowCard>
        ))
      )}

      {/* Owed-partner detail: everything the row didn't cram in, plus the
          record action (inline — no second stacked sheet needed). */}
      <DetailSheet
        visible={detail != null}
        title={detail?.name ?? ""}
        subtitle={detail?.email ?? undefined}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <>
            <KV label={t("m.adminOps.owedNet", { defaultValue: "Owed (net of commission)" })} value={rupees(detail.pendingPaise)} />
            <KV label={t("m.adminOps.bookingsCovered", { defaultValue: "Bookings covered" })} value={String(detail.bookings)} />
            <KV
              label={t("m.adminOps.payoutAccount", { defaultValue: "Payout account" })}
              value={detail.accountMethod
                ? detail.accountMethod.toUpperCase()
                : t("m.adminOps.notAdded", { defaultValue: "Not added" })}
            />

            <FieldLabel>{t("m.adminOps.businesses", { defaultValue: "Businesses" })}</FieldLabel>
            {businesses.isLoading ? (
              <OpsLoading />
            ) : (businesses.data?.businesses.length ?? 0) === 0 ? (
              <Text style={m.rowMeta}>{t("m.adminOps.noBusinesses", { defaultValue: "No listings on this account." })}</Text>
            ) : (
              (["stay", "service", "transport"] as const)
                .filter((ty) => businesses.data!.businesses.some((b) => b.listingType === ty))
                .map((ty) => {
                  const rows = businesses.data!.businesses.filter((b) => b.listingType === ty);
                  const sum = rows.reduce((s, b) => s + b.pendingPaise, 0);
                  return (
                    <View key={ty} style={{ marginBottom: 8 }}>
                      <View style={m.rowTop}>
                        <Text style={m.bizType}>
                          {t(`m.adminOps.${ty}`, { defaultValue: ty[0].toUpperCase() + ty.slice(1) })} · {rows.length}
                        </Text>
                        <Text style={m.rowMeta}>
                          {sum > 0
                            ? t("m.adminOps.owedShort", { defaultValue: "{{amount}} owed", amount: rupees(sum) })
                            : t("m.adminOps.nothingOwedShort", { defaultValue: "nothing owed" })}
                        </Text>
                      </View>
                      {rows.map((b) => (
                        <View key={b.listingId} style={m.bizRow}>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                              <Text style={m.bizName} numberOfLines={1}>{b.name}</Text>
                              {b.status !== "live" && (
                                <Badge
                                  text={b.status === "suspended"
                                    ? t("m.adminOps.suspended", { defaultValue: "Suspended" })
                                    : b.status === "removed"
                                      ? t("m.adminOps.removed", { defaultValue: "Removed" })
                                      : t("m.adminOps.inactive", { defaultValue: "Inactive" })}
                                  tone={b.status === "suspended" ? "danger" : "muted"}
                                />
                              )}
                            </View>
                            <Text style={m.rowMeta} numberOfLines={1}>
                              {[b.category ? labelize(b.category) : null, b.city].filter(Boolean).join(" · ") || "—"}
                            </Text>
                          </View>
                          <View style={{ alignItems: "flex-end" }}>
                            <Text style={m.bizAmt}>{b.pendingPaise > 0 ? rupees(b.pendingPaise) : "—"}</Text>
                            {b.bookings > 0 && (
                              <Text style={m.rowMeta}>
                                {t("m.adminOps.owedBookings", { defaultValue: "{{count}} bookings", count: b.bookings })}
                              </Text>
                            )}
                          </View>
                        </View>
                      ))}
                    </View>
                  );
                })
            )}

            {detail.accountMethod ? (
              <>
                <FieldLabel>{t("m.adminOps.noteOptional", { defaultValue: "Reference / note (optional — UTR, batch id…)" })}</FieldLabel>
                <TextInput style={[m.input, noOutline]} value={note} onChangeText={setNote} placeholder="UTR 4213…" placeholderTextColor={T.muted} />
                <Text style={[m.rowMeta, { marginTop: 8, marginBottom: 12 }]}>
                  {t("m.adminOps.recordBody", { defaultValue: "Move the money first, then record it here — every currently payable booking gets marked paid and can't be paid twice." })}
                </Text>
                <OpsButton
                  label={busy
                    ? t("m.adminOps.recording", { defaultValue: "Recording…" })
                    : t("m.adminOps.recordAmount", { defaultValue: "Record {{amount}} payout", amount: rupees(detail.pendingPaise) })}
                  onPress={record}
                  disabled={busy}
                />
              </>
            ) : (
              <View style={[m.note, { marginTop: 12 }]}>
                <Text style={m.noteTxt}>
                  {t("m.adminOps.askAddAccount", { defaultValue: "This partner hasn't added a payout account yet — ask them to add one from their dashboard's Payouts tab. Recording is disabled until then so the ledger always knows where money went." })}
                </Text>
              </View>
            )}
            <View style={{ height: 8 }} />
          </>
        )}
      </DetailSheet>

      {/* History detail: masked destination + note, too long for a row. */}
      <DetailSheet
        visible={payoutDetail != null}
        title={payoutDetail?.name ?? ""}
        subtitle={payoutDetail ? dateLabel(payoutDetail.createdAt) : undefined}
        onClose={() => setPayoutDetail(null)}
      >
        {payoutDetail && (
          <>
            <KV label={t("m.adminOps.amount", { defaultValue: "Amount" })} value={rupees(payoutDetail.amountPaise)} />
            <KV label={t("m.adminOps.bookingsCovered", { defaultValue: "Bookings covered" })} value={String(payoutDetail.bookings)} />
            <KV label={t("m.adminOps.destination", { defaultValue: "Destination" })} value={destination(payoutDetail)} />
            <KV
              label={t("m.adminOps.status", { defaultValue: "Status" })}
              value={<Badge text={payoutDetail.status} tone={payoutDetail.status === "paid" ? "ok" : "danger"} />}
            />
            {payoutDetail.note ? <KV label={t("m.adminOps.note", { defaultValue: "Note" })} value={payoutDetail.note} /> : null}
            <View style={{ height: 8 }} />
          </>
        )}
      </DetailSheet>
    </View>
  );
}

const m = StyleSheet.create({
  filterRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  audChip: { flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: 12, borderWidth: 1, borderColor: T.line },
  audChipOn: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  audTxt: { fontSize: 12.5, fontFamily: font.head, color: T.muted },
  audTxtOn: { color: "#fff" },
  note: { backgroundColor: "rgba(216,164,90,0.14)", borderWidth: 1, borderColor: "rgba(216,164,90,0.4)", borderRadius: 12, padding: 10, marginBottom: 10 },
  noteTxt: { fontSize: 12, fontFamily: font.body, color: "#8a5a18", lineHeight: 17 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  rowTitle: { fontSize: 14.5, fontFamily: font.head, color: T.ink, flexShrink: 1 },
  rowSub: { fontSize: 12.5, color: T.ink, fontFamily: font.body, marginTop: 3 },
  rowMeta: { fontSize: 12, color: T.muted, fontFamily: font.body, marginTop: 2 },
  owedAmt: { fontSize: 15, fontFamily: font.head, color: T.ink },
  secTitle: { fontSize: 15, fontFamily: font.head, color: T.ink, marginBottom: 4 },
  card: { backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: T.line, padding: 14, marginTop: 16 },
  cardTitle: { fontSize: 15, fontFamily: font.head, color: T.ink },
  cardSub: { fontSize: 12, fontFamily: font.body, color: T.muted, marginTop: 2, marginBottom: 10 },
  resultBox: { backgroundColor: T.bg, borderRadius: 12, padding: 12, marginTop: 4 },
  resultRule: { fontSize: 13, fontFamily: font.head, color: T.ink, marginBottom: 6 },
  resultRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  resultLbl: { fontSize: 12.5, fontFamily: font.body, color: T.muted },
  resultVal: { fontSize: 12.5, fontFamily: font.body, color: T.ink },
  tierRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: T.line },
  bizType: { fontSize: 12, fontFamily: font.head, color: T.aubergine, textTransform: "uppercase", letterSpacing: 0.4 },
  bizRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: T.line },
  bizName: { fontSize: 13.5, fontFamily: font.head, color: T.ink, flexShrink: 1 },
  bizAmt: { fontSize: 13.5, fontFamily: font.head, color: T.ink },
  tierCity: { fontSize: 13.5, fontFamily: font.head, color: T.ink, flexShrink: 1, flexGrow: 1 },
  // sheet chrome (matches adminOpsTabs' create sheet)
  scrim: { flex: 1, backgroundColor: "rgba(23,22,28,0.4)" },
  sheet: { backgroundColor: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 16, paddingTop: 10 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 999, backgroundColor: T.line, marginBottom: 10 },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  sheetTitle: { fontSize: 17, fontFamily: font.head, color: T.ink, flexShrink: 1 },
  input: { height: 40, borderRadius: 12, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", paddingHorizontal: 12, fontSize: 14, fontFamily: font.body, color: T.ink },
});
