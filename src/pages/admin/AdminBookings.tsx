import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  adminOps,
  type AdminBookingFilters,
  type AdminBookingRow,
  type AdminListingRow,
} from "@/domains/admin/admin-ops.service";
import { HostOnBehalfBookingModal } from "@/redesign/HostOnBehalfBookingModal";
import { ProviderOnBehalfBookingModal } from "@/redesign/ProviderOnBehalfBookingModal";
import { TransportOnBehalfBookingModal } from "@/redesign/TransportOnBehalfBookingModal";
import type { Listing } from "@/types/domain";
import {
  AdminDateRange,
  AdminMultiSelect,
  AdminSelect,
  PageHeading,
  Panel,
  StateNote,
  useAdminFacetOptions,
} from "./adminUi";

/** The on-behalf modals only read {id, name} from the listing rows they get —
 *  full details are fetched by id inside the modal. */
function toModalListing(l: AdminListingRow): Listing {
  return { id: l.id, name: l.name ?? l.title ?? "Untitled" } as unknown as Listing;
}

const PAGE_SIZE = 50;

const inputCls =
  "h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/60";

const STATUSES = ["", "pending", "confirmed", "in_progress", "completed", "cancelled", "expired"];

const rupees = (paise: number | null | undefined) =>
  paise == null ? "—" : `₹${(Number(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

function ts(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "confirmed" || status === "completed"
      ? "bg-emerald-500/10 text-emerald-600"
      : status === "cancelled" || status === "expired"
        ? "bg-destructive/10 text-destructive"
        : "bg-amber-500/10 text-amber-600";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>{status.replace("_", " ")}</span>;
}

/** Ops screen: cross-user booking lookup + admin cancel with policy/full refund. */
export default function AdminBookings() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AdminBookingFilters>({});
  const [filters, setFilters] = useState<AdminBookingFilters>({});
  const [page, setPage] = useState(0);
  const { stateOptions, cityOptions, typeOptions, categoryOptions } = useAdminFacetOptions(
    draft.states ?? [],
    draft.types ?? []
  );
  const [detailId, setDetailId] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [refundMode, setRefundMode] = useState<"policy" | "full">("policy");
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  // ── New booking (admin on-behalf) ──
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerSearch, setPickerSearch] = useState("");
  const [onBehalfListing, setOnBehalfListing] = useState<AdminListingRow | null>(null);

  const pickerResults = useQuery({
    queryKey: ["admin-onbehalf-picker", pickerSearch],
    queryFn: () => adminOps.listings.search({ q: pickerSearch, state: "live", limit: 20 }),
    enabled: pickerOpen && pickerSearch.length > 1,
  });

  const bookingsQuery = useQuery({
    queryKey: ["admin-bookings", filters, page],
    queryFn: () => adminOps.bookings.search({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
  });

  const detailQuery = useQuery({
    queryKey: ["admin-booking-detail", detailId],
    queryFn: () => adminOps.bookings.detail(detailId as string),
    enabled: detailId !== null,
  });

  const cancelMutation = useMutation({
    mutationFn: ({ id, mode, why }: { id: string; mode: "policy" | "full"; why: string }) =>
      adminOps.bookings.cancel(id, { refundMode: mode, reason: why }),
    onSuccess: () => {
      setCancelOpen(false);
      setReason("");
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["admin-bookings"] });
      queryClient.invalidateQueries({ queryKey: ["admin-booking-detail"] });
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const applyFilters = () => {
    setPage(0);
    setFilters(draft);
  };

  const hasAnyFilter = useMemo(
    () => Object.values(draft).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== "")),
    [draft]
  );
  const clearFilters = () => {
    setDraft({});
    setFilters({});
    setPage(0);
  };

  const bookings = bookingsQuery.data?.bookings ?? [];
  const total = bookingsQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const detail = detailQuery.data;
  const cancellable = detail && ["pending", "confirmed", "in_progress"].includes(String(detail.booking.status));

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeading title="Bookings" subtitle="Look up any booking; cancel with a policy or full refund when support needs to step in" />
        <button onClick={() => { setPickerOpen(true); setPickerQuery(""); setPickerSearch(""); }}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 text-sm font-semibold text-primary">
          <Plus className="h-3.5 w-3.5" /> New booking
        </button>
      </div>

      <Panel title="All bookings" subtitle="Search by booking id, guest (uid / email / phone / name), or listing id">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input className={`${inputCls} w-72`} placeholder="Booking id (uuid)"
            value={draft.bookingId ?? ""}
            onKeyDown={(e) => e.key === "Enter" && applyFilters()}
            onChange={(e) => setDraft((d) => ({ ...d, bookingId: e.target.value || undefined }))} />
          <input className={`${inputCls} w-64`} placeholder="Guest uid / email / phone"
            value={draft.user ?? ""}
            onKeyDown={(e) => e.key === "Enter" && applyFilters()}
            onChange={(e) => setDraft((d) => ({ ...d, user: e.target.value || undefined }))} />
          <AdminSelect ariaLabel="Status" value={draft.status ?? ""}
            onChange={(v) => setDraft((d) => ({ ...d, status: v || undefined }))}
            options={STATUSES.map((s) => ({ value: s, label: s === "" ? "Any status" : s.replace("_", " ") }))} />
          <AdminDateRange ariaLabel="Scheduled between"
            value={{ from: draft.from, to: draft.to }}
            onChange={(v) => setDraft((d) => ({ ...d, from: v.from, to: v.to }))} />
          <AdminMultiSelect label="State" values={draft.states ?? []}
            onChange={(v) => setDraft((d) => ({ ...d, states: v.length ? v : undefined }))}
            options={stateOptions} />
          <AdminMultiSelect label="City" searchable values={draft.cities ?? []}
            onChange={(v) => setDraft((d) => ({ ...d, cities: v.length ? v : undefined }))}
            options={cityOptions} />
          <AdminMultiSelect label="Type" values={draft.types ?? []}
            onChange={(v) => setDraft((d) => ({ ...d, types: v.length ? v : undefined }))}
            options={typeOptions} />
          <AdminMultiSelect label="Category" searchable values={draft.categories ?? []}
            onChange={(v) => setDraft((d) => ({ ...d, categories: v.length ? v : undefined }))}
            options={categoryOptions} />
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <input type="checkbox" checked={draft.bookedOnBehalf === "true"}
              onChange={(e) => setDraft((d) => ({ ...d, bookedOnBehalf: e.target.checked ? "true" : undefined }))} />
            On-behalf only
          </label>
          <button onClick={applyFilters}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground">
            <Search className="h-3.5 w-3.5" /> Search
          </button>
          {hasAnyFilter && (
            <button onClick={clearFilters}
              className="inline-flex h-9 items-center rounded-lg px-2.5 text-sm font-medium text-muted-foreground hover:text-foreground">
              Clear
            </button>
          )}
        </div>

        {bookingsQuery.isLoading ? (
          <StateNote>Loading…</StateNote>
        ) : bookingsQuery.error ? (
          <StateNote>Couldn’t load bookings.</StateNote>
        ) : bookings.length === 0 ? (
          <StateNote>No bookings match these filters.</StateNote>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">Booking</th>
                    <th className="pb-2 pr-4 font-medium">Guest</th>
                    <th className="pb-2 pr-4 font-medium">Schedule</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Payment</th>
                    <th className="pb-2 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b: AdminBookingRow) => (
                    <tr key={b.id} onClick={() => setDetailId(b.id)}
                      className="cursor-pointer border-t border-border/60 align-top transition-colors hover:bg-muted/40">
                      <td className="max-w-[16rem] py-2 pr-4">
                        <p className="font-medium">{b.listing_name ?? b.service_category ?? "—"}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">{b.id}</p>
                        {b.booked_on_behalf && (
                          <span className="text-xs font-semibold text-primary">on-behalf</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <p>{b.guest_name ?? b.guest_contact?.name ?? "—"}</p>
                        <p className="text-xs text-muted-foreground">{b.guest_email ?? b.guest_phone ?? b.guest_contact?.phone ?? b.user_id}</p>
                      </td>
                      <td className="whitespace-nowrap py-2 pr-4 tabular-nums">
                        {b.scheduled_date?.slice(0, 10)}{b.end_date && b.end_date !== b.scheduled_date ? ` → ${b.end_date.slice(0, 10)}` : ""}
                      </td>
                      <td className="py-2 pr-4"><StatusBadge status={b.status} /></td>
                      <td className="py-2 pr-4">
                        <p className="tabular-nums">{rupees(b.payment_amount_paise ?? b.agreed_price_paise)}</p>
                        {b.payment_status && <p className="text-xs text-muted-foreground">{b.payment_status.replace("_", " ")}</p>}
                      </td>
                      <td className="whitespace-nowrap py-2 tabular-nums text-muted-foreground">{ts(b.created_at)}</td>
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

      {/* ── Detail drawer ── */}
      <Dialog open={detailId !== null} onOpenChange={(open) => { if (!open) { setDetailId(null); setActionError(null); } }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Booking detail</DialogTitle>
            <DialogDescription className="font-mono text-xs">{detailId}</DialogDescription>
          </DialogHeader>

          {detailQuery.isLoading ? (
            <StateNote>Loading…</StateNote>
          ) : detailQuery.error || !detail ? (
            <StateNote>Couldn’t load booking.</StateNote>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Listing</p>
                  <p className="font-medium">{detail.booking.listing_name ?? detail.booking.service_category ?? "—"}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">{detail.booking.listing_id ?? ""}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Status</p>
                  <StatusBadge status={String(detail.booking.status)} />
                  {detail.booking.cancellation_reason && (
                    <p className="mt-1 text-xs text-muted-foreground">Reason: {detail.booking.cancellation_reason}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Guest</p>
                  <p>{detail.booking.guest_name ?? detail.booking.guest_contact?.name ?? "—"}</p>
                  <p className="text-xs text-muted-foreground">
                    {detail.booking.guest_email ?? detail.booking.guest_phone ?? detail.booking.guest_contact?.phone ?? detail.booking.user_id}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Schedule</p>
                  <p className="tabular-nums">
                    {String(detail.booking.scheduled_date).slice(0, 10)}
                    {detail.booking.end_date ? ` → ${String(detail.booking.end_date).slice(0, 10)}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">{detail.booking.start_time} – {detail.booking.end_time}</p>
                </div>
                {detail.booking.booked_on_behalf && (
                  <div className="col-span-2">
                    <p className="text-xs font-medium uppercase text-muted-foreground">On-behalf</p>
                    <p className="text-xs">Created by <span className="font-mono">{detail.booking.created_by_user_id}</span></p>
                    {detail.booking.payment_link_url && (
                      <a href={String(detail.booking.payment_link_url)} target="_blank" rel="noreferrer"
                        className="text-xs text-primary underline">{String(detail.booking.payment_link_url)}</a>
                    )}
                  </div>
                )}
              </div>

              <div>
                <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Payments</p>
                {detail.payments.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No payment attempts.</p>
                ) : (
                  <div className="space-y-2">
                    {detail.payments.map((p) => (
                      <div key={p.id} className="rounded-xl border border-border/60 p-3">
                        <div className="flex items-center justify-between">
                          <StatusBadge status={p.status} />
                          <span className="font-semibold tabular-nums">{rupees(p.amount_paise)}</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          subtotal {rupees(p.subtotal_paise)} · fee {rupees(p.platform_fee_paise)} · tax {rupees(p.taxes_paise)}
                          {p.insurance_premium_paise ? ` · protect ${rupees(p.insurance_premium_paise)}` : ""}
                          {p.discount_paise ? ` · discount −${rupees(p.discount_paise)}` : ""}
                          {p.refund_paise ? ` · refunded ${rupees(p.refund_paise)}` : ""}
                        </p>
                        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                          {p.provider_payment_id ?? p.provider_ref ?? p.id} · {ts(p.completed_at ?? p.created_at)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {detail.cancelPreview && cancellable && (
                <div className="rounded-xl bg-muted/50 p-3 text-xs">
                  <p className="font-medium">If cancelled now (policy: {detail.cancelPreview.policy})</p>
                  <p className="mt-0.5 text-muted-foreground">
                    Guest refund {rupees(detail.cancelPreview.refundPaise)} · platform keeps {rupees(detail.cancelPreview.platformKeepsPaise)} · host keeps {rupees(detail.cancelPreview.hostKeepsPaise)}
                  </p>
                </div>
              )}

              {actionError && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</p>
              )}

              {cancellable && (
                <div className="flex justify-end">
                  <button onClick={() => { setCancelOpen(true); setRefundMode("policy"); setReason(""); }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-1.5 text-sm font-semibold text-destructive hover:bg-destructive/10">
                    <XCircle className="h-4 w-4" /> Cancel booking…
                  </button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── New booking: listing picker ── */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Book on behalf of a guest</DialogTitle>
            <DialogDescription>
              Pick any live listing — the guest pays via a Razorpay payment link (QR / SMS), exactly like the host flow.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <input className="h-9 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/60"
              placeholder="Search listings by name or city…"
              value={pickerQuery}
              onKeyDown={(e) => e.key === "Enter" && setPickerSearch(pickerQuery.trim())}
              onChange={(e) => setPickerQuery(e.target.value)} />
            <button onClick={() => setPickerSearch(pickerQuery.trim())}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground">
              <Search className="h-3.5 w-3.5" /> Search
            </button>
          </div>
          <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {pickerSearch.length <= 1 ? (
              <StateNote>Type at least 2 characters and search.</StateNote>
            ) : pickerResults.isLoading ? (
              <StateNote>Searching…</StateNote>
            ) : (pickerResults.data?.listings.length ?? 0) === 0 ? (
              <StateNote>No live listings match.</StateNote>
            ) : (
              pickerResults.data!.listings.map((l) => (
                <button key={l.id}
                  onClick={() => { setOnBehalfListing(l); setPickerOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50">
                  <span className="font-medium">{l.name ?? l.title ?? "Untitled"}</span>
                  <span className="capitalize text-xs text-muted-foreground">{l.listing_type}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{l.city ?? ""} · {l.host_name ?? ""}</span>
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── On-behalf modals (reused from the host dashboards, admin endpoint) ── */}
      <HostOnBehalfBookingModal
        open={onBehalfListing?.listing_type === "stay"}
        onOpenChange={(open) => !open && setOnBehalfListing(null)}
        stayListings={onBehalfListing?.listing_type === "stay" ? [toModalListing(onBehalfListing)] : []}
        initialListingId={onBehalfListing?.listing_type === "stay" ? onBehalfListing.id : undefined}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["admin-bookings"] })}
        asAdmin
      />
      <ProviderOnBehalfBookingModal
        open={onBehalfListing?.listing_type === "service"}
        onOpenChange={(open) => !open && setOnBehalfListing(null)}
        serviceListings={onBehalfListing?.listing_type === "service" ? [toModalListing(onBehalfListing)] : []}
        initialListingId={onBehalfListing?.listing_type === "service" ? onBehalfListing.id : undefined}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["admin-bookings"] })}
        asAdmin
      />
      <TransportOnBehalfBookingModal
        open={onBehalfListing?.listing_type === "transport"}
        onOpenChange={(open) => !open && setOnBehalfListing(null)}
        transportListings={onBehalfListing?.listing_type === "transport" ? [toModalListing(onBehalfListing)] : []}
        initialListingId={onBehalfListing?.listing_type === "transport" ? onBehalfListing.id : undefined}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["admin-bookings"] })}
        asAdmin
      />

      {/* ── Cancel dialog ── */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel booking as admin</DialogTitle>
            <DialogDescription>
              Both the guest and the provider are notified that IstaSeva support cancelled this booking.
              This action is recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <label className="flex items-start gap-2 rounded-lg border border-border p-2.5">
              <input type="radio" name="refundMode" className="mt-0.5" checked={refundMode === "policy"}
                onChange={() => setRefundMode("policy")} />
              <span>
                <span className="font-medium">Policy refund</span>
                <span className="block text-xs text-muted-foreground">
                  Standard cancellation math{detail?.cancelPreview ? ` — guest gets ${rupees(detail.cancelPreview.refundPaise)}` : ""}.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 rounded-lg border border-border p-2.5">
              <input type="radio" name="refundMode" className="mt-0.5" checked={refundMode === "full"}
                onChange={() => setRefundMode("full")} />
              <span>
                <span className="font-medium">Full refund</span>
                <span className="block text-xs text-muted-foreground">
                  Everything the guest paid{detail?.cancelPreview?.chargedPaise ? ` (${rupees(detail.cancelPreview.chargedPaise)})` : ""}, including fees and trip protection.
                </span>
              </span>
            </label>
            <textarea
              className="min-h-20 w-full rounded-lg border border-border bg-background p-3 text-sm outline-none focus:border-primary/60"
              placeholder="Reason (required — kept in the audit log)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <button onClick={() => setCancelOpen(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-semibold">Back</button>
            <button
              disabled={!reason.trim() || cancelMutation.isPending}
              onClick={() => detailId && cancelMutation.mutate({ id: detailId, mode: refundMode, why: reason.trim() })}
              className="rounded-lg bg-destructive px-3 py-1.5 text-sm font-semibold text-destructive-foreground disabled:opacity-50">
              {cancelMutation.isPending ? "Cancelling…" : "Cancel booking"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
