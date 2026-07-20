/**
 * Reusable coupons manager for any listing kind — stays (host), services
 * (provider), transport (driver). Same layout, validation, and toggle/
 * delete behaviour as the original host-only version; the difference is
 * the `kind` prop which:
 *
 *   • filters `listMine()` to coupons that belong to this kind (either
 *     scoped to a listing of this kind, or stamped with `category=kind`,
 *     or a legacy null-category coupon whose listingId matches one of
 *     the dashboard's listings),
 *   • drives the "All your stays / services / transports" copy in the
 *     Applies-to dropdown,
 *   • is sent to the backend on create so the server can stamp the
 *     category column and the consume gate later rejects bookings of
 *     any other kind.
 */
import { useMemo, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, ToggleLeft, ToggleRight, Ticket, Loader2, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  getCouponsService,
  type Coupon,
  type CreateCouponPayload,
  type CouponDiscountType,
  type CouponCategory,
} from "@/domains/coupons/coupons.service";
import type { Listing } from "@/types/domain";

interface Props {
  /** Listings owned by the current user that belong to this dashboard's
   *  kind. Drives the "Applies to" dropdown AND the coupon-list filter
   *  for legacy (null-category) rows. */
  listings: Listing[];
  /** Which dashboard this tab is rendered from. */
  kind: CouponCategory;
}

/** Human-readable label for the catch-all option + empty-list copy. */
const kindLabel: Record<CouponCategory, { all: string; singular: string; plural: string }> = {
  stay:      { all: "All your stays",      singular: "stay",     plural: "stays" },
  service:   { all: "All your services",   singular: "service",  plural: "services" },
  transport: { all: "All your transports", singular: "transport", plural: "transports" },
};

const PartnerCouponsTab = ({ listings, kind }: Props) => {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const couponsService = getCouponsService();
  const labels = kindLabel[kind];
  // Translated "All your <kind>" catch-all label, keyed by dashboard kind.
  const allLabel = t(`partnerCoupons.all_${kind}`, { defaultValue: labels.all });

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<{
    code: string;
    listingId: string;
    discountType: CouponDiscountType;
    discountValue: string;
    maxUses: string;
    validUntil: string;
  }>({
    code: "",
    listingId: "",
    discountType: "percent",
    discountValue: "",
    maxUses: "",
    validUntil: "",
  });

  const { data: allCoupons = [], isLoading } = useQuery({
    // Server-side scope this query to the current dashboard kind so stays /
    // services / transport stop cross-polluting each other's coupons list.
    // The category="stay" cache is keyed separately so the host dashboard
    // doesn't share it.
    queryKey: ["my-coupons", kind],
    queryFn: async () => {
      const res = await couponsService.listMine(kind);
      if (!res.success || !res.data) throw new Error(res.error || t("partnerCoupons.errLoad", { defaultValue: "Failed to load coupons" }));
      return res.data;
    },
  });

  // Scope: only coupons that belong to this dashboard's kind. New rows
  // carry `category`; legacy rows (null category) only show up if their
  // `listingId` matches one of the listings we own in this kind. A
  // legacy null/null row (host-wide, pre-migration) is shown ONLY on
  // the stay dashboard — that matches the pre-existing UX where hosts
  // were the only ones with coupons.
  const ownedIds = useMemo(() => new Set(listings.map((l) => l.id)), [listings]);
  const coupons = useMemo(() => {
    return allCoupons.filter((c) => {
      if (c.category) return c.category === kind;
      if (c.listingId) return ownedIds.has(c.listingId);
      return kind === "stay";
    });
  }, [allCoupons, ownedIds, kind]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const value = Number(form.discountValue);
      if (!form.code.trim()) throw new Error(t("partnerCoupons.errEnterCode", { defaultValue: "Enter a coupon code" }));
      if (!Number.isFinite(value) || value <= 0) throw new Error(t("partnerCoupons.errValidAmount", { defaultValue: "Enter a valid discount amount" }));
      if (form.discountType === "percent" && value > 100) throw new Error(t("partnerCoupons.errPercentMax", { defaultValue: "Percent discount can't exceed 100" }));
      const payload: CreateCouponPayload = {
        code: form.code.trim().toUpperCase(),
        discountType: form.discountType,
        discountValue: value,
        listingId: form.listingId || null,
        // Always stamp the dashboard's kind so the server can scope the
        // coupon even when listingId is null. The server re-derives from
        // the listing when one is provided — this is purely the safety
        // net for the catch-all case.
        category: kind,
        maxUses: form.maxUses ? Number(form.maxUses) : null,
        validUntil: form.validUntil ? new Date(form.validUntil).toISOString() : null,
      };
      const res = await couponsService.create(payload);
      if (!res.success || !res.data) throw new Error(res.error || t("partnerCoupons.errCreate", { defaultValue: "Failed to create coupon" }));
      return res.data;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["my-coupons"] });
      toast.success(t("partnerCoupons.toastCreated", { defaultValue: "Coupon created" }));
      setForm({ code: "", listingId: "", discountType: "percent", discountValue: "", maxUses: "", validUntil: "" });
      setShowCreate(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: async (c: Coupon) => {
      const res = await couponsService.setActive(c.id, !c.isActive);
      if (!res.success) throw new Error(res.error || t("partnerCoupons.errUpdate", { defaultValue: "Failed to update coupon" }));
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["my-coupons"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await couponsService.remove(id);
      if (!res.success) throw new Error(res.error || t("partnerCoupons.errDelete", { defaultValue: "Failed to delete coupon" }));
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["my-coupons"] });
      toast.success(t("partnerCoupons.toastDeleted", { defaultValue: "Coupon deleted" }));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleCopy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(t("partnerCoupons.toastCopied", { defaultValue: "{{code}} copied", code }));
    } catch {
      toast.error(t("partnerCoupons.errCopy", { defaultValue: "Copy failed" }));
    }
  };

  const listingName = (id: string | null) => {
    if (!id) return allLabel;
    const l = listings.find((x) => x.id === id);
    return l ? l.name : t("partnerCoupons.unknownListing", { defaultValue: "Unknown listing" });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display font-semibold text-lg">{t("host.coupons.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("host.coupons.subtitle")}</p>
        </div>
        <Button className="rounded-full shadow-md shadow-primary/20" onClick={() => setShowCreate((s) => !s)}>
          <Plus className="w-4 h-4 mr-1" />{t("host.coupons.newCoupon")}
        </Button>
      </div>

      {showCreate && (
        <div className="bg-card rounded-2xl border border-border p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium block mb-1.5">{t("partnerCoupons.fieldCode", { defaultValue: "Code *" })}</label>
              <input
                type="text"
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                placeholder={t("partnerCoupons.placeholderCode", { defaultValue: "e.g. WELCOME10" })}
                className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background uppercase focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1.5">{t("partnerCoupons.fieldAppliesTo", { defaultValue: "Applies to" })}</label>
              <select
                value={form.listingId}
                onChange={(e) => setForm((f) => ({ ...f, listingId: e.target.value }))}
                className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background"
              >
                <option value="">{allLabel}</option>
                {listings.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium block mb-1.5">{t("partnerCoupons.fieldDiscountType", { defaultValue: "Discount type" })}</label>
              <select
                value={form.discountType}
                onChange={(e) => setForm((f) => ({ ...f, discountType: e.target.value as CouponDiscountType }))}
                className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background"
              >
                <option value="percent">{t("partnerCoupons.optPercentOff", { defaultValue: "Percent off (%)" })}</option>
                <option value="fixed">{t("partnerCoupons.optFlatOff", { defaultValue: "Flat amount off (₹)" })}</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium block mb-1.5">
                {form.discountType === "percent" ? t("partnerCoupons.fieldPercentOff", { defaultValue: "Percent off *" }) : t("partnerCoupons.fieldAmountOff", { defaultValue: "Amount off (₹) *" })}
              </label>
              <input
                type="number"
                min={1}
                max={form.discountType === "percent" ? 100 : undefined}
                value={form.discountValue}
                onChange={(e) => setForm((f) => ({ ...f, discountValue: e.target.value }))}
                placeholder={form.discountType === "percent" ? "10" : "500"}
                className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1.5">{t("partnerCoupons.fieldMaxUses", { defaultValue: "Max uses (optional)" })}</label>
              <input
                type="number"
                min={1}
                value={form.maxUses}
                onChange={(e) => setForm((f) => ({ ...f, maxUses: e.target.value }))}
                placeholder={t("partnerCoupons.placeholderUnlimited", { defaultValue: "unlimited" })}
                className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1.5">{t("partnerCoupons.fieldValidUntil", { defaultValue: "Valid until (optional)" })}</label>
              <input
                type="date"
                value={form.validUntil}
                onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))}
                className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
          </div>
          <div className="flex gap-3 justify-end">
            <Button variant="outline" className="rounded-xl" onClick={() => setShowCreate(false)} disabled={createMutation.isPending}>{t("partnerCoupons.cancel", { defaultValue: "Cancel" })}</Button>
            <Button className="rounded-xl" onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
              {createMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("partnerCoupons.creating", { defaultValue: "Creating..." })}</> : t("partnerCoupons.createCoupon", { defaultValue: "Create Coupon" })}
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="py-10 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" /></div>
      ) : coupons.length === 0 ? (
        <div className="bg-card rounded-2xl border border-border p-10 text-center">
          <Ticket className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
          <h3 className="font-display font-semibold text-lg mb-2">{t("host.coupons.empty.title")}</h3>
          <p className="text-sm text-muted-foreground mb-4">{t("host.coupons.empty.desc")}</p>
          <Button className="rounded-xl" onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-1" />{t("host.coupons.empty.createBtn")}</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {coupons.map((c) => {
            const exhausted = c.maxUses !== null && c.usesCount >= c.maxUses;
            const expired = c.validUntil && new Date(c.validUntil) < new Date();
            return (
              <div key={c.id} className="bg-card rounded-2xl border border-border p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${c.isActive && !exhausted && !expired ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                    <Ticket className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-bold text-base">{c.code}</span>
                      <button onClick={() => handleCopy(c.code)} className="text-muted-foreground hover:text-foreground" aria-label={t("partnerCoupons.copyCode", { defaultValue: "Copy code" })}><Copy className="w-3.5 h-3.5" /></button>
                      {!c.isActive && <span className="text-[10px] px-1.5 py-0.5 bg-muted text-muted-foreground rounded-full">{t("host.coupons.paused")}</span>}
                      {exhausted && <span className="text-[10px] px-1.5 py-0.5 bg-destructive/10 text-destructive rounded-full">{t("host.coupons.usedUp")}</span>}
                      {expired && <span className="text-[10px] px-1.5 py-0.5 bg-destructive/10 text-destructive rounded-full">{t("host.coupons.expired")}</span>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {c.discountType === "percent" ? t("host.coupons.percentOff", { value: c.discountValue }) : t("host.coupons.flatOff", { value: c.discountValue })} · {listingName(c.listingId)}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {c.maxUses !== null ? t("host.coupons.usedOf", { count: c.usesCount, max: c.maxUses }) : t("host.coupons.used", { count: c.usesCount })}
                      {(c.redeemedPaise ?? 0) > 0 ? ` · ${t("host.coupons.discountGiven", { defaultValue: "₹{{amount}} in discounts given", amount: Math.round((c.redeemedPaise ?? 0) / 100).toLocaleString("en-IN") })}` : ""}
                      {c.validUntil ? ` · ${t("host.coupons.expires", { date: new Date(c.validUntil).toLocaleDateString("en-IN") })}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => toggleMutation.mutate(c)}
                    disabled={toggleMutation.isPending}
                    className="text-primary disabled:opacity-50"
                    aria-label={c.isActive ? t("partnerCoupons.pauseCoupon", { defaultValue: "Pause coupon" }) : t("partnerCoupons.resumeCoupon", { defaultValue: "Resume coupon" })}
                  >
                    {c.isActive ? <ToggleRight className="w-8 h-8" /> : <ToggleLeft className="w-8 h-8 text-muted-foreground" />}
                  </button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full text-destructive hover:text-destructive"
                    onClick={() => {
                      if (confirm(t("partnerCoupons.confirmDelete", { defaultValue: "Delete coupon {{code}}?", code: c.code }))) deleteMutation.mutate(c.id);
                    }}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default PartnerCouponsTab;
