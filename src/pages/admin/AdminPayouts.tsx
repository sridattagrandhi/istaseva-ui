import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, IndianRupee, Store } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  adminOps,
  type AdminOwedRow,
  type AdminPartnerBusinessRow,
  type AdminPayoutRow,
} from "@/domains/admin/admin-ops.service";
import { PageHeading, Panel, StateNote, labelizeCategory } from "./adminUi";

const TYPE_LABEL: Record<string, string> = { stay: "Stays", service: "Services", transport: "Transport" };
const TYPE_ORDER = ["stay", "service", "transport"];

const BUSINESS_STATUS: Record<AdminPartnerBusinessRow["status"], { label: string; cls: string }> = {
  live: { label: "Live", cls: "bg-emerald-500/10 text-emerald-600" },
  inactive: { label: "Inactive", cls: "bg-muted text-muted-foreground" },
  suspended: { label: "Suspended", cls: "bg-destructive/10 text-destructive" },
  removed: { label: "Removed", cls: "bg-muted text-muted-foreground" },
};

const inputCls =
  "h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/60";

const rupees = (paise: number | null | undefined) =>
  `₹${(Number(paise ?? 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const ts = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—";

function destinationLabel(p: AdminPayoutRow): string {
  const snap = p.accountSnapshot;
  if (!snap) return p.method;
  if (snap.method === "upi") return snap.upiIdMasked ?? "UPI";
  return [snap.accountNumberMasked, snap.ifsc].filter(Boolean).join(" · ") || "Bank";
}

/**
 * Ops screen: the payouts ledger. Left: partners with payable money
 * (completed + captured + unrefunded bookings not yet covered by a payout).
 * Right/below: history of recorded payouts. Recording is manual for now —
 * the admin moves the money by bank/UPI and records it here; the RazorpayX
 * executor will write the same ledger rows when it lands.
 */
export default function AdminPayouts() {
  const queryClient = useQueryClient();
  const [recordTarget, setRecordTarget] = useState<AdminOwedRow | null>(null);
  const [note, setNote] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  // Click a partner row → informational drill-down: their businesses
  // (listings) grouped by vertical, each with its share of the owed money.
  const [bizTarget, setBizTarget] = useState<AdminOwedRow | null>(null);
  const businessesQuery = useQuery({
    queryKey: ["admin-partner-businesses", bizTarget?.providerUserId],
    queryFn: () => adminOps.payouts.partnerBusinesses(bizTarget!.providerUserId),
    enabled: bizTarget != null,
  });

  const owedQuery = useQuery({
    queryKey: ["admin-payouts-owed"],
    queryFn: () => adminOps.payouts.summary(),
  });
  const ledgerQuery = useQuery({
    queryKey: ["admin-payouts-ledger"],
    queryFn: () => adminOps.payouts.ledger({ limit: 100 }),
  });

  const record = useMutation({
    mutationFn: ({ providerUserId, note }: { providerUserId: string; note?: string }) =>
      adminOps.payouts.record(providerUserId, note),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-payouts-owed"] });
      queryClient.invalidateQueries({ queryKey: ["admin-payouts-ledger"] });
      setRecordTarget(null);
      setNote("");
      setActionError(null);
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const owed = owedQuery.data?.owed ?? [];
  const payouts = ledgerQuery.data?.payouts ?? [];

  return (
    <div className="space-y-6">
      <PageHeading
        title="Payouts"
        subtitle="What each partner is owed (net of commission) and every payout recorded. Money movement is manual for now — record it here after the transfer so bookings can't be paid twice."
      />

      <Panel title="Owed to partners" subtitle="Completed, captured, unrefunded bookings not yet covered by a payout. Amounts are net: subtotal − discount − commission. Click a partner to see their businesses.">
        {owedQuery.isLoading ? (
          <StateNote>Loading…</StateNote>
        ) : owedQuery.isError ? (
          <StateNote>Couldn't load the owed summary.</StateNote>
        ) : owed.length === 0 ? (
          <StateNote>Nothing owed right now — every payable booking is covered by a recorded payout.</StateNote>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3">Partner</th>
                  <th className="py-2 pr-3">Owed</th>
                  <th className="py-2 pr-3">Bookings</th>
                  <th className="py-2 pr-3">Payout account</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {owed.map((o) => (
                  <tr
                    key={o.providerUserId}
                    onClick={() => setBizTarget(o)}
                    className="cursor-pointer border-b border-border/60 hover:bg-muted/40"
                  >
                    <td className="py-2 pr-3">
                      <div className="font-medium">{o.name}</div>
                      {o.email ? <div className="text-xs text-muted-foreground">{o.email}</div> : null}
                    </td>
                    <td className="py-2 pr-3 font-semibold">{rupees(o.pendingPaise)}</td>
                    <td className="py-2 pr-3">{o.bookings}</td>
                    <td className="py-2 pr-3">
                      {o.accountMethod ? (
                        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 uppercase">{o.accountMethod}</span>
                      ) : (
                        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600">not added</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); setActionError(null); setNote(""); setRecordTarget(o); }}
                        disabled={!o.accountMethod}
                        title={o.accountMethod ? "Record a payout covering all payable bookings" : "Partner must add a payout account first (dashboard → Earnings)"}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:border-primary/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <Banknote className="h-3.5 w-3.5" /> Record payout
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Payout history" subtitle="Every recorded payout, newest first. The destination shown is the masked snapshot from payout time.">
        {ledgerQuery.isLoading ? (
          <StateNote>Loading…</StateNote>
        ) : payouts.length === 0 ? (
          <StateNote>No payouts recorded yet.</StateNote>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Partner</th>
                  <th className="py-2 pr-3">Amount</th>
                  <th className="py-2 pr-3">Bookings</th>
                  <th className="py-2 pr-3">Destination</th>
                  <th className="py-2 pr-3">Note</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => (
                  <tr key={p.id} className="border-b border-border/60">
                    <td className="py-2 pr-3 text-muted-foreground">{ts(p.createdAt)}</td>
                    <td className="py-2 pr-3 font-medium">{p.name}</td>
                    <td className="py-2 pr-3 font-semibold">{rupees(p.amountPaise)}</td>
                    <td className="py-2 pr-3">{p.bookings}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{destinationLabel(p)}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{p.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Partner drill-down: their businesses grouped by vertical, each with
          its share of the payable money. Informational — recording stays
          all-or-nothing per partner. */}
      <Dialog open={bizTarget != null} onOpenChange={(open) => { if (!open) setBizTarget(null); }}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{bizTarget?.name}</DialogTitle>
            <DialogDescription>
              Every business this partner runs, with each one's share of the {rupees(bizTarget?.pendingPaise)} owed.
              Payouts are recorded per partner, covering all of them at once.
            </DialogDescription>
          </DialogHeader>

          {businessesQuery.isLoading ? (
            <StateNote>Loading businesses…</StateNote>
          ) : businessesQuery.isError ? (
            <StateNote>Couldn't load this partner's businesses.</StateNote>
          ) : (businessesQuery.data?.businesses.length ?? 0) === 0 ? (
            <StateNote>No listings on this account.</StateNote>
          ) : (
            <div className="space-y-4">
              {TYPE_ORDER.filter((t) => businessesQuery.data!.businesses.some((b) => b.listingType === t)).map((type) => {
                const rows = businessesQuery.data!.businesses.filter((b) => b.listingType === type);
                const typePending = rows.reduce((s, b) => s + b.pendingPaise, 0);
                const typeBookings = rows.reduce((s, b) => s + b.bookings, 0);
                return (
                  <section key={type}>
                    <div className="mb-1.5 flex items-baseline justify-between">
                      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        <Store className="h-3.5 w-3.5" /> {TYPE_LABEL[type] ?? type}
                        <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium normal-case tracking-normal">{rows.length}</span>
                      </h3>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {typePending > 0 ? `${rupees(typePending)} owed · ${typeBookings} booking${typeBookings === 1 ? "" : "s"}` : "nothing owed"}
                      </span>
                    </div>
                    <ul className="divide-y divide-border/60 rounded-lg border border-border">
                      {rows.map((b) => (
                        <li key={b.listingId} className="flex items-center gap-3 px-3 py-2 text-sm">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium">{b.name}</span>
                              {b.status !== "live" && (
                                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${BUSINESS_STATUS[b.status].cls}`}>
                                  {BUSINESS_STATUS[b.status].label}
                                </span>
                              )}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {[b.category ? labelizeCategory(b.category) : null, b.city].filter(Boolean).join(" · ") || "—"}
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="font-semibold tabular-nums">{b.pendingPaise > 0 ? rupees(b.pendingPaise) : "—"}</div>
                            {b.bookings > 0 && (
                              <div className="text-xs text-muted-foreground">{b.bookings} booking{b.bookings === 1 ? "" : "s"}</div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              {bizTarget && (businessesQuery.data?.businesses.reduce((s, b) => s + b.pendingPaise, 0) ?? 0) !== bizTarget.pendingPaise ? (
                <p className="text-xs text-muted-foreground">
                  Note: a small remainder of the owed total may come from older bookings not linked to a listing.
                </p>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={recordTarget != null} onOpenChange={(open) => { if (!open) { setRecordTarget(null); setActionError(null); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record payout</DialogTitle>
            <DialogDescription>
              This marks every currently payable booking for this partner as paid — it can't cover
              a booking twice. Move the money first, then record it here.
            </DialogDescription>
          </DialogHeader>

          {recordTarget ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                <div className="font-medium">{recordTarget.name}</div>
                <div className="text-muted-foreground">
                  {rupees(recordTarget.pendingPaise)} across {recordTarget.bookings} booking{recordTarget.bookings === 1 ? "" : "s"} · via {recordTarget.accountMethod?.toUpperCase()}
                </div>
              </div>
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">Reference / note (optional — UTR number, batch id…)</span>
                <input className={`${inputCls} w-full`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. UTR 4213…" autoFocus />
              </label>
              {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}
            </div>
          ) : null}

          <DialogFooter>
            <button
              onClick={() => { setRecordTarget(null); setActionError(null); }}
              className="inline-flex h-9 items-center rounded-lg border border-border px-4 text-sm hover:bg-muted/60"
            >
              Cancel
            </button>
            <button
              onClick={() => { if (recordTarget) record.mutate({ providerUserId: recordTarget.providerUserId, note: note.trim() || undefined }); }}
              disabled={record.isPending}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <IndianRupee className="h-4 w-4" /> {record.isPending ? "Recording…" : "Record payout"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
