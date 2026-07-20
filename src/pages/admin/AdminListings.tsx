import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Plus, Search, Trash2, Undo2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  adminOps,
  type AdminListingFilters,
  type AdminListingRow,
} from "@/domains/admin/admin-ops.service";
import {
  AdminDateRange,
  AdminMultiSelect,
  AdminSelect,
  PageHeading,
  Panel,
  StateNote,
  useAdminFacetOptions,
} from "./adminUi";

/** Trailing-edge debounce for the search-as-you-type user picker. */
function useDebounced(value: string, delayMs = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

const PAGE_SIZE = 50;

const inputCls =
  "h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/60";

function ts(value: string) {
  return new Date(value).toLocaleDateString("en-IN", { dateStyle: "medium" });
}

function StatusBadge({ listing }: { listing: AdminListingRow }) {
  if (listing.archived_at) {
    return <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs font-semibold text-foreground/70">Removed</span>;
  }
  if (listing.banned_at) {
    return <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">Suspended</span>;
  }
  if (!listing.is_active) {
    return <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">Inactive</span>;
  }
  return <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-600">Live</span>;
}

/** Ops screen: cross-host listing search + ban/unban (ban ≠ host-controlled is_active). */
export default function AdminListings() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AdminListingFilters>({});
  const [filters, setFilters] = useState<AdminListingFilters>({});
  const [page, setPage] = useState(0);
  // One reason-required dialog serves both moderation verbs: "ban" (policy
  // violation, host sees the reason) and "archive" (takedown/delete — the
  // only removal path on the platform; rows are retained for bookings).
  const [modTarget, setModTarget] = useState<{ row: AdminListingRow; kind: "ban" | "archive" } | null>(null);
  const [modReason, setModReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  // ── Create-for-user picker ──
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const debouncedPickerQuery = useDebounced(pickerQuery);

  const userSearch = useQuery({
    queryKey: ["admin-listing-create-user-search", debouncedPickerQuery],
    queryFn: () => adminOps.users.search(debouncedPickerQuery.trim(), 10),
    enabled: pickerOpen && debouncedPickerQuery.trim().length > 1,
  });

  const listingsQuery = useQuery({
    queryKey: ["admin-listings", filters, page],
    queryFn: () => adminOps.listings.search({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
  });

  const detailQuery = useQuery({
    queryKey: ["admin-listing-detail", detailId],
    queryFn: () => adminOps.listings.detail(detailId as string),
    enabled: detailId !== null,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-listings"] });

  const modMutation = useMutation({
    mutationFn: ({ id, kind, reason }: { id: string; kind: "ban" | "archive"; reason: string }) =>
      kind === "ban" ? adminOps.listings.ban(id, reason) : adminOps.listings.archive(id, reason),
    onSuccess: () => {
      setModTarget(null);
      setModReason("");
      setActionError(null);
      invalidate();
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const unbanMutation = useMutation({
    mutationFn: (id: string) => adminOps.listings.unban(id),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const unarchiveMutation = useMutation({
    mutationFn: (id: string) => adminOps.listings.unarchive(id),
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

  const { stateOptions, cityOptions, typeOptions, categoryOptions } = useAdminFacetOptions(
    draft.states ?? [],
    draft.types ?? []
  );
  const hasAnyFilter = useMemo(
    () => Object.values(draft).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== "")),
    [draft]
  );
  const clearFilters = () => {
    setDraft({});
    setFilters({});
    setPage(0);
  };

  const listings = listingsQuery.data?.listings ?? [];
  const total = listingsQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeading title="Listings" subtitle="Search every listing on the platform; suspend ones that violate policy" />
        <button onClick={() => { setPickerOpen(true); setPickerQuery(""); }}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 text-sm font-semibold text-primary">
          <Plus className="h-3.5 w-3.5" /> Create listing
        </button>
      </div>

      <Panel title="All listings" subtitle="Suspended listings are hidden from search, browse, and booking — the host cannot re-enable them">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input className={`${inputCls} w-64`} placeholder="Name, city, or listing id"
            value={draft.q ?? ""}
            onKeyDown={(e) => e.key === "Enter" && applyFilters()}
            onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value || undefined }))} />
          <AdminSelect ariaLabel="Status" value={draft.state ?? ""}
            onChange={(v) => setDraft((d) => ({ ...d, state: (v || undefined) as AdminListingFilters["state"] }))}
            options={[
              { value: "", label: "Any status" },
              { value: "live", label: "Live" },
              { value: "inactive", label: "Inactive" },
              { value: "banned", label: "Suspended" },
              { value: "archived", label: "Removed" },
            ]} />
          <AdminDateRange ariaLabel="Created between"
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

        {actionError && (
          <p className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</p>
        )}

        {listingsQuery.isLoading ? (
          <StateNote>Loading…</StateNote>
        ) : listingsQuery.error ? (
          <StateNote>Couldn’t load listings.</StateNote>
        ) : listings.length === 0 ? (
          <StateNote>No listings match these filters.</StateNote>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">Listing</th>
                    <th className="pb-2 pr-4 font-medium">Type</th>
                    <th className="pb-2 pr-4 font-medium">City</th>
                    <th className="pb-2 pr-4 font-medium">Host</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Created</th>
                    <th className="pb-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {listings.map((l) => (
                    <tr key={l.id} onClick={() => setDetailId(l.id)}
                      className="cursor-pointer border-t border-border/60 align-top transition-colors hover:bg-muted/40">
                      <td className="max-w-[18rem] py-2 pr-4">
                        <p className="font-medium">{l.name ?? l.title ?? "Untitled"}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">{l.id}</p>
                        {l.banned_at && l.banned_reason && (
                          <p className="mt-0.5 text-xs text-destructive">Reason: {l.banned_reason}</p>
                        )}
                        {l.archived_at && l.archived_reason && (
                          <p className="mt-0.5 text-xs text-muted-foreground">Removed: {l.archived_reason}</p>
                        )}
                      </td>
                      <td className="py-2 pr-4 capitalize">{l.listing_type}</td>
                      <td className="py-2 pr-4">{l.city ?? "—"}</td>
                      <td className="py-2 pr-4">
                        <p>{l.host_name ?? "—"}</p>
                        <p className="text-xs text-muted-foreground">{l.host_email ?? l.user_id}</p>
                        {l.host_suspended && (
                          <span className="text-xs font-semibold text-destructive">host suspended</span>
                        )}
                      </td>
                      <td className="py-2 pr-4"><StatusBadge listing={l} /></td>
                      <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-muted-foreground">{ts(l.created_at)}</td>
                      <td className="py-2 text-right">
                        {l.archived_at ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); unarchiveMutation.mutate(l.id); }}
                            disabled={unarchiveMutation.isPending}
                            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold hover:bg-muted/60 disabled:opacity-50">
                            <Undo2 className="h-3 w-3" /> Restore
                          </button>
                        ) : (
                          <div className="flex justify-end gap-1.5">
                            {l.banned_at ? (
                              <button
                                onClick={(e) => { e.stopPropagation(); unbanMutation.mutate(l.id); }}
                                disabled={unbanMutation.isPending}
                                className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold hover:bg-muted/60 disabled:opacity-50">
                                <Undo2 className="h-3 w-3" /> Unsuspend
                              </button>
                            ) : (
                              <button
                                onClick={(e) => { e.stopPropagation(); setModTarget({ row: l, kind: "ban" }); setModReason(""); }}
                                className="inline-flex items-center gap-1 rounded-lg border border-destructive/30 px-2.5 py-1 text-xs font-semibold text-destructive hover:bg-destructive/10">
                                <Ban className="h-3 w-3" /> Suspend
                              </button>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); setModTarget({ row: l, kind: "archive" }); setModReason(""); }}
                              className="inline-flex items-center gap-1 rounded-lg border border-destructive/30 px-2.5 py-1 text-xs font-semibold text-destructive hover:bg-destructive/10">
                              <Trash2 className="h-3 w-3" /> Delete
                            </button>
                          </div>
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

      {/* ── Create-for-user: target picker ── */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create a listing for a user</DialogTitle>
            <DialogDescription>
              Assisted onboarding — you fill the listing form on their behalf. The user must have an
              account and be KYC-verified; the listing lands as a draft they publish themselves.
            </DialogDescription>
          </DialogHeader>
          <input
            className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/60"
            placeholder="Search by name, email, phone, or user id…"
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
          />
          <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {pickerQuery.trim().length <= 1 ? (
              <StateNote>Type at least 2 characters to search users.</StateNote>
            ) : userSearch.isLoading ? (
              <StateNote>Searching…</StateNote>
            ) : (userSearch.data?.users.length ?? 0) === 0 ? (
              <StateNote>No users match.</StateNote>
            ) : (
              userSearch.data!.users.map((u) => {
                const blocked = u.verification_status !== "verified"
                  ? "KYC not verified"
                  : u.is_suspended ? "suspended" : null;
                return (
                  <button key={u.user_id}
                    disabled={blocked !== null}
                    onClick={() => { setPickerOpen(false); navigate(`/admin/listings/new?user=${encodeURIComponent(u.user_id)}`); }}
                    className="flex w-full items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50">
                    <span className="font-medium">{u.display_name || "—"}</span>
                    <span className="truncate text-xs text-muted-foreground">{u.email ?? u.phone ?? u.user_id}</span>
                    {blocked ? (
                      <span className="ml-auto shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">{blocked}</span>
                    ) : (
                      <span className="ml-auto shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-600">KYC verified</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Read-only listing inspection ── */}
      <Dialog open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {/* Radix a11y: DialogContent must always carry a DialogTitle, so the
              loading/error states render their own header. */}
          {detailQuery.isLoading ? (
            <>
              <DialogHeader><DialogTitle>Listing details</DialogTitle></DialogHeader>
              <StateNote>Loading…</StateNote>
            </>
          ) : detailQuery.error || !detailQuery.data ? (
            <>
              <DialogHeader><DialogTitle>Listing details</DialogTitle></DialogHeader>
              <StateNote>Couldn’t load this listing.</StateNote>
            </>
          ) : (() => {
            const l = detailQuery.data.listing as AdminListingRow & {
              description?: string | null;
              location?: string | null;
              address?: string | null;
              service_area?: string | null;
              price?: string | number | null;
              price_per_night?: number | null;
              max_guests?: number | null;
              bedrooms?: number | null;
              bathrooms?: number | null;
              property_type?: string | null;
              vehicle_name?: string | null;
              vehicle_year?: string | number | null;
              booking_mode?: string | null;
              availability?: string | null;
              photos?: string[];
              image_url?: string | null;
              amenities?: string[];
              room_types?: Array<{ id: string; name: string; base_price_paise?: number; quantity?: number; max_guests?: number | null }>;
            };
            const host = detailQuery.data.host;
            const photos: string[] = Array.isArray(l.photos) && l.photos.length ? l.photos : (l.image_url ? [l.image_url] : []);
            const amenities: string[] = Array.isArray(l.amenities) ? l.amenities : [];
            const rooms = Array.isArray(l.room_types) ? l.room_types : [];
            const Field = ({ label, value }: { label: string; value: unknown }) =>
              value == null || value === "" ? null : (
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">{label}</p>
                  <p className="text-sm">{String(value)}</p>
                </div>
              );
            return (
              <>
                <DialogHeader>
                  <DialogTitle>{l.name ?? l.title ?? "Listing"}</DialogTitle>
                  <DialogDescription className="flex flex-wrap items-center gap-2">
                    <span className="capitalize">{l.listing_type}</span>
                    {l.category && <span>· {l.category}</span>}
                    <StatusBadge listing={l} />
                    <span className="font-mono text-[11px]">{l.id}</span>
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 text-sm">
                  {photos.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {photos.slice(0, 8).map((src, i) => (
                        <img key={i} src={src} alt={`Photo ${i + 1}`}
                          className="h-24 w-32 shrink-0 rounded-lg border border-border/60 object-cover" />
                      ))}
                    </div>
                  )}

                  {l.banned_at && (
                    <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      Suspended {ts(String(l.banned_at))}{l.banned_reason ? ` — ${l.banned_reason}` : ""}
                    </p>
                  )}
                  {l.archived_at && (
                    <p className="rounded-lg bg-foreground/5 px-3 py-2 text-sm text-foreground/70">
                      Removed {ts(String(l.archived_at))}{l.archived_reason ? ` — ${l.archived_reason}` : ""}
                    </p>
                  )}

                  {l.description && <p className="text-muted-foreground">{String(l.description)}</p>}

                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <Field label="City" value={l.city} />
                    <Field label="State" value={l.state} />
                    <Field label="Location" value={l.location} />
                    <Field label="Address" value={l.address} />
                    <Field label="Service area" value={l.service_area} />
                    <Field label="Price" value={l.price ? `₹${l.price}` : null} />
                    <Field label="Price / night" value={l.price_per_night ? `₹${l.price_per_night}` : null} />
                    <Field label="Max guests" value={l.max_guests} />
                    <Field label="Bedrooms" value={l.bedrooms} />
                    <Field label="Bathrooms" value={l.bathrooms} />
                    <Field label="Property type" value={l.property_type} />
                    <Field label="Vehicle" value={l.vehicle_name ? `${l.vehicle_name}${l.vehicle_year ? ` (${l.vehicle_year})` : ""}` : null} />
                    <Field label="Booking mode" value={l.booking_mode} />
                    <Field label="Availability" value={l.availability} />
                    <Field label="Created" value={l.created_at ? ts(String(l.created_at)) : null} />
                    <Field label="Updated" value={l.updated_at ? ts(String(l.updated_at)) : null} />
                  </div>

                  {amenities.length > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Amenities</p>
                      <div className="flex flex-wrap gap-1.5">
                        {amenities.map((a) => (
                          <span key={a} className="rounded-full bg-muted px-2.5 py-0.5 text-xs">{a}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {rooms.length > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Room types</p>
                      <div className="space-y-1.5">
                        {rooms.map((r) => (
                          <div key={String(r.id)} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs">
                            <span className="font-medium">{r.name}</span>
                            <span className="text-muted-foreground">
                              ₹{(Number(r.base_price_paise ?? 0) / 100).toLocaleString("en-IN")}/night
                              · {r.quantity} unit{Number(r.quantity) === 1 ? "" : "s"}
                              {r.max_guests ? ` · sleeps ${r.max_guests}` : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="rounded-xl border border-border/60 p-3">
                    <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                      {l.listing_type === "transport" ? "Driver / owner" : l.listing_type === "service" ? "Provider" : "Host"} contact
                    </p>
                    {host ? (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                        <span className="font-medium">{host.display_name}</span>
                        {host.email && <span className="text-muted-foreground">{host.email}</span>}
                        {host.phone && <span className="tabular-nums text-muted-foreground">{host.phone}</span>}
                        <span className="text-xs text-muted-foreground">KYC {host.verification_status ?? "unknown"}</span>
                        {host.is_suspended && <span className="text-xs font-semibold text-destructive">suspended</span>}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">No profile on record (uid {String(l.user_id)})</p>
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground">Read-only view — use the Suspend action on the list to moderate.</p>
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      <Dialog open={modTarget !== null} onOpenChange={(open) => !open && setModTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{modTarget?.kind === "archive" ? "Delete listing" : "Suspend listing"}</DialogTitle>
            <DialogDescription>
              {modTarget?.kind === "archive" ? (
                <>
                  “{modTarget?.row.name ?? modTarget?.row.title ?? "This listing"}” will be removed from the
                  platform — hidden everywhere, with new bookings blocked. The record is retained for
                  booking/invoice history and can be restored by an admin. A reason is required.
                </>
              ) : (
                <>
                  “{modTarget?.row.name ?? modTarget?.row.title ?? "This listing"}” will be removed from search and browse,
                  and new bookings will be blocked. The host cannot undo this. A reason is required.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <textarea
            className="min-h-24 w-full rounded-lg border border-border bg-background p-3 text-sm outline-none focus:border-primary/60"
            placeholder="Reason (shown in the audit log and to support staff)"
            value={modReason}
            onChange={(e) => setModReason(e.target.value)}
          />
          <DialogFooter>
            <button onClick={() => setModTarget(null)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-semibold">Cancel</button>
            <button
              disabled={!modReason.trim() || modMutation.isPending}
              onClick={() => modTarget && modMutation.mutate({ id: modTarget.row.id, kind: modTarget.kind, reason: modReason.trim() })}
              className="rounded-lg bg-destructive px-3 py-1.5 text-sm font-semibold text-destructive-foreground disabled:opacity-50">
              {modMutation.isPending
                ? (modTarget?.kind === "archive" ? "Deleting…" : "Suspending…")
                : (modTarget?.kind === "archive" ? "Delete listing" : "Suspend listing")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
