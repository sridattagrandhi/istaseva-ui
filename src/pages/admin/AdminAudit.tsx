import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import {
  adminOps,
  type AdminActionFilters,
  type AuditEventsQuery,
} from "@/domains/admin/admin-ops.service";
import { AdminDateRange, AdminMultiSelect, AdminSelect, PageHeading, Panel, StateNote, useAdminFacetOptions } from "./adminUi";

const PAGE_SIZE = 50;

const inputCls =
  "h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/60";

const TARGET_TYPES = ["", "user", "listing", "booking", "coupon", "payment"] as const;

function ts(value: string) {
  return new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

/** Ops screen: who did what, to which entity, when — plus per-entity timelines. */
export default function AdminAudit() {
  // ── Admin actions (Postgres) ──
  const [draft, setDraft] = useState<AdminActionFilters>({});
  // Listing facets for the vertical/category chips. Only listing-target rows
  // can match these — other actions (user/coupon/payout/fee) drop out while
  // one is active, since they have no listing behind them.
  const { typeOptions, categoryOptions } = useAdminFacetOptions([], draft.types ?? []);
  const [filters, setFilters] = useState<AdminActionFilters>({});
  const [page, setPage] = useState(0);

  const actionsQuery = useQuery({
    queryKey: ["admin-audit-actions", filters, page],
    queryFn: () => adminOps.audit.actions({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
  });

  const applyFilters = () => {
    setPage(0);
    setFilters(draft);
  };

  // ── Entity timeline (DynamoDB) ──
  const [mode, setMode] = useState<"user" | "resource">("user");
  const [timelineDraft, setTimelineDraft] = useState({ userId: "", resource: "booking", resourceId: "" });
  const [timelineQuery, setTimelineQuery] = useState<AuditEventsQuery | null>(null);

  const eventsQuery = useQuery({
    queryKey: ["admin-audit-events", timelineQuery],
    queryFn: () => adminOps.audit.events(timelineQuery as AuditEventsQuery),
    enabled: timelineQuery !== null,
  });

  const loadTimeline = () => {
    if (mode === "user" && timelineDraft.userId.trim()) {
      setTimelineQuery({ userId: timelineDraft.userId.trim() });
    } else if (mode === "resource" && timelineDraft.resource.trim() && timelineDraft.resourceId.trim()) {
      setTimelineQuery({ resource: timelineDraft.resource.trim(), resourceId: timelineDraft.resourceId.trim() });
    }
  };

  const actions = actionsQuery.data?.actions ?? [];
  const total = actionsQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeading title="Audit log" subtitle="Every admin action, plus per-entity event timelines" />

      <div className="space-y-4">
        <Panel title="Admin actions" subtitle="Mutations performed through the ops console">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <AdminSelect ariaLabel="Target type" value={draft.targetType ?? ""}
              onChange={(v) => setDraft((d) => ({ ...d, targetType: v || undefined }))}
              options={TARGET_TYPES.map((t) => ({ value: t, label: t === "" ? "All targets" : t }))} />
            <AdminMultiSelect label="Vertical" ariaLabel="Filter by listing vertical"
              values={draft.types ?? []}
              onChange={(types) => setDraft((d) => ({ ...d, types: types.length ? types : undefined }))}
              options={typeOptions} />
            <AdminMultiSelect label="Category" ariaLabel="Filter by listing category" searchable
              values={draft.categories ?? []}
              onChange={(categories) => setDraft((d) => ({ ...d, categories: categories.length ? categories : undefined }))}
              options={categoryOptions} />
            <input className={inputCls} placeholder="Action (e.g. admin.listing.ban)"
              value={draft.action ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value || undefined }))} />
            <input className={inputCls} placeholder="Actor user id"
              value={draft.actor ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, actor: e.target.value || undefined }))} />
            <input className={inputCls} placeholder="Target id"
              value={draft.targetId ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, targetId: e.target.value || undefined }))} />
            <AdminDateRange ariaLabel="Performed between"
              value={{ from: draft.from, to: draft.to }}
              onChange={(v) => setDraft((d) => ({ ...d, from: v.from, to: v.to }))} />
            <button onClick={applyFilters}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground">
              <Search className="h-3.5 w-3.5" /> Apply
            </button>
          </div>

          {(filters.types?.length || filters.categories?.length) ? (
            <p className="-mt-2 mb-3 text-xs text-muted-foreground">
              Listing filters active — showing only actions on matching listings. Actions with no listing behind
              them (user, coupon, payout, fee-rule) are hidden while these are set.
            </p>
          ) : null}

          {actionsQuery.isLoading ? (
            <StateNote>Loading…</StateNote>
          ) : actionsQuery.error ? (
            <StateNote>Couldn’t load admin actions.</StateNote>
          ) : actions.length === 0 ? (
            <StateNote>No admin actions match these filters yet.</StateNote>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="pb-2 pr-4 font-medium">When</th>
                      <th className="pb-2 pr-4 font-medium">Actor</th>
                      <th className="pb-2 pr-4 font-medium">Action</th>
                      <th className="pb-2 pr-4 font-medium">Target</th>
                      <th className="pb-2 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actions.map((a) => (
                      <tr key={a.id} className="border-t border-border/60 align-top">
                        <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-muted-foreground">{ts(a.created_at)}</td>
                        <td className="py-2 pr-4 font-mono text-xs">{a.actor_user_id}</td>
                        <td className="py-2 pr-4 font-medium">{a.action}</td>
                        <td className="py-2 pr-4">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{a.target_type}</span>{" "}
                          <span className="font-mono text-xs">{a.target_id}</span>
                        </td>
                        <td className="max-w-[16rem] py-2 text-muted-foreground">{a.reason ?? "—"}</td>
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

        <Panel title="Entity timeline" subtitle="Raw audit events for one user or one resource (booking, payment…)">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-border p-0.5">
              {(["user", "resource"] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
                  {m === "user" ? "By user" : "By resource"}
                </button>
              ))}
            </div>
            {mode === "user" ? (
              <input className={`${inputCls} w-72`} placeholder="Firebase user id"
                value={timelineDraft.userId}
                onChange={(e) => setTimelineDraft((d) => ({ ...d, userId: e.target.value }))} />
            ) : (
              <>
                <AdminSelect ariaLabel="Resource" value={timelineDraft.resource}
                  onChange={(v) => setTimelineDraft((d) => ({ ...d, resource: v }))}
                  options={["booking", "payment", "admin"].map((r) => ({ value: r, label: r }))} />
                <input className={`${inputCls} w-72`} placeholder="Resource id (uuid)"
                  value={timelineDraft.resourceId}
                  onChange={(e) => setTimelineDraft((d) => ({ ...d, resourceId: e.target.value }))} />
              </>
            )}
            <button onClick={loadTimeline}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground">
              <Search className="h-3.5 w-3.5" /> Load
            </button>
          </div>

          {timelineQuery === null ? (
            <StateNote>Enter a user id or resource to load its event history.</StateNote>
          ) : eventsQuery.isLoading ? (
            <StateNote>Loading…</StateNote>
          ) : eventsQuery.error ? (
            <StateNote>Couldn’t load events.</StateNote>
          ) : (eventsQuery.data?.events.length ?? 0) === 0 ? (
            <StateNote>No events recorded for this {mode === "user" ? "user" : "resource"}.</StateNote>
          ) : (
            <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
              {eventsQuery.data!.events.map((e, i) => (
                <div key={`${e.timestamp}-${i}`} className="rounded-xl border border-border/60 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{e.action}</span>
                    {e.fromStatus && e.toStatus && (
                      <span className="text-xs text-muted-foreground">{e.fromStatus} → {e.toStatus}</span>
                    )}
                    <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-muted-foreground">{ts(e.timestamp)}</span>
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {e.resource}#{String(e.resourceId)}{e.userId ? ` · user ${e.userId}` : ""}
                  </p>
                  {e.metadata && Object.keys(e.metadata).length > 0 && (
                    <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-muted/60 p-2 text-[11px] leading-snug">
                      {JSON.stringify(e.metadata, null, 2)}
                    </pre>
                  )}
                </div>
              ))}
              {eventsQuery.data!.truncated && (
                <p className="pt-1 text-center text-xs text-muted-foreground">Showing the most recent events only.</p>
              )}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
