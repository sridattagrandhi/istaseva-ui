import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Power, Calendar as CalendarIcon, X } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  adminOps,
  type AdminCouponRow,
  type AdminUserRow,
  type CreatePlatformCouponInput,
} from "@/domains/admin/admin-ops.service";
import { AdminSelect, PageHeading, Panel, StateNote } from "./adminUi";

const PAGE_SIZE = 50;

const inputCls =
  "h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/60";

/** Trailing-edge debounce so the search-as-you-type pickers don't fire a
 *  request per keystroke. */
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

function ts(value: string | null | undefined) {
  return value ? new Date(value).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—";
}

function discountLabel(c: AdminCouponRow) {
  return c.discount_type === "percent" ? `${Number(c.discount_value)}% off` : `₹${Number(c.discount_value)} off`;
}

/**
 * Every restriction, spelled out — a coupon can be narrowed on THREE axes at
 * once (category, one listing, specific users) and hiding any of them is how
 * "the user couldn't redeem it" support tickets happen.
 */
function scopeParts(c: AdminCouponRow): string[] {
  const parts: string[] = [];
  if (!c.is_platform) parts.push("host's own listings");
  parts.push(c.category ? `${c.category}s only` : "all categories");
  if (c.listing_id) parts.push(`only “${c.listing_name ?? "one listing"}”`);
  if (c.target_user_count > 0) {
    parts.push(`only ${c.target_user_count} specific user${c.target_user_count > 1 ? "s" : ""}`);
  }
  return parts;
}

function scopeLabel(c: AdminCouponRow) {
  return scopeParts(c).join(" · ");
}

const EMPTY_FORM: CreatePlatformCouponInput & { maxUsesText: string } = {
  code: "",
  discountType: "percent",
  discountValue: 10,
  maxUsesText: "",
};

/** Ops screen: all coupons (host + platform) with redemptions; create platform coupons. */
export default function AdminCoupons() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<{ q?: string; scope?: "platform" | "host"; active?: "true" | "false" }>({});
  const [filters, setFilters] = useState(draft);
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [actionError, setActionError] = useState<string | null>(null);

  // ── Create-dialog pickers ──
  const [listingQuery, setListingQuery] = useState("");
  const [pickedListing, setPickedListing] = useState<{ id: string; name: string } | null>(null);
  const [audience, setAudience] = useState<"everyone" | "specific">("everyone");
  const [userQuery, setUserQuery] = useState("");
  const [pickedUsers, setPickedUsers] = useState<AdminUserRow[]>([]);
  const [validUntilOpen, setValidUntilOpen] = useState(false);

  const debouncedListingQuery = useDebounced(listingQuery);
  const debouncedUserQuery = useDebounced(userQuery);

  const listingSearch = useQuery({
    queryKey: ["admin-coupon-listing-search", debouncedListingQuery],
    queryFn: () => adminOps.listings.search({ q: debouncedListingQuery, state: "live", limit: 8 }),
    enabled: createOpen && debouncedListingQuery.trim().length > 1 && !pickedListing,
  });

  const userSearch = useQuery({
    queryKey: ["admin-coupon-user-search", debouncedUserQuery],
    queryFn: () => adminOps.users.search(debouncedUserQuery.trim(), 8),
    enabled: createOpen && audience === "specific" && debouncedUserQuery.trim().length > 1,
  });

  const resetCreateForm = () => {
    setForm(EMPTY_FORM);
    setListingQuery("");
    setPickedListing(null);
    setAudience("everyone");
    setUserQuery("");
    setPickedUsers([]);
  };

  const couponsQuery = useQuery({
    queryKey: ["admin-coupons", filters, page],
    queryFn: () => adminOps.coupons.list({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
  });

  const detailQuery = useQuery({
    queryKey: ["admin-coupon-detail", detailId],
    queryFn: () => adminOps.coupons.detail(detailId as string),
    enabled: detailId !== null,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-coupons"] });
    queryClient.invalidateQueries({ queryKey: ["admin-coupon-detail"] });
  };

  const createMutation = useMutation({
    mutationFn: (input: CreatePlatformCouponInput) => adminOps.coupons.create(input),
    onSuccess: () => {
      setCreateOpen(false);
      resetCreateForm();
      setActionError(null);
      invalidate();
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      adminOps.coupons.setActive(id, isActive),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const applyFilters = () => {
    setPage(0);
    setFilters(draft);
  };

  const submitCreate = () => {
    const maxUses = form.maxUsesText.trim() ? Number(form.maxUsesText) : null;
    createMutation.mutate({
      code: form.code.trim().toUpperCase(),
      discountType: form.discountType,
      discountValue: Number(form.discountValue),
      maxUses: Number.isFinite(maxUses as number) && (maxUses as number) > 0 ? maxUses : null,
      validFrom: form.validFrom || null,
      validUntil: form.validUntil || null,
      listingId: pickedListing?.id ?? null,
      category: form.category || null,
      userIds: audience === "specific" ? pickedUsers.map((u) => u.user_id) : [],
    });
  };

  const coupons = couponsQuery.data?.coupons ?? [];
  const total = couponsQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const detail = detailQuery.data;

  return (
    <>
      <PageHeading title="Coupons" subtitle="Every coupon on the platform — create platform-wide offers, moderate host codes" />

      <Panel title="All coupons" subtitle="Host coupons stay host-managed; platform coupons are admin-only">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input className={`${inputCls} w-48`} placeholder="Code"
            value={draft.q ?? ""}
            onKeyDown={(e) => e.key === "Enter" && applyFilters()}
            onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value || undefined }))} />
          <AdminSelect ariaLabel="Scope" value={draft.scope ?? ""}
            onChange={(v) => setDraft((d) => ({ ...d, scope: (v || undefined) as "platform" | "host" | undefined }))}
            options={[
              { value: "", label: "All scopes" },
              { value: "platform", label: "Platform" },
              { value: "host", label: "Host" },
            ]} />
          <AdminSelect ariaLabel="Active" value={draft.active ?? ""}
            onChange={(v) => setDraft((d) => ({ ...d, active: (v || undefined) as "true" | "false" | undefined }))}
            options={[
              { value: "", label: "Any state" },
              { value: "true", label: "Active" },
              { value: "false", label: "Inactive" },
            ]} />
          <button onClick={applyFilters}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground">
            <Search className="h-3.5 w-3.5" /> Apply
          </button>
          <button onClick={() => { setCreateOpen(true); resetCreateForm(); setActionError(null); }}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 text-sm font-semibold text-primary">
            <Plus className="h-3.5 w-3.5" /> New platform coupon
          </button>
        </div>

        {actionError && !createOpen && (
          <p className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</p>
        )}

        {couponsQuery.isLoading ? (
          <StateNote>Loading…</StateNote>
        ) : couponsQuery.error ? (
          <StateNote>Couldn’t load coupons.</StateNote>
        ) : coupons.length === 0 ? (
          <StateNote>No coupons match these filters.</StateNote>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">Code</th>
                    <th className="pb-2 pr-4 font-medium">Discount</th>
                    <th className="pb-2 pr-4 font-medium">Scope</th>
                    <th className="pb-2 pr-4 font-medium">Creator</th>
                    <th className="pb-2 pr-4 font-medium">Uses</th>
                    <th className="pb-2 pr-4 font-medium">Redeemed</th>
                    <th className="pb-2 pr-4 font-medium">Valid until</th>
                    <th className="pb-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {coupons.map((c) => (
                    <tr key={c.id} onClick={() => setDetailId(c.id)}
                      className="cursor-pointer border-t border-border/60 align-top transition-colors hover:bg-muted/40">
                      <td className="py-2 pr-4">
                        <span className="font-mono font-semibold">{c.code}</span>
                        <div className="mt-0.5 flex gap-1">
                          {c.is_platform && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">platform</span>}
                          {!c.is_active && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">inactive</span>}
                        </div>
                      </td>
                      <td className="py-2 pr-4">{discountLabel(c)}</td>
                      <td className="py-2 pr-4 capitalize">{scopeLabel(c)}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{c.creator_name ?? c.created_by ?? c.host_user_id ?? "—"}</td>
                      <td className="py-2 pr-4 tabular-nums">{c.uses_count}{c.max_uses ? ` / ${c.max_uses}` : ""}</td>
                      <td className="py-2 pr-4 tabular-nums">{c.redemption_count > 0 ? `${c.redemption_count} · ${rupees(c.redeemed_paise)}` : "—"}</td>
                      <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-muted-foreground">{ts(c.valid_until)}</td>
                      <td className="py-2 text-right">
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleMutation.mutate({ id: c.id, isActive: !c.is_active }); }}
                          disabled={toggleMutation.isPending}
                          title={c.is_active ? "Deactivate" : "Activate"}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold disabled:opacity-50 ${
                            c.is_active ? "border-destructive/30 text-destructive hover:bg-destructive/10" : "border-border hover:bg-muted/60"
                          }`}>
                          <Power className="h-3 w-3" /> {c.is_active ? "Deactivate" : "Activate"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>{total} total · page {page + 1} of {pageCount}</span>
              <div className="flex gap-2">
                <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}
                  className="rounded-lg border border-border px-2.5 py-1 font-medium disabled:opacity-40">Prev</button>
                <button disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}
                  className="rounded-lg border border-border px-2.5 py-1 font-medium disabled:opacity-40">Next</button>
              </div>
            </div>
          </>
        )}
      </Panel>

      {/* ── Detail ── */}
      <Dialog open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-mono">{detail?.coupon.code ?? "Coupon"}</DialogTitle>
            <DialogDescription>
              {detail ? `${discountLabel(detail.coupon)} · ${detail.coupon.is_platform ? "platform" : "host"} coupon` : ""}
            </DialogDescription>
          </DialogHeader>
          {detailQuery.isLoading ? (
            <StateNote>Loading…</StateNote>
          ) : !detail ? (
            <StateNote>Couldn’t load coupon.</StateNote>
          ) : (
            <div className="space-y-4 text-sm">
              {/* Redemption rules spelled out — all three narrowing axes. */}
              <div className="rounded-xl bg-muted/50 p-3">
                <p className="mb-1.5 text-xs font-medium uppercase text-muted-foreground">Applies to</p>
                <div className="space-y-1 text-sm">
                  <p>
                    <span className="text-muted-foreground">Category:</span>{" "}
                    <span className="font-medium capitalize">{detail.coupon.category ? `${detail.coupon.category}s only` : "everything — stays, services & transport"}</span>
                  </p>
                  <p>
                    <span className="text-muted-foreground">Listing:</span>{" "}
                    <span className="font-medium">
                      {detail.coupon.listing_id
                        ? `only “${detail.coupon.listing_name ?? detail.coupon.listing_id}”`
                        : detail.coupon.is_platform ? "any listing" : "any of the host's listings"}
                    </span>
                  </p>
                  <p>
                    <span className="text-muted-foreground">Who can redeem:</span>{" "}
                    <span className="font-medium">
                      {detail.targetUsers.length > 0
                        ? `only the ${detail.targetUsers.length} user${detail.targetUsers.length > 1 ? "s" : ""} below`
                        : "anyone"}
                    </span>
                  </p>
                </div>
              </div>
              {detail.targetUsers.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Targeted users ({detail.targetUsers.length})</p>
                  <div className="max-h-32 space-y-1 overflow-y-auto pr-1">
                    {detail.targetUsers.map((u) => (
                      <p key={u.user_id} className="text-xs">
                        {u.display_name ?? "—"} <span className="text-muted-foreground">{u.email ?? u.user_id}</span>
                      </p>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                  Redemptions ({detail.redemptions.length})
                </p>
                {detail.redemptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Not redeemed yet.</p>
                ) : (
                  <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                    {detail.redemptions.map((r) => (
                      <div key={r.id} className="rounded-lg border border-border/60 px-2.5 py-1.5 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{r.user_name ?? r.user_id}</span>
                          <span className="text-muted-foreground">saved {rupees(r.discount_paise)}</span>
                          {r.booking_status && <span className="rounded bg-muted px-1.5 py-0.5 font-semibold">{r.booking_status}</span>}
                          <span className="ml-auto tabular-nums text-muted-foreground">{ts(r.created_at)}</span>
                        </div>
                        {r.booking_id && <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">booking {r.booking_id}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Create ── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New platform coupon</DialogTitle>
            <DialogDescription>
              Applies across the marketplace. Narrow it to one listing, one category, or specific users — leave everything open for a site-wide offer.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="col-span-1">
              <span className="text-xs font-medium text-muted-foreground">Code</span>
              <input className={`${inputCls} mt-1 w-full font-mono uppercase`} placeholder="LAUNCH10"
                value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
            </label>
            <label className="col-span-1">
              <span className="text-xs font-medium text-muted-foreground">Discount</span>
              <div className="mt-1 flex gap-2">
                <AdminSelect ariaLabel="Discount type" value={form.discountType}
                  onChange={(v) => setForm((f) => ({ ...f, discountType: v as "percent" | "fixed" }))}
                  className="min-w-0 flex-1"
                  options={[
                    { value: "percent", label: "% off" },
                    { value: "fixed", label: "₹ off" },
                  ]} />
                <input type="number" min={1} className={`${inputCls} w-24`} value={form.discountValue}
                  onChange={(e) => setForm((f) => ({ ...f, discountValue: Number(e.target.value) }))} />
              </div>
            </label>
            <label className="col-span-1">
              <span className="text-xs font-medium text-muted-foreground">Category (optional)</span>
              <AdminSelect ariaLabel="Category" value={form.category ?? ""}
                onChange={(v) => setForm((f) => ({ ...f, category: (v || null) as CreatePlatformCouponInput["category"] }))}
                className="mt-1 w-full"
                options={[
                  { value: "", label: "All categories" },
                  { value: "stay", label: "Stays" },
                  { value: "service", label: "Services" },
                  { value: "transport", label: "Transport" },
                ]} />
            </label>
            <div className="col-span-1">
              <span className="text-xs font-medium text-muted-foreground">Listing (optional)</span>
              {pickedListing ? (
                <div className="mt-1 flex h-9 items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 text-sm">
                  <span className="truncate font-medium">{pickedListing.name}</span>
                  <button onClick={() => { setPickedListing(null); setListingQuery(""); }}
                    aria-label="Clear listing" className="ml-auto rounded p-0.5 hover:bg-primary/20">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <input className={`${inputCls} mt-1 w-full`} placeholder="Search name, city, or id…"
                    value={listingQuery} onChange={(e) => setListingQuery(e.target.value)} />
                  {listingQuery.trim().length > 1 && (
                    <div className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-md">
                      {listingSearch.isLoading ? (
                        <p className="px-2.5 py-2 text-xs text-muted-foreground">Searching…</p>
                      ) : (listingSearch.data?.listings.length ?? 0) === 0 ? (
                        <p className="px-2.5 py-2 text-xs text-muted-foreground">No live listings match.</p>
                      ) : (
                        listingSearch.data!.listings.map((l) => (
                          <button key={l.id}
                            onClick={() => { setPickedListing({ id: l.id, name: l.name ?? l.title ?? "Untitled" }); setListingQuery(""); }}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-muted/60">
                            <span className="truncate font-medium">{l.name ?? l.title ?? "Untitled"}</span>
                            <span className="ml-auto shrink-0 text-xs capitalize text-muted-foreground">{l.listing_type} · {l.city ?? ""}</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            <label className="col-span-1">
              <span className="text-xs font-medium text-muted-foreground">Max uses (optional)</span>
              <input type="number" min={1} className={`${inputCls} mt-1 w-full`} placeholder="Unlimited"
                value={form.maxUsesText} onChange={(e) => setForm((f) => ({ ...f, maxUsesText: e.target.value }))} />
            </label>
            <div className="col-span-1">
              <span className="text-xs font-medium text-muted-foreground">Valid until (optional)</span>
              <Popover open={validUntilOpen} onOpenChange={setValidUntilOpen}>
                <PopoverTrigger asChild>
                  <button className={`${inputCls} mt-1 flex w-full items-center gap-2 text-left ${form.validUntil ? "" : "text-muted-foreground"}`}>
                    <CalendarIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    {form.validUntil
                      ? new Date(`${form.validUntil}T00:00:00`).toLocaleDateString("en-IN", { dateStyle: "medium" })
                      : "No expiry"}
                    {form.validUntil && (
                      <span role="button" aria-label="Clear expiry" className="ml-auto rounded p-0.5 hover:bg-muted"
                        onClick={(e) => { e.stopPropagation(); setForm((f) => ({ ...f, validUntil: null })); }}>
                        <X className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={form.validUntil ? new Date(`${form.validUntil}T00:00:00`) : undefined}
                    onSelect={(d) => {
                      setForm((f) => ({
                        ...f,
                        validUntil: d
                          ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
                          : null,
                      }));
                      setValidUntilOpen(false);
                    }}
                    disabled={{ before: new Date() }}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div className="col-span-2">
              <span className="text-xs font-medium text-muted-foreground">Who can redeem</span>
              <div className="mt-1 inline-flex w-full rounded-lg border border-border p-0.5">
                {([["everyone", "Everyone in scope"], ["specific", "Specific users"]] as const).map(([key, label]) => (
                  <button key={key} onClick={() => setAudience(key)}
                    className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                      audience === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
              {audience === "specific" && (
                <div className="mt-2 space-y-2">
                  {pickedUsers.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {pickedUsers.map((u) => (
                        <span key={u.user_id} className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 py-1 pl-2.5 pr-1.5 text-xs font-medium text-primary">
                          {u.display_name || u.email || u.user_id}
                          <button onClick={() => setPickedUsers((list) => list.filter((x) => x.user_id !== u.user_id))}
                            aria-label={`Remove ${u.display_name || u.user_id}`} className="rounded-full p-0.5 hover:bg-primary/20">
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="relative">
                    <input className={`${inputCls} w-full`} placeholder="Search by name, email, phone, or user id…"
                      value={userQuery} onChange={(e) => setUserQuery(e.target.value)} />
                    {userQuery.trim().length > 1 && (
                      <div className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-md">
                        {userSearch.isLoading ? (
                          <p className="px-2.5 py-2 text-xs text-muted-foreground">Searching…</p>
                        ) : (userSearch.data?.users.length ?? 0) === 0 ? (
                          <p className="px-2.5 py-2 text-xs text-muted-foreground">No users match.</p>
                        ) : (
                          userSearch.data!.users
                            .filter((u) => !pickedUsers.some((p) => p.user_id === u.user_id))
                            .map((u) => (
                              <button key={u.user_id}
                                onClick={() => { setPickedUsers((list) => [...list, u]); setUserQuery(""); }}
                                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-muted/60">
                                <span className="font-medium">{u.display_name || "—"}</span>
                                <span className="ml-auto truncate text-xs text-muted-foreground">{u.email ?? u.phone ?? u.user_id}</span>
                              </button>
                            ))
                        )}
                      </div>
                    )}
                  </div>
                  {pickedUsers.length === 0 && (
                    <p className="text-xs text-muted-foreground">Add at least one user, or switch back to “Everyone in scope”.</p>
                  )}
                </div>
              )}
            </div>
          </div>
          {actionError && createOpen && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</p>
          )}
          <DialogFooter>
            <button onClick={() => setCreateOpen(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-semibold">Cancel</button>
            <button
              disabled={!form.code.trim() || !(form.discountValue > 0)
                || (audience === "specific" && pickedUsers.length === 0)
                || createMutation.isPending}
              onClick={submitCreate}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">
              {createMutation.isPending ? "Creating…" : "Create coupon"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
