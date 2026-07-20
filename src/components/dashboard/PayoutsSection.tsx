/**
 * Partner-facing payout status + payout account management. Self-contained —
 * dropped into the Earnings tab of all three vertical dashboards (Host /
 * Provider / Transport), it fetches everything it needs:
 *
 *   GET /api/providers/me/payouts        pending (awaiting payout) + history
 *   GET /api/providers/me/payout-account masked active destination
 *   PUT /api/providers/me/payout-account save/replace destination
 *
 * "Pending" = completed, customer-paid, unrefunded bookings not yet covered
 * by a recorded payout; amounts are net of platform commission. Account
 * numbers are masked by the server — the full number is write-only.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Banknote, Landmark, Pencil } from "lucide-react";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";

interface MaskedAccount {
  id: string;
  method: "bank" | "upi";
  accountHolder: string | null;
  accountNumberMasked: string | null;
  ifsc: string | null;
  upiIdMasked: string | null;
}

interface MyPayouts {
  pending: { amountPaise: number; bookings: number };
  hasAccount: boolean;
  /** 1-based history page of 50, most recent first (absent on older servers). */
  page?: number;
  pageSize?: number;
  total?: number;
  payouts: Array<{
    id: string; amountPaise: number; bookings: number; method: string; note: string | null; status: string; createdAt: string;
    /** Masked destination snapshotted at payout time (absent on older servers/rows). */
    destination?: { method: string | null; accountNumberMasked: string | null; upiIdMasked: string | null } | null;
  }>;
}

/** "Sent to A/C •••• 1234" / "Sent to UPI na•••@upi" — from the payout's
 *  masked snapshot; null when the row predates snapshotting. */
function destinationLabel(
  d: { method: string | null; accountNumberMasked: string | null; upiIdMasked: string | null } | null | undefined,
  t: (k: string, o?: Record<string, unknown>) => string,
): string | null {
  if (!d) return null;
  const masked = d.method === "upi" ? d.upiIdMasked : d.accountNumberMasked;
  if (!masked) return null;
  return d.method === "upi"
    ? t("partner.payouts.sentToUpi", { defaultValue: "Sent to UPI {{masked}}", masked })
    : t("partner.payouts.sentToAccount", { defaultValue: "Sent to A/C {{masked}}", masked });
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const ts = (v: string) => new Date(v).toLocaleDateString("en-IN", { dateStyle: "medium" });

const inputCls =
  "h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/60";

/** Shared fetcher so the banner/tile/section all hit one cache entry per page. */
function useMyPayouts(page = 1) {
  return useQuery({
    queryKey: ["my-payouts", page],
    staleTime: 30_000,
    queryFn: async () => {
      const res = await apiRequest<MyPayouts>(`/api/providers/me/payouts?page=${page}`, { headers: getJsonHeaders(false) });
      if (!res.success || !res.data) throw new Error(res.error || "Failed to load payouts");
      return res.data;
    },
  });
}

/**
 * Dashboard-overview nudge: shown only while the partner has NO payout
 * account. Placement (top of the overview tab) is the discoverability fix —
 * a partner who never opens the Payouts tab still learns they must link an
 * account to get paid. Renders nothing while loading, on error, or once an
 * account exists.
 */
export function PayoutNudgeBanner({ onOpen }: { onOpen: () => void }) {
  const { t } = useLanguage();
  const { data } = useMyPayouts();
  if (!data || data.hasAccount) return null;
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <Banknote className="h-5 w-5 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {t("partner.payouts.nudgeTitle", { defaultValue: "Add a bank account or UPI ID to receive payouts" })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("partner.payouts.nudgeBody", { defaultValue: "Your earnings can't be paid out until we know where to send them." })}
        </p>
      </div>
      <button
        onClick={onOpen}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-amber-600 px-3 text-sm font-medium text-white hover:bg-amber-600/90"
      >
        {t("partner.payouts.nudgeCta", { defaultValue: "Add payout account" })}
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * Compact "Awaiting payout" tile for the Earnings tab — the number is
 * earnings-adjacent so partners look for it there, but the management
 * surface lives in the Payouts tab this links to.
 */
export function AwaitingPayoutTile({ onOpen }: { onOpen: () => void }) {
  const { t } = useLanguage();
  const { data } = useMyPayouts();
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary/50"
    >
      <Banknote className="h-5 w-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{t("partner.payouts.pending", { defaultValue: "Awaiting payout" })}</p>
        <p className="text-lg font-semibold">{data ? rupees(data.pending.amountPaise) : "—"}</p>
      </div>
      <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
        {t("partner.payouts.view", { defaultValue: "View payouts" })}
        <ArrowRight className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

/**
 * Standalone "Awaiting payout" / "Last payout" status tiles for the Payment
 * settings tab. Rendered between the payout-account card (PayoutAccountCard)
 * and the earnings statement, each a self-contained card so the sections
 * read as cleanly separated.
 */
export function PayoutStatusTiles() {
  const { t } = useLanguage();
  const { data } = useMyPayouts(1);
  const latest = data?.payouts?.[0];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-2xl border border-border bg-card px-5 py-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("partner.payouts.pending", { defaultValue: "Awaiting payout" })}</p>
        <p className="mt-1 font-display text-2xl font-bold tabular-nums">{data ? rupees(data.pending.amountPaise) : "—"}</p>
        <p className="text-xs text-muted-foreground">
          {data
            ? t("partner.payouts.pendingBookings", { defaultValue: "{{count}} completed bookings", count: data.pending.bookings })
            : ""}
        </p>
      </div>
      <div className="rounded-2xl border border-border bg-card px-5 py-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("partner.payouts.last", { defaultValue: "Last payout" })}</p>
        {latest ? (
          <>
            <p className="mt-1 font-display text-2xl font-bold tabular-nums">{rupees(latest.amountPaise)}</p>
            <p className="text-xs text-muted-foreground">{ts(latest.createdAt)} · {latest.bookings} bookings</p>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">{t("partner.payouts.none", { defaultValue: "No payouts yet" })}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Payout destination account (bank / UPI) — the "Payment settings" card at
 * the TOP of the Payment settings tab. Masked read, write-only full number.
 */
export function PayoutAccountCard() {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [method, setMethod] = useState<"bank" | "upi">("bank");
  const [holder, setHolder] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [upiId, setUpiId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const accountQuery = useQuery({
    queryKey: ["my-payout-account"],
    staleTime: 60_000,
    queryFn: async () => {
      const res = await apiRequest<{ account: MaskedAccount | null }>("/api/providers/me/payout-account", { headers: getJsonHeaders(false) });
      if (!res.success || !res.data) throw new Error(res.error || "Failed to load payout account");
      return res.data.account;
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest<{ account: MaskedAccount }>("/api/providers/me/payout-account", {
        method: "PUT",
        headers: getJsonHeaders(),
        body: JSON.stringify(
          method === "bank"
            ? { method, accountHolder: holder, accountNumber, ifsc }
            : { method, upiId },
        ),
      });
      if (!res.success || !res.data) throw new Error(res.error || "Couldn't save the account");
      return res.data.account;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-payout-account"] });
      queryClient.invalidateQueries({ queryKey: ["my-payouts"] });
      setEditing(false);
      setFormError(null);
      setAccountNumber("");
    },
    onError: (err: Error) => setFormError(err.message),
  });

  const account = accountQuery.data ?? null;

  return (
    <div className="bg-card rounded-2xl border border-border p-5 sm:p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="font-display font-semibold flex items-center gap-2">
            <Banknote className="h-4 w-4 text-primary" />
            {t("partner.payouts.title", { defaultValue: "Payment settings" })}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("partner.payouts.subtitle", { defaultValue: "Net of platform commission. Paid to your account after each payout run." })}
          </p>
        </div>
      </div>

      {/* Payout account */}
      <div className="rounded-xl border border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Landmark className="h-4 w-4 text-muted-foreground" />
            {account ? (
              <div className="text-sm">
                <span className="font-medium uppercase">{account.method}</span>{" "}
                <span className="text-muted-foreground">
                  {account.method === "bank"
                    ? `${account.accountNumberMasked ?? ""} · ${account.ifsc ?? ""}`
                    : account.upiIdMasked}
                </span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("partner.payouts.noAccount", { defaultValue: "Add a bank account or UPI ID to receive payouts." })}
              </p>
            )}
          </div>
          <button
            onClick={() => { setEditing((v) => !v); setFormError(null); if (account) setMethod(account.method); }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:border-primary/60"
          >
            <Pencil className="h-3.5 w-3.5" />
            {account
              ? t("partner.payouts.change", { defaultValue: "Change" })
              : t("partner.payouts.add", { defaultValue: "Add payout account" })}
          </button>
        </div>

        {editing && (
          <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
            <div className="flex gap-2">
              {(["bank", "upi"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMethod(m)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium border ${
                    method === m ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"
                  }`}
                >
                  {m === "bank"
                    ? t("partner.payouts.bank", { defaultValue: "Bank account" })
                    : t("partner.payouts.upi", { defaultValue: "UPI" })}
                </button>
              ))}
            </div>
            {method === "bank" ? (
              <div className="grid gap-2 sm:grid-cols-3">
                <input className={inputCls} placeholder={t("partner.payouts.holder", { defaultValue: "Account holder name" })} value={holder} onChange={(e) => setHolder(e.target.value)} />
                <input className={inputCls} inputMode="numeric" placeholder={t("partner.payouts.number", { defaultValue: "Account number" })} value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} />
                <input className={inputCls} placeholder="IFSC (e.g. HDFC0001234)" value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} />
              </div>
            ) : (
              <input className={`${inputCls} sm:max-w-xs`} placeholder="name@okhdfcbank" value={upiId} onChange={(e) => setUpiId(e.target.value)} />
            )}
            {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
            <div className="flex gap-2">
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {save.isPending
                  ? t("partner.payouts.saving", { defaultValue: "Saving…" })
                  : t("partner.payouts.save", { defaultValue: "Save account" })}
              </button>
              <button
                onClick={() => { setEditing(false); setFormError(null); }}
                className="inline-flex h-9 items-center rounded-lg border border-border px-4 text-sm hover:bg-muted/60"
              >
                {t("common.cancel", { defaultValue: "Cancel" })}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Paginated payout history (50 per page, most recent first) — its own card
 * at the bottom of the Payment settings tab. Renders nothing until at least
 * one payout has been recorded.
 */
export function PayoutHistoryCard() {
  const { t } = useLanguage();
  const [page, setPage] = useState(1);
  const payoutsQuery = useMyPayouts(page);
  const history = payoutsQuery.data?.payouts ?? [];
  const total = payoutsQuery.data?.total ?? history.length;
  const pageSize = payoutsQuery.data?.pageSize ?? 50;
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  if (total <= 0) return null;
  return (
    <div className="bg-card rounded-2xl border border-border p-5 sm:p-6">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="font-display font-semibold">
          {t("partner.payouts.history", { defaultValue: "Payout history" })}
        </h3>
        <p className="text-xs text-muted-foreground tabular-nums">
          {t("partner.payouts.historyCount", { defaultValue: "{{count}} total", count: total })}
        </p>
      </div>
          {payoutsQuery.isLoading ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("partner.payouts.loading", { defaultValue: "Loading…" })}</p>
          ) : history.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("partner.payouts.pageEmpty", { defaultValue: "Nothing on this page." })}</p>
          ) : (
            <ul className="divide-y divide-border/60 text-sm">
              {history.map((p) => {
                const dest = destinationLabel(p.destination, t);
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2">
                    <span className="font-medium">{rupees(p.amountPaise)}</span>
                    <span className="text-muted-foreground">{p.bookings} bookings · {p.method.toUpperCase()}</span>
                    {p.note ? <span className="truncate text-xs text-muted-foreground">{p.note}</span> : null}
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{ts(p.createdAt)}</span>
                    {dest && <span className="w-full text-xs font-medium text-foreground/70">{dest}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {maxPage > 1 && (
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
              <p className="text-xs text-muted-foreground tabular-nums">
                {t("partner.payouts.pageOf", { defaultValue: "Page {{page}} of {{pages}}", page, pages: maxPage })}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || payoutsQuery.isFetching}
                  className="rounded-lg border border-border px-3 py-1 text-xs font-medium hover:border-primary/60 disabled:opacity-40 disabled:hover:border-border"
                >
                  {t("partner.payouts.prevPage", { defaultValue: "Previous" })}
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
                  disabled={page >= maxPage || payoutsQuery.isFetching}
                  className="rounded-lg border border-border px-3 py-1 text-xs font-medium hover:border-primary/60 disabled:opacity-40 disabled:hover:border-border"
                >
                  {t("partner.payouts.nextPage", { defaultValue: "Next" })}
                </button>
              </div>
            </div>
          )}
    </div>
  );
}
