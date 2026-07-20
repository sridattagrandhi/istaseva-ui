import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calculator, MapPin, Pencil, Plus, Power } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  adminOps,
  type AdminFeeRuleRow,
  type CreateFeeRuleInput,
  type FeeSimulationResult,
} from "@/domains/admin/admin-ops.service";
import { AdminSelect, PageHeading, Panel, StateNote, labelizeCategory, useAdminFacetOptions } from "./adminUi";

const inputCls =
  "h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/60";

function useDebounced(value: string, delayMs = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

const rupees = (paise: number | null | undefined) =>
  `₹${(Number(paise ?? 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const ts = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—";

const TIER_LABEL: Record<string, string> = { tier1: "Tier 1", tier2: "Tier 2", tier3: "Tier 3" };
const CATEGORY_LABEL: Record<string, string> = { stays: "Stays", services: "Services", transport: "Transport" };

// Fee-rule verticals are plural; the listing facets key on the singular
// listing_type — map before narrowing the type options.
const VERTICAL_TO_LISTING_TYPE: Record<string, string> = { stays: "stay", services: "service", transport: "transport" };

/** Facet-driven service types (raw listing categories) within one vertical;
 *  empty until a vertical is chosen, so dependent pickers can hide. */
function useServiceTypeOptions(vertical: string) {
  const { categoryOptions } = useAdminFacetOptions(
    [],
    vertical ? [VERTICAL_TO_LISTING_TYPE[vertical] ?? vertical] : [],
  );
  return vertical ? categoryOptions : [];
}

/** "Services · Salon" / "Services" / "All" — the rule's category axis in one cell. */
function categoryDisplay(r: AdminFeeRuleRow): string {
  if (!r.category) return "All";
  const base = CATEGORY_LABEL[r.category] ?? r.category;
  return r.subcategory ? `${base} · ${labelizeCategory(r.subcategory)}` : base;
}

/** "Jaipur, Rajasthan" / "Tier 2 cities" / "Rajasthan" / "This listing" / "Everywhere". */
function scopeLabel(r: AdminFeeRuleRow): string {
  switch (r.scope_type) {
    case "listing": return r.listing_name ? `Listing: ${r.listing_name}` : "One listing";
    case "city": return `${r.scope_city}, ${r.scope_state}`;
    case "city_tier": return `${TIER_LABEL[r.scope_tier ?? ""] ?? r.scope_tier} cities`;
    case "state": return r.scope_state ?? "State";
    default: return "Everywhere (global default)";
  }
}

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

const SCOPE_RANK: Record<AdminFeeRuleRow["scope_type"], number> = {
  listing: 0, city: 1, city_tier: 2, state: 3, global: 4,
};

interface RuleForm {
  category: "" | "stays" | "services" | "transport";
  /** Specific service type within the vertical ("" = whole vertical). */
  subcategory: string;
  scopeType: AdminFeeRuleRow["scope_type"];
  scopeState: string;
  scopeCity: string;
  scopeTier: "tier1" | "tier2" | "tier3";
  percentText: string;
  fixedText: string;
  minText: string;
  maxText: string;
  effectiveFrom: string;
  effectiveTo: string;
  reason: string;
}

const EMPTY_RULE_FORM: RuleForm = {
  category: "",
  subcategory: "",
  scopeType: "global",
  scopeState: "",
  scopeCity: "",
  scopeTier: "tier1",
  percentText: "0",
  fixedText: "3",
  minText: "",
  maxText: "",
  effectiveFrom: "",
  effectiveTo: "",
  reason: "",
};

/** datetime-local ("2026-07-09T14:00") → ISO with offset, or null. */
function toIso(value: string): string | null {
  if (!value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO timestamptz → datetime-local input value in the admin's timezone. */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Paise → rupee text for the form fields ("" for null). */
function paiseToRupeeText(paise: number | null | undefined): string {
  if (paise == null) return "";
  const rupees = Number(paise) / 100;
  return rupees % 1 === 0 ? String(rupees) : rupees.toFixed(2);
}

/** Prefill the dialog form from an existing rule (edit-as-replace). */
function formFromRule(r: AdminFeeRuleRow): RuleForm {
  const pct = Number(r.percent_bps) / 100;
  return {
    category: (r.category ?? "") as RuleForm["category"],
    subcategory: r.subcategory ?? "",
    scopeType: r.scope_type,
    scopeState: r.scope_state ?? "",
    scopeCity: r.scope_city ?? "",
    scopeTier: (r.scope_tier as RuleForm["scopeTier"]) ?? "tier1",
    percentText: pct % 1 === 0 ? String(pct) : pct.toFixed(2),
    fixedText: paiseToRupeeText(r.fixed_paise) || "0",
    minText: paiseToRupeeText(r.min_fee_paise),
    maxText: paiseToRupeeText(r.max_fee_paise),
    effectiveFrom: isoToLocalInput(r.effective_from),
    effectiveTo: isoToLocalInput(r.effective_to),
    reason: r.reason ?? "",
  };
}

/** Rupee text field → integer paise, or null when blank/invalid. */
function rupeesToPaise(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/**
 * Ops screen: the platform-fee panel. Rules resolve most-specific-wins
 * (listing > city > tier > state > global); within a scope level a
 * category-specific rule beats an all-categories one. Rules are append-only
 * (create + deactivate). The Business audience (payout commission) is a
 * planned v2 — the tab is present but disabled so the split is visible.
 */
export default function AdminFees() {
  const queryClient = useQueryClient();
  const [audience, setAudience] = useState<"customer" | "business">("customer");
  const [category, setCategory] = useState("");
  const [subcategory, setSubcategory] = useState("");
  const [scopeType, setScopeType] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<RuleForm>(EMPTY_RULE_FORM);
  // When set, the dialog is an EDIT of this rule: submit replaces it
  // (create new + retire old atomically) instead of plain-creating.
  const [editSource, setEditSource] = useState<AdminFeeRuleRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Deactivate confirmation modal (never a browser prompt): the rule being
  // deactivated + the reason typed so far.
  const [deactivateTarget, setDeactivateTarget] = useState<AdminFeeRuleRow | null>(null);
  const [deactivateReason, setDeactivateReason] = useState("");
  const isBusiness = audience === "business";

  // Create-dialog listing typeahead (listing-scope rules only).
  const [listingQuery, setListingQuery] = useState("");
  const [pickedListing, setPickedListing] = useState<{ id: string; name: string } | null>(null);
  const debouncedListingQuery = useDebounced(listingQuery);
  const listingSearch = useQuery({
    queryKey: ["admin-fees-listing-search", debouncedListingQuery],
    queryFn: () => adminOps.listings.search({ q: debouncedListingQuery, state: "live", limit: 8 }),
    enabled: createOpen && form.scopeType === "listing" && debouncedListingQuery.trim().length > 1 && !pickedListing,
  });

  const { stateOptions, cityOptions } = useAdminFacetOptions(
    form.scopeState ? [form.scopeState] : [],
  );
  // Service-type options narrowed to the chosen vertical — one list for the
  // filter bar, one for the create/edit dialog (they track different state).
  const filterTypeOptions = useServiceTypeOptions(category);
  const formTypeOptions = useServiceTypeOptions(form.category);

  const rulesQuery = useQuery({
    queryKey: ["admin-fee-rules", audience, category, subcategory, scopeType, showInactive],
    queryFn: () => adminOps.fees.rules.list({
      audience,
      category: category || undefined,
      subcategory: subcategory || undefined,
      scopeType: scopeType || undefined,
      includeInactive: showInactive,
    }),
  });

  const tiersQuery = useQuery({
    queryKey: ["admin-fee-tiers"],
    queryFn: () => adminOps.fees.tiers.list(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-fee-rules"] });
    queryClient.invalidateQueries({ queryKey: ["admin-fee-tiers"] });
  };

  const createRule = useMutation({
    // Edit mode routes through replace: retires the source rule and creates
    // the edited version in one server-side transaction.
    mutationFn: (input: CreateFeeRuleInput) =>
      editSource ? adminOps.fees.rules.replace(editSource.id, input) : adminOps.fees.rules.create(input),
    onSuccess: () => {
      invalidate();
      setCreateOpen(false);
      setForm(EMPTY_RULE_FORM);
      setEditSource(null);
      setPickedListing(null);
      setListingQuery("");
      setActionError(null);
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const deactivateRule = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => adminOps.fees.rules.deactivate(id, reason),
    onSuccess: () => { invalidate(); setActionError(null); setDeactivateTarget(null); setDeactivateReason(""); },
    onError: (err: Error) => setActionError(err.message),
  });

  const submitRule = () => {
    const percent = Number(form.percentText);
    const fixedPaise = rupeesToPaise(form.fixedText);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      setActionError("Percent must be between 0 and 100.");
      return;
    }
    if (fixedPaise == null) {
      setActionError("Fixed fee must be a number (₹0 or more).");
      return;
    }
    if (form.scopeType === "listing" && !pickedListing) {
      setActionError("Pick the listing this rule applies to.");
      return;
    }
    if (form.scopeType === "listing" && !form.reason.trim()) {
      setActionError("Listing rules need a reason (it lands in the audit log).");
      return;
    }
    createRule.mutate({
      audience,
      category: form.category || null,
      subcategory: form.category ? (form.subcategory || null) : null,
      scopeType: form.scopeType,
      scopeState: form.scopeType === "state" || form.scopeType === "city" ? form.scopeState : null,
      scopeCity: form.scopeType === "city" ? form.scopeCity : null,
      scopeTier: form.scopeType === "city_tier" ? form.scopeTier : null,
      scopeListingId: form.scopeType === "listing" ? pickedListing?.id ?? null : null,
      percentBps: Math.round(percent * 100),
      fixedPaise,
      minFeePaise: rupeesToPaise(form.minText),
      maxFeePaise: rupeesToPaise(form.maxText),
      effectiveFrom: toIso(form.effectiveFrom),
      effectiveTo: toIso(form.effectiveTo),
      reason: form.reason.trim() || null,
    });
  };

  const sortedRules = useMemo(
    () => [...(rulesQuery.data?.rules ?? [])].sort((a, b) =>
      (Number(b.active) - Number(a.active))
      || (SCOPE_RANK[a.scope_type] - SCOPE_RANK[b.scope_type])
      || (Date.parse(b.created_at) - Date.parse(a.created_at))),
    [rulesQuery.data],
  );
  const overrideCount = sortedRules.filter((r) => r.active && r.scope_type === "listing").length;

  return (
    <div className="space-y-6">
      <PageHeading
        title="Fees"
        subtitle="Platform-fee rules. Most specific wins: listing → city → tier → state → global; a category rule beats an all-categories rule at the same level."
      />

      {/* Audience: customer rules price bookings; business rules are the
          payout commission (managed + simulatable now, deducted once the
          payout wiring lands). */}
      <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1 text-sm w-fit">
        {([
          { key: "customer", label: "Customer fees" },
          { key: "business", label: "Business commission" },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={() => { setAudience(tab.key); setActionError(null); }}
            className={`rounded-md px-3 py-1 transition-colors ${
              audience === tab.key
                ? "bg-background font-medium shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {isBusiness ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          Commission rules are stored, audited, and testable below — but payout deduction isn't wired
          yet, so partners aren't charged off them until the payouts work lands.
        </div>
      ) : null}

      {actionError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <Panel
        title="Rules"
        subtitle={overrideCount > 0 ? `${overrideCount} active listing override${overrideCount === 1 ? "" : "s"}` : undefined}
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <AdminSelect
            ariaLabel="Filter category"
            value={category}
            onChange={(v) => { setCategory(v); setSubcategory(""); }}
            options={[
              { value: "", label: "All categories" },
              { value: "stays", label: "Stays" },
              { value: "services", label: "Services" },
              { value: "transport", label: "Transport" },
            ]}
          />
          {category ? (
            <AdminSelect
              ariaLabel="Filter service type"
              value={subcategory}
              onChange={setSubcategory}
              options={[{ value: "", label: "All types" }, ...filterTypeOptions]}
            />
          ) : null}
          <AdminSelect
            ariaLabel="Filter scope"
            value={scopeType}
            onChange={setScopeType}
            options={[
              { value: "", label: "All scopes" },
              { value: "global", label: "Global" },
              { value: "state", label: "State" },
              { value: "city_tier", label: "City tier" },
              { value: "city", label: "City" },
              { value: "listing", label: "Listing" },
            ]}
          />
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
          <button
            onClick={() => {
              setActionError(null);
              setEditSource(null);
              // Sensible starting values per audience: ₹3 mirrors the customer
              // default; commission usually starts percent-only.
              setForm({ ...EMPTY_RULE_FORM, fixedText: isBusiness ? "0" : "3" });
              setPickedListing(null);
              setListingQuery("");
              setCreateOpen(true);
            }}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> New rule
          </button>
        </div>
        {rulesQuery.isLoading ? (
          <StateNote>Loading rules…</StateNote>
        ) : rulesQuery.isError ? (
          <StateNote>Couldn't load fee rules.</StateNote>
        ) : sortedRules.length === 0 ? (
          <StateNote>No rules match these filters.</StateNote>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3">Scope</th>
                  <th className="py-2 pr-3">Category</th>
                  <th className="py-2 pr-3">{isBusiness ? "Commission" : "Fee"}</th>
                  <th className="py-2 pr-3">Effective</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Created</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {sortedRules.map((r) => (
                  <tr key={r.id} className={`border-b border-border/60 ${r.active ? "" : "opacity-55"}`}>
                    <td className="py-2 pr-3">
                      <div className="font-medium">{scopeLabel(r)}</div>
                      {r.reason ? <div className="text-xs text-muted-foreground">{r.reason}</div> : null}
                    </td>
                    <td className="py-2 pr-3">{categoryDisplay(r)}</td>
                    <td className="py-2 pr-3 font-medium">{feeLabel(r)}</td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {ts(r.effective_from)}{r.effective_to ? ` → ${ts(r.effective_to)}` : " →"}
                    </td>
                    <td className="py-2 pr-3">
                      {r.active ? (
                        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">Active</span>
                      ) : (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Inactive</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">{ts(r.created_at)}</td>
                    <td className="py-2 text-right">
                      {r.active ? (
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            onClick={() => {
                              setActionError(null);
                              setEditSource(r);
                              setForm(formFromRule(r));
                              setPickedListing(
                                r.scope_type === "listing" && r.scope_listing_id
                                  ? { id: r.scope_listing_id, name: r.listing_name ?? "This listing" }
                                  : null,
                              );
                              setListingQuery("");
                              setCreateOpen(true);
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
                            title="Edit (saves as a replacement — the original stays in history)"
                          >
                            <Pencil className="h-3.5 w-3.5" /> Edit
                          </button>
                          <button
                            onClick={() => { setActionError(null); setDeactivateReason(""); setDeactivateTarget(r); }}
                            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:border-destructive/50 hover:text-destructive"
                            title="Deactivate (retire without a replacement)"
                          >
                            <Power className="h-3.5 w-3.5" /> Deactivate
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <TiersPanel
          tiers={tiersQuery.data?.tiers ?? []}
          loading={tiersQuery.isLoading}
          onChanged={invalidate}
          onError={setActionError}
        />
        <SimulatorPanel audience={audience} />
      </div>

      {/* Deactivate confirmation — a real modal, matching the rest of the
          ops console (no browser prompt). */}
      <Dialog
        open={deactivateTarget != null}
        onOpenChange={(open) => { if (!open) { setDeactivateTarget(null); setDeactivateReason(""); } }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Deactivate this rule?</DialogTitle>
            <DialogDescription>
              Rules are never edited or deleted — deactivating retires this one immediately and it
              stays in the history. Create a replacement if a different {isBusiness ? "commission" : "fee"} should apply.
            </DialogDescription>
          </DialogHeader>

          {deactivateTarget ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                <div className="font-medium">{scopeLabel(deactivateTarget)}</div>
                <div className="text-muted-foreground">
                  {categoryDisplay(deactivateTarget)} · {feeLabel(deactivateTarget)}
                </div>
              </div>
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">Reason (optional, lands in the audit log)</span>
                <input
                  className={`${inputCls} w-full`}
                  value={deactivateReason}
                  onChange={(e) => setDeactivateReason(e.target.value)}
                  placeholder="e.g. replaced by the new monsoon promo rule"
                  autoFocus
                />
              </label>
              {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}
            </div>
          ) : null}

          <DialogFooter>
            <button
              onClick={() => { setDeactivateTarget(null); setDeactivateReason(""); }}
              className="inline-flex h-9 items-center rounded-lg border border-border px-4 text-sm hover:bg-muted/60"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                if (!deactivateTarget) return;
                deactivateRule.mutate({ id: deactivateTarget.id, reason: deactivateReason.trim() || undefined });
              }}
              disabled={deactivateRule.isPending}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              <Power className="h-4 w-4" /> {deactivateRule.isPending ? "Deactivating…" : "Deactivate"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) { setActionError(null); setEditSource(null); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editSource
                ? (isBusiness ? "Edit commission rule" : "Edit fee rule")
                : (isBusiness ? "New commission rule" : "New fee rule")}
            </DialogTitle>
            <DialogDescription>
              {editSource
                ? "Saving replaces the current rule: the original is retired and kept in history (bookings priced by it are unaffected), and this version takes over."
                : `The most specific active rule wins${isBusiness ? " when commission is computed" : " at booking time"}. Rules can be edited later — an edit saves as a replacement.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Category</span>
                <AdminSelect
                  ariaLabel="Rule category"
                  value={form.category}
                  onChange={(v) => setForm({ ...form, category: v as RuleForm["category"], subcategory: "" })}
                  options={[
                    { value: "", label: "All categories" },
                    { value: "stays", label: "Stays" },
                    { value: "services", label: "Services" },
                    { value: "transport", label: "Transport" },
                  ]}
                  className="w-full"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Scope</span>
                <AdminSelect
                  ariaLabel="Rule scope"
                  value={form.scopeType}
                  onChange={(v) => { setForm({ ...form, scopeType: v as RuleForm["scopeType"] }); setPickedListing(null); }}
                  options={[
                    { value: "global", label: "Global (everywhere)" },
                    { value: "state", label: "State" },
                    { value: "city_tier", label: "City tier" },
                    { value: "city", label: "Specific city" },
                    { value: "listing", label: "One listing" },
                  ]}
                  className="w-full"
                />
              </label>
            </div>

            {form.category ? (
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">
                  Service type (optional — narrows the rule to one type of {CATEGORY_LABEL[form.category].toLowerCase()})
                </span>
                <AdminSelect
                  ariaLabel="Rule service type"
                  value={form.subcategory}
                  onChange={(v) => setForm({ ...form, subcategory: v })}
                  options={[{ value: "", label: `All ${CATEGORY_LABEL[form.category].toLowerCase()}` }, ...formTypeOptions]}
                  className="w-full"
                />
              </label>
            ) : null}

            {form.scopeType === "state" || form.scopeType === "city" ? (
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">State</span>
                  <AdminSelect
                    ariaLabel="Scope state"
                    value={form.scopeState}
                    onChange={(v) => setForm({ ...form, scopeState: v, scopeCity: "" })}
                    options={[{ value: "", label: "Pick a state…" }, ...stateOptions]}
                    className="w-full"
                  />
                </label>
                {form.scopeType === "city" ? (
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">City</span>
                    <input
                      list="admin-fees-city-options"
                      className={`${inputCls} w-full`}
                      value={form.scopeCity}
                      onChange={(e) => setForm({ ...form, scopeCity: e.target.value })}
                      placeholder="e.g. Jaipur"
                    />
                    <datalist id="admin-fees-city-options">
                      {cityOptions.map((c) => <option key={c.value} value={c.value} />)}
                    </datalist>
                  </label>
                ) : null}
              </div>
            ) : null}

            {form.scopeType === "city_tier" ? (
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">Tier (manage the city→tier mapping below)</span>
                <AdminSelect
                  ariaLabel="Scope tier"
                  value={form.scopeTier}
                  onChange={(v) => setForm({ ...form, scopeTier: v as RuleForm["scopeTier"] })}
                  options={[
                    { value: "tier1", label: "Tier 1" },
                    { value: "tier2", label: "Tier 2" },
                    { value: "tier3", label: "Tier 3" },
                  ]}
                  className="w-full"
                />
              </label>
            ) : null}

            {form.scopeType === "listing" ? (
              <div className="space-y-1 text-sm">
                <span className="text-muted-foreground">Listing</span>
                {pickedListing ? (
                  <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                    <span className="truncate font-medium">{pickedListing.name}</span>
                    <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setPickedListing(null)}>
                      change
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      className={`${inputCls} w-full`}
                      value={listingQuery}
                      onChange={(e) => setListingQuery(e.target.value)}
                      placeholder="Search live listings by name…"
                    />
                    {listingQuery.trim().length > 1 ? (
                      <div className="max-h-40 overflow-y-auto rounded-lg border border-border p-1">
                        {listingSearch.isLoading ? (
                          <p className="px-2.5 py-2 text-xs text-muted-foreground">Searching…</p>
                        ) : (listingSearch.data?.listings.length ?? 0) === 0 ? (
                          <p className="px-2.5 py-2 text-xs text-muted-foreground">No live listings match.</p>
                        ) : (
                          listingSearch.data!.listings.map((l) => (
                            <button
                              key={l.id}
                              onClick={() => { setPickedListing({ id: l.id, name: l.name ?? l.title ?? "Untitled" }); setListingQuery(""); }}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-muted/60"
                            >
                              <span className="truncate font-medium">{l.name ?? l.title ?? "Untitled"}</span>
                              <span className="ml-auto shrink-0 text-xs capitalize text-muted-foreground">
                                {l.listing_type} · {l.city ?? ""}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Percent of subtotal (%)</span>
                <input className={`${inputCls} w-full`} inputMode="decimal" value={form.percentText}
                  onChange={(e) => setForm({ ...form, percentText: e.target.value })} />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Plus fixed (₹)</span>
                <input className={`${inputCls} w-full`} inputMode="decimal" value={form.fixedText}
                  onChange={(e) => setForm({ ...form, fixedText: e.target.value })} />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Min fee (₹, optional)</span>
                <input className={`${inputCls} w-full`} inputMode="decimal" value={form.minText}
                  onChange={(e) => setForm({ ...form, minText: e.target.value })} />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Max fee (₹, optional)</span>
                <input className={`${inputCls} w-full`} inputMode="decimal" value={form.maxText}
                  onChange={(e) => setForm({ ...form, maxText: e.target.value })} />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Effective from (optional)</span>
                <input type="datetime-local" className={`${inputCls} w-full`} value={form.effectiveFrom}
                  onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Effective until (optional)</span>
                <input type="datetime-local" className={`${inputCls} w-full`} value={form.effectiveTo}
                  onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} />
              </label>
            </div>

            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">
                Reason {form.scopeType === "listing" ? "(required for listing rules)" : "(optional, lands in the audit log)"}
              </span>
              <input className={`${inputCls} w-full`} value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="e.g. Diwali promo for Tier 2 cities" />
            </label>

            {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}
          </div>

          <DialogFooter>
            <button
              onClick={submitRule}
              disabled={createRule.isPending}
              className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createRule.isPending
                ? (editSource ? "Saving…" : "Creating…")
                : (editSource ? "Save changes" : "Create rule")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TiersPanel({
  tiers, loading, onChanged, onError,
}: {
  tiers: Array<{ id: string; city: string; state: string; tier: string }>;
  loading: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const { stateOptions } = useAdminFacetOptions([]);
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [tier, setTier] = useState<"tier1" | "tier2" | "tier3">("tier1");

  const upsert = useMutation({
    mutationFn: () => adminOps.fees.tiers.upsert({ city: city.trim(), state, tier }),
    onSuccess: () => { setCity(""); onChanged(); },
    onError: (err: Error) => onError(err.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => adminOps.fees.tiers.remove(id),
    onSuccess: onChanged,
    onError: (err: Error) => onError(err.message),
  });

  return (
    <Panel
      title="City tiers"
      subtitle="Which cities count as Tier 1/2/3 for tier-scoped rules. Cities not mapped here fall through to their state rule."
    >
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <input className={`${inputCls} w-36`} placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} />
        <AdminSelect
          ariaLabel="Tier state"
          value={state}
          onChange={setState}
          options={[{ value: "", label: "State…" }, ...stateOptions]}
        />
        <AdminSelect
          ariaLabel="Tier"
          value={tier}
          onChange={(v) => setTier(v as typeof tier)}
          options={[
            { value: "tier1", label: "Tier 1" },
            { value: "tier2", label: "Tier 2" },
            { value: "tier3", label: "Tier 3" },
          ]}
        />
        <button
          onClick={() => {
            if (!city.trim() || !state) { onError("City and state are both required for a tier mapping."); return; }
            upsert.mutate();
          }}
          disabled={upsert.isPending}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm hover:bg-muted/60 disabled:opacity-50"
        >
          <MapPin className="h-4 w-4" /> Map city
        </button>
      </div>
      {loading ? (
        <StateNote>Loading tiers…</StateNote>
      ) : tiers.length === 0 ? (
        <StateNote>No cities mapped yet — tier-scoped rules won't match anything until you add some.</StateNote>
      ) : (
        <ul className="divide-y divide-border/60 text-sm">
          {tiers.map((t) => (
            <li key={t.id} className="flex items-center gap-2 py-1.5">
              <span className="font-medium">{t.city}</span>
              <span className="text-muted-foreground">{t.state}</span>
              <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs">{TIER_LABEL[t.tier] ?? t.tier}</span>
              <button
                className="text-xs text-muted-foreground hover:text-destructive"
                onClick={() => remove.mutate(t.id)}
                title="Remove mapping"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function SimulatorPanel({ audience }: { audience: "customer" | "business" }) {
  const { stateOptions, cityOptions } = useAdminFacetOptions([]);
  const [category, setCategory] = useState("stays");
  // Optional specific type — when picked, the simulator resolves with the
  // REAL listing category so subcategory-scoped rules can win.
  const [simType, setSimType] = useState("");
  const simTypeOptions = useServiceTypeOptions(category);
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [amountText, setAmountText] = useState("1000");
  const [result, setResult] = useState<FeeSimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isBusiness = audience === "business";

  // A result simulated on one tab shouldn't linger when the admin switches
  // audience — the rows mean different things (customer pays vs host receives).
  useEffect(() => { setResult(null); setError(null); }, [audience]);

  const simulate = useMutation({
    mutationFn: () => adminOps.fees.simulate({
      audience,
      // The simulator takes the raw category the resolver sees at booking
      // time. A picked type IS a raw listing category (so subcategory rules
      // can match); otherwise fall back to a representative value.
      category: simType || (category === "stays" ? "hotel" : category === "transport" ? "driver-cab" : "salon"),
      city: city || null,
      state: state || null,
      subtotalPaise: Math.max(0, Math.round(Number(amountText) * 100)) || 0,
    }),
    onSuccess: (data) => { setResult(data); setError(null); },
    onError: (err: Error) => { setResult(null); setError(err.message); },
  });

  return (
    <Panel
      title="Test a booking"
      subtitle={isBusiness
        ? "Which commission rule would win, and what would the host receive? Runs the same resolver."
        : "Which rule would win, and what would the customer pay? Runs the same resolver bookings use."}
    >
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <AdminSelect
          ariaLabel="Simulate category"
          value={category}
          onChange={(v) => { setCategory(v); setSimType(""); }}
          options={[
            { value: "stays", label: "Stays" },
            { value: "services", label: "Services" },
            { value: "transport", label: "Transport" },
          ]}
        />
        <AdminSelect
          ariaLabel="Simulate service type"
          value={simType}
          onChange={setSimType}
          options={[{ value: "", label: "Any type" }, ...simTypeOptions]}
        />
        <AdminSelect
          ariaLabel="Simulate state"
          value={state}
          onChange={setState}
          options={[{ value: "", label: "Any state" }, ...stateOptions]}
        />
        <input
          list="admin-fees-sim-city"
          className={`${inputCls} w-32`}
          placeholder="City (optional)"
          value={city}
          onChange={(e) => setCity(e.target.value)}
        />
        <datalist id="admin-fees-sim-city">
          {cityOptions.map((c) => <option key={c.value} value={c.value} />)}
        </datalist>
        <input
          className={`${inputCls} w-28`}
          inputMode="decimal"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
          placeholder="Subtotal ₹"
        />
        <button
          onClick={() => simulate.mutate()}
          disabled={simulate.isPending}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Calculator className="h-4 w-4" /> {simulate.isPending ? "Testing…" : "Test"}
        </button>
      </div>

      {error ? (
        <div className="mb-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {result ? (
        <div className="space-y-2 text-sm">
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
            <span className="text-muted-foreground">Winning rule: </span>
            {result.matched.rule ? (
              <span className="font-medium">
                {scopeLabel(result.matched.rule as AdminFeeRuleRow)} · {categoryDisplay(result.matched.rule as AdminFeeRuleRow)} · {feeLabel(result.matched.rule as AdminFeeRuleRow)}
              </span>
            ) : (
              <span className="font-medium text-amber-600">
                No rule matched — legacy flat ₹3 fallback (check the global default!)
              </span>
            )}
          </div>
          {isBusiness ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1">
              <dt className="text-muted-foreground">Booking subtotal</dt><dd className="text-right">{rupees(result.breakdown.subtotalPaise)}</dd>
              <dt className="text-muted-foreground">Commission</dt><dd className="text-right font-medium">−{rupees(result.breakdown.platformFeePaise)}</dd>
              <dt className="font-medium">Host receives</dt><dd className="text-right font-semibold">{rupees(result.breakdown.totalPaise)}</dd>
            </dl>
          ) : (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1">
              <dt className="text-muted-foreground">Subtotal</dt><dd className="text-right">{rupees(result.breakdown.subtotalPaise)}</dd>
              <dt className="text-muted-foreground">Platform fee</dt><dd className="text-right font-medium">{rupees(result.breakdown.platformFeePaise)}</dd>
              <dt className="text-muted-foreground">GST ({Math.round(result.breakdown.gstRate * 100)}%)</dt><dd className="text-right">{rupees(result.breakdown.taxesPaise)}</dd>
              <dt className="font-medium">Customer pays</dt><dd className="text-right font-semibold">{rupees(result.breakdown.totalPaise)}</dd>
            </dl>
          )}
        </div>
      ) : null}
    </Panel>
  );
}
