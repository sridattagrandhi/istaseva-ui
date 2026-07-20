import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, ShieldOff, ShieldCheck, ExternalLink } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  adminOps,
  type FraudSignalFilters,
  type FraudSignalRow,
} from "@/domains/admin/admin-ops.service";
import { AdminDateRange, AdminSelect, PageHeading, Panel, StateNote } from "./adminUi";

const PAGE_SIZE = 50;

const inputCls =
  "h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/60";

function ts(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function RiskBadge({ level }: { level: FraudSignalRow["risk_level"] }) {
  const tone =
    level === "critical" ? "bg-destructive text-destructive-foreground"
      : level === "high" ? "bg-destructive/15 text-destructive"
        : level === "medium" ? "bg-amber-500/15 text-amber-600"
          : "bg-muted text-muted-foreground";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>{level}</span>;
}

/** Ops screen: fraud signal feed + per-user investigation dossier with suspend action. */
export default function AdminFraud() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<FraudSignalFilters>({});
  const [filters, setFilters] = useState<FraudSignalFilters>({});
  const [page, setPage] = useState(0);
  const [dossierUserId, setDossierUserId] = useState<string | null>(null);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const signalsQuery = useQuery({
    queryKey: ["admin-fraud-signals", filters, page],
    queryFn: () => adminOps.fraud.signals({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
  });

  const eventTypesQuery = useQuery({
    queryKey: ["admin-fraud-event-types"],
    queryFn: () => adminOps.fraud.eventTypes(),
    staleTime: 5 * 60 * 1000,
  });

  const dossierQuery = useQuery({
    queryKey: ["admin-fraud-dossier", dossierUserId],
    queryFn: () => adminOps.fraud.userDossier(dossierUserId as string),
    enabled: dossierUserId !== null,
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-fraud-signals"] });
    queryClient.invalidateQueries({ queryKey: ["admin-fraud-dossier"] });
  };

  const suspendMutation = useMutation({
    mutationFn: ({ userId, reason }: { userId: string; reason: string }) =>
      adminOps.users.suspend(userId, reason),
    onSuccess: () => {
      setSuspendOpen(false);
      setSuspendReason("");
      setActionError(null);
      invalidateAll();
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const unsuspendMutation = useMutation({
    mutationFn: (userId: string) => adminOps.users.unsuspend(userId),
    onSuccess: () => {
      setActionError(null);
      invalidateAll();
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const applyFilters = () => {
    setPage(0);
    setFilters(draft);
  };

  const signals = signalsQuery.data?.signals ?? [];
  const total = signalsQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const dossier = dossierQuery.data;
  const suspended = dossier?.profile?.is_suspended === true;

  return (
    <>
      <PageHeading title="Fraud" subtitle="Signal feed with per-user investigation; suspend accounts or jump to their listings" />

      <Panel title="Fraud signals" subtitle="Live signals mirrored from the fraud pipeline (from console launch onward)">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <AdminSelect ariaLabel="Risk level" value={draft.riskLevel ?? ""}
            onChange={(v) => setDraft((d) => ({ ...d, riskLevel: v || undefined }))}
            options={[
              { value: "", label: "Any risk" },
              ...["critical", "high", "medium", "low"].map((r) => ({ value: r, label: r })),
            ]} />
          <AdminSelect ariaLabel="Event type" value={draft.eventType ?? ""}
            onChange={(v) => setDraft((d) => ({ ...d, eventType: v || undefined }))}
            options={[
              { value: "", label: "Any event type" },
              ...(eventTypesQuery.data?.eventTypes ?? []).map((t) => ({ value: t, label: t })),
            ]} />
          <input className={`${inputCls} w-64`} placeholder="User id"
            value={draft.userId ?? ""}
            onKeyDown={(e) => e.key === "Enter" && applyFilters()}
            onChange={(e) => setDraft((d) => ({ ...d, userId: e.target.value || undefined }))} />
          <AdminDateRange ariaLabel="Seen between"
            value={{ from: draft.from, to: draft.to }}
            onChange={(v) => setDraft((d) => ({ ...d, from: v.from, to: v.to }))} />
          <button onClick={applyFilters}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground">
            <Search className="h-3.5 w-3.5" /> Apply
          </button>
        </div>

        {signalsQuery.isLoading ? (
          <StateNote>Loading…</StateNote>
        ) : signalsQuery.error ? (
          <StateNote>Couldn’t load fraud signals.</StateNote>
        ) : signals.length === 0 ? (
          <StateNote>No fraud signals match these filters.</StateNote>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">When</th>
                    <th className="pb-2 pr-4 font-medium">Risk</th>
                    <th className="pb-2 pr-4 font-medium">Event</th>
                    <th className="pb-2 pr-4 font-medium">User</th>
                    <th className="pb-2 font-medium">Context</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((s) => (
                    <tr key={s.id} onClick={() => setDossierUserId(s.user_id)}
                      className="cursor-pointer border-t border-border/60 align-top transition-colors hover:bg-muted/40">
                      <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-muted-foreground">{ts(s.created_at)}</td>
                      <td className="py-2 pr-4"><RiskBadge level={s.risk_level} /></td>
                      <td className="py-2 pr-4 font-medium">{s.event_type}</td>
                      <td className="py-2 pr-4">
                        <p>{s.user_name ?? "—"}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">{s.user_email ?? s.user_id}</p>
                        {s.user_suspended && <span className="text-xs font-semibold text-destructive">suspended</span>}
                      </td>
                      <td className="max-w-[16rem] py-2 text-xs text-muted-foreground">
                        {s.ip_address && <span>ip {s.ip_address} · </span>}
                        {s.device_id && <span>device {s.device_id.slice(0, 12)} · </span>}
                        {Object.keys(s.metadata ?? {}).length > 0 && (
                          <span className="font-mono">{JSON.stringify(s.metadata).slice(0, 80)}</span>
                        )}
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

      {/* ── User dossier ── */}
      <Dialog open={dossierUserId !== null} onOpenChange={(open) => { if (!open) { setDossierUserId(null); setActionError(null); } }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{dossier?.profile?.display_name ?? "User investigation"}</DialogTitle>
            <DialogDescription className="font-mono text-xs">{dossierUserId}</DialogDescription>
          </DialogHeader>

          {dossierQuery.isLoading ? (
            <StateNote>Loading…</StateNote>
          ) : dossierQuery.error || !dossier ? (
            <StateNote>Couldn’t load this user.</StateNote>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {suspended ? (
                  <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-semibold text-destructive">
                    Suspended{dossier.profile?.suspension_reason ? ` — ${dossier.profile.suspension_reason}` : ""}
                  </span>
                ) : (
                  <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-600">Active</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {dossier.profile?.email ?? "no email"} · {dossier.profile?.phone ?? "no phone"} · KYC {dossier.profile?.verification_status ?? "unknown"}
                </span>
                <div className="ml-auto flex gap-2">
                  {suspended ? (
                    <button onClick={() => dossierUserId && unsuspendMutation.mutate(dossierUserId)}
                      disabled={unsuspendMutation.isPending}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold hover:bg-muted/60 disabled:opacity-50">
                      <ShieldCheck className="h-3.5 w-3.5" /> Unsuspend
                    </button>
                  ) : (
                    <button onClick={() => { setSuspendOpen(true); setSuspendReason(""); }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/30 px-2.5 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10">
                      <ShieldOff className="h-3.5 w-3.5" /> Suspend user
                    </button>
                  )}
                </div>
              </div>

              {actionError && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</p>
              )}

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Object.entries(dossier.bookingStats).map(([status, count]) => (
                  <div key={status} className="rounded-xl border border-border/60 p-2.5 text-center">
                    <p className="text-lg font-bold tabular-nums">{count}</p>
                    <p className="text-xs capitalize text-muted-foreground">{status.replace("_", " ")} bookings</p>
                  </div>
                ))}
                {Object.keys(dossier.bookingStats).length === 0 && (
                  <p className="col-span-full text-xs text-muted-foreground">No bookings.</p>
                )}
              </div>

              <div>
                <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                  Fraud signals ({dossier.signalsTotal})
                </p>
                {dossier.signals.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None recorded.</p>
                ) : (
                  <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
                    {dossier.signals.map((s) => (
                      <div key={s.id} className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs">
                        <RiskBadge level={s.risk_level} />
                        <span className="font-medium">{s.event_type}</span>
                        <span className="ml-auto whitespace-nowrap tabular-nums text-muted-foreground">{ts(s.created_at)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                  Safety alerts ({dossier.safetyAlerts.length})
                </p>
                {dossier.safetyAlerts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None.</p>
                ) : (
                  <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
                    {dossier.safetyAlerts.map((a) => (
                      <div key={a.id} className="rounded-lg border border-border/60 px-2.5 py-1.5 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{a.alert_type}</span>
                          <span className={`rounded-full px-1.5 py-0.5 font-semibold ${a.status === "open" ? "bg-amber-500/15 text-amber-600" : "bg-muted text-muted-foreground"}`}>{a.status}</span>
                          <span className="ml-auto tabular-nums text-muted-foreground">{ts(a.created_at)}</span>
                        </div>
                        {a.description && <p className="mt-0.5 text-muted-foreground">{a.description}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {dossier.listings.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                    Listings hosted ({dossier.listings.length})
                  </p>
                  <div className="space-y-1.5">
                    {dossier.listings.map((l) => (
                      <div key={l.id} className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs">
                        <span className="font-medium">{l.name ?? l.title ?? "Untitled"}</span>
                        <span className="capitalize text-muted-foreground">{l.listing_type}</span>
                        {l.banned_at && <span className="font-semibold text-destructive">banned</span>}
                        <Link to={`/admin/listings`} className="ml-auto inline-flex items-center gap-1 text-primary hover:underline">
                          manage <ExternalLink className="h-3 w-3" />
                        </Link>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Recent bookings: {dossier.recentBookings.length} —{" "}
                <Link to="/admin/bookings" className="text-primary hover:underline">open the bookings screen</Link>{" "}
                and search this user id for full history.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Suspend dialog ── */}
      <Dialog open={suspendOpen} onOpenChange={setSuspendOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Suspend user</DialogTitle>
            <DialogDescription>
              Suspension blocks sign-in and all API access immediately, and hides every listing they host.
              Recorded in the audit log. A reason is required.
            </DialogDescription>
          </DialogHeader>
          <textarea
            className="min-h-24 w-full rounded-lg border border-border bg-background p-3 text-sm outline-none focus:border-primary/60"
            placeholder="Reason (e.g. repeated critical fraud signals on payment attempts)"
            value={suspendReason}
            onChange={(e) => setSuspendReason(e.target.value)}
          />
          <DialogFooter>
            <button onClick={() => setSuspendOpen(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-semibold">Cancel</button>
            <button
              disabled={!suspendReason.trim() || suspendMutation.isPending}
              onClick={() => dossierUserId && suspendMutation.mutate({ userId: dossierUserId, reason: suspendReason.trim() })}
              className="rounded-lg bg-destructive px-3 py-1.5 text-sm font-semibold text-destructive-foreground disabled:opacity-50">
              {suspendMutation.isPending ? "Suspending…" : "Suspend user"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
