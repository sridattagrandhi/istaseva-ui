// Small presentational building blocks shared across the admin dashboard pages.
// The generic metric primitives (Kpi/Panel/formatters/range calendar) moved to
// src/components/dashboard/metric-ui.tsx so the partner dashboards can share
// them — re-exported here so admin pages keep their existing imports.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calendar as CalendarIcon, Check, ChevronDown, Loader2, MapPin, Search, Store, X } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { adminOps } from "@/domains/admin/admin-ops.service";
import { adminFilterActive, type AdminMetricFilter } from "@/domains/analytics/admin-metrics.service";
import { AdminRangeCalendar, ymdLocal } from "@/components/dashboard/metric-ui";

export { fmt, rupees, Kpi, KpiDelta, Panel, PageHeading, StateNote, rate, ymdLocal, AdminRangeCalendar } from "@/components/dashboard/metric-ui";

// ── Date-range filter (ops screens) ──

export interface AdminDateRangeValue {
  from?: string; // YYYY-MM-DD, inclusive
  to?: string;   // YYYY-MM-DD, inclusive
}

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/**
 * "From date → to date" filter for the ops filter bars, using the app's own
 * Calendar (react-day-picker) in range mode — same look as the booking
 * modals' date pickers, sized to sit beside the h-9 inputs/selects.
 */
export function AdminDateRange({
  value,
  onChange,
  ariaLabel,
  className,
}: {
  value: AdminDateRangeValue;
  onChange: (value: AdminDateRangeValue) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected: DateRange | undefined = value.from
    ? { from: new Date(`${value.from}T00:00:00`), to: value.to ? new Date(`${value.to}T00:00:00`) : undefined }
    : undefined;

  const label = value.from
    ? `${shortDate(value.from)} – ${value.to ? shortDate(value.to) : "…"}`
    : "Any dates";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label={ariaLabel}
          className={`inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/60 ${
            value.from ? "" : "text-muted-foreground"
          } ${className ?? ""}`}
        >
          <CalendarIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
          {label}
          {value.from && (
            <span
              role="button"
              aria-label="Clear dates"
              className="-mr-1 rounded p-0.5 hover:bg-muted"
              onClick={(e) => { e.stopPropagation(); onChange({}); }}
            >
              <X className="h-3.5 w-3.5" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <AdminRangeCalendar
          selected={selected}
          onSelect={(range) => {
            onChange({
              from: range?.from ? ymdLocal(range.from) : undefined,
              to: range?.to ? ymdLocal(range.to) : undefined,
            });
            // Keep the popover open until a complete range is picked.
            if (range?.from && range?.to) setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

// Radix SelectItem forbids empty-string values, but the ops filter bars use
// "" for their "Any…" option — map it to a sentinel at this boundary.
const ANY_SENTINEL = "__any__";

/**
 * shadcn/Radix dropdown for the ops screens — matches the app's Select
 * styling (used across booking modals/dashboards) instead of a native
 * <select>, sized to sit beside the h-9 filter inputs.
 */
export function AdminSelect({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <Select value={value === "" ? ANY_SENTINEL : value} onValueChange={(v) => onChange(v === ANY_SENTINEL ? "" : v)}>
      <SelectTrigger aria-label={ariaLabel} className={`h-9 w-auto min-w-[8.5rem] gap-1.5 rounded-lg ${className ?? ""}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value || ANY_SENTINEL} value={o.value === "" ? ANY_SENTINEL : o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Multi-select filters (ops screens) ──

// "home_cleaning" / "home-cleaning" → "Home Cleaning" for the dropdowns;
// the underlying filter value stays the raw DB slug.
export const labelizeCategory = (c: string) => c.replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

// Presentation names for the DB's listing_type values; unknown values fall
// back to a capitalized form of whatever the DB holds.
const TYPE_LABEL: Record<string, string> = { stay: "Stays", service: "Services", transport: "Transport" };
export const labelizeType = (v: string) => TYPE_LABEL[v] ?? labelizeCategory(v);

/**
 * Loads /api/admin/facets once (shared cache key across the ops screens) and
 * shapes it into AdminMultiSelect option lists. Everything is a SELECT
 * DISTINCT over the listings table — nothing hardcoded. Cities narrow to
 * the selected states (duplicate city names across states collapse — the
 * filter matches on the city name only) and categories narrow to the
 * selected listing types.
 */
export function useAdminFacetOptions(selectedStates: string[], selectedTypes: string[] = []) {
  const facetsQuery = useQuery({
    queryKey: ["admin-facets"],
    queryFn: () => adminOps.facets(),
    staleTime: 5 * 60_000,
  });
  const facets = facetsQuery.data;
  return useMemo(() => {
    const stateSet = new Set(selectedStates.map((s) => s.toLowerCase()));
    const cityMap = new Map<string, string>();
    for (const c of facets?.cities ?? []) {
      if (stateSet.size && (!c.state || !stateSet.has(c.state.toLowerCase()))) continue;
      const key = c.city.toLowerCase();
      if (!cityMap.has(key)) cityMap.set(key, c.city);
    }
    const typeSet = new Set(selectedTypes.map((t) => t.toLowerCase()));
    const categoryMap = new Map<string, string>();
    for (const c of facets?.categories ?? []) {
      if (typeSet.size && !typeSet.has(c.type.toLowerCase())) continue;
      const key = c.value.toLowerCase();
      if (!categoryMap.has(key)) categoryMap.set(key, c.value);
    }
    return {
      stateOptions: (facets?.states ?? []).map((s) => ({ value: s, label: s })),
      cityOptions: Array.from(cityMap.values()).map((c) => ({ value: c, label: c })),
      typeOptions: (facets?.types ?? []).map((v) => ({ value: v, label: labelizeType(v) })),
      categoryOptions: Array.from(categoryMap.values()).map((c) => ({ value: c, label: labelizeCategory(c) })),
    };
  }, [facets, selectedStates, selectedTypes]);
}

/**
 * Checkbox multi-select for the ops filter bars. Trigger shows the filter
 * name plus a selected-count pill ("City · 3") and tints primary when
 * active, matching the layout's period-picker button language.
 */
export function AdminMultiSelect({
  label,
  values,
  onChange,
  options,
  searchable = false,
  ariaLabel,
  className,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  options: Array<{ value: string; label: string }>;
  /** Show a search box (for long lists like cities). */
  searchable?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const visible = q.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()))
    : options;
  const toggle = (v: string) =>
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(""); }}>
      <PopoverTrigger asChild>
        <button
          aria-label={ariaLabel ?? label}
          className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm outline-none transition-colors focus:border-primary/60 ${
            values.length
              ? "border-primary/40 bg-primary/10 font-medium text-primary"
              : "border-border bg-background text-muted-foreground hover:text-foreground"
          } ${className ?? ""}`}
        >
          {label}
          {values.length > 0 && (
            <span className="rounded-full bg-primary/15 px-1.5 text-xs font-semibold tabular-nums">{values.length}</span>
          )}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 rounded-2xl p-2">
        {searchable && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-background px-2.5">
            <Search className="h-3.5 w-3.5 shrink-0 opacity-50" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        )}
        <div className="max-h-64 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">No matches.</p>
          ) : (
            visible.map((o) => {
              const active = values.includes(o.value);
              return (
                <button
                  key={o.value}
                  onClick={() => toggle(o.value)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                    active ? "bg-primary/10 font-semibold text-primary" : "text-foreground hover:bg-muted/60"
                  }`}
                >
                  <span className="truncate">{o.label}</span>
                  {active && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              );
            })
          )}
        </div>
        {values.length > 0 && (
          <div className="mt-1 border-t border-border/60 pt-1">
            <button
              onClick={() => onChange([])}
              className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted/60"
            >
              Clear selection
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Listing search picker (query one specific listing) ──

const typeLabelShort: Record<string, string> = { stay: "Stay", service: "Service", transport: "Transport" };

/**
 * Search-as-you-type picker over every listing on the platform (reuses the ops
 * `GET /api/admin/listings?q=` search). Picking one narrows the analytics
 * tiles to that single listing; clearing it removes the constraint.
 */
export function AdminListingSearch({
  listingId,
  listingLabel,
  onPick,
  onClear,
}: {
  listingId: string | null;
  listingLabel: string | null;
  onPick: (id: string, label: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const searchQuery = useQuery({
    queryKey: ["admin-listing-search", debounced],
    queryFn: () => adminOps.listings.search({ q: debounced, limit: 8, offset: 0 }),
    enabled: open && debounced.length >= 2,
    staleTime: 60_000,
  });
  const results = searchQuery.data?.listings ?? [];

  if (listingId) {
    return (
      <span className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 text-sm font-medium text-primary">
        <Store className="h-3.5 w-3.5 shrink-0" />
        <span className="max-w-[12rem] truncate">{listingLabel ?? "Listing"}</span>
        <button aria-label="Clear listing" className="-mr-1 rounded p-0.5 hover:bg-primary/15" onClick={onClear}>
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(""); }}>
      <PopoverTrigger asChild>
        <button
          aria-label="Search a specific listing"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus:border-primary/60"
        >
          <Search className="h-3.5 w-3.5 opacity-60" />
          Find a listing
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 rounded-2xl p-2">
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-background px-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 opacity-50" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, city or id…"
            className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {searchQuery.isFetching && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin opacity-50" />}
        </div>
        <div className="max-h-72 overflow-y-auto">
          {debounced.length < 2 ? (
            <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">Type at least 2 characters.</p>
          ) : searchQuery.isLoading ? (
            <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">No listings match “{debounced}”.</p>
          ) : (
            results.map((l) => {
              const name = l.name || l.title || l.id.slice(0, 8);
              const place = [l.city, l.state].filter(Boolean).join(", ");
              return (
                <button
                  key={l.id}
                  onClick={() => { onPick(l.id, name); setOpen(false); setQ(""); }}
                  className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/60"
                >
                  <Store className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-50" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {typeLabelShort[l.listing_type] ?? l.listing_type}{place ? ` · ${place}` : ""}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Analytics filter bar ──

/**
 * Shared filter bar for the analytics tabs (Overview / Providers / Geographic /
 * Customers): Vertical → Category (narrows to vertical) + State → City (narrows
 * to state) + a single-listing search. Only tiles backed by
 * bookings/listings/payments respond; behavioral tiles carry a
 * <PlatformWide> badge instead.
 */
export function AdminFilterBar({
  filter,
  onChange,
}: {
  filter: AdminMetricFilter;
  onChange: (next: AdminMetricFilter) => void;
}) {
  const { stateOptions, cityOptions, typeOptions, categoryOptions } = useAdminFacetOptions(filter.states, filter.types);
  const active = adminFilterActive(filter);
  const set = (patch: Partial<AdminMetricFilter>) => onChange({ ...filter, ...patch });

  // Keep dependent selections honest: when a vertical/state is dropped, prune
  // any picked category/city that its narrowed list no longer offers, so no
  // "stuck" chip lingers. Guarded on a non-empty option list so an in-flight
  // facet fetch (options briefly []) never wipes a valid selection.
  useEffect(() => {
    const validCats = new Set(categoryOptions.map((o) => o.value.toLowerCase()));
    const validCities = new Set(cityOptions.map((o) => o.value.toLowerCase()));
    const nextCats = categoryOptions.length ? filter.categories.filter((c) => validCats.has(c.toLowerCase())) : filter.categories;
    const nextCities = cityOptions.length ? filter.cities.filter((c) => validCities.has(c.toLowerCase())) : filter.cities;
    if (nextCats.length !== filter.categories.length || nextCities.length !== filter.cities.length) {
      onChange({ ...filter, categories: nextCats, cities: nextCities });
    }
  }, [categoryOptions, cityOptions, filter, onChange]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <AdminMultiSelect
        label="Vertical"
        values={filter.types}
        // Dropping a vertical must also drop categories that belonged only to it.
        onChange={(types) => set({ types })}
        options={typeOptions}
        ariaLabel="Filter by vertical"
      />
      <AdminMultiSelect
        label="Category"
        values={filter.categories}
        onChange={(categories) => set({ categories })}
        options={categoryOptions}
        searchable
        ariaLabel="Filter by category"
      />
      <span className="mx-0.5 hidden h-5 w-px bg-border sm:block" aria-hidden />
      <AdminMultiSelect
        label="State"
        values={filter.states}
        onChange={(states) => set({ states })}
        options={stateOptions}
        searchable
        ariaLabel="Filter by state"
      />
      <AdminMultiSelect
        label="City"
        values={filter.cities}
        onChange={(cities) => set({ cities })}
        options={cityOptions}
        searchable
        ariaLabel="Filter by city"
      />
      <span className="mx-0.5 hidden h-5 w-px bg-border sm:block" aria-hidden />
      <AdminListingSearch
        listingId={filter.listingId}
        listingLabel={filter.listingLabel}
        onPick={(listingId, listingLabel) => set({ listingId, listingLabel })}
        onClear={() => set({ listingId: null, listingLabel: null })}
      />
      {active && (
        <button
          onClick={() => onChange({ types: [], categories: [], states: [], cities: [], listingId: null, listingLabel: null })}
          className="inline-flex h-9 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" /> Clear all
        </button>
      )}
    </div>
  );
}

/**
 * Wraps a KPI tile or Panel that can't honour the listing filter (its data
 * comes from the day-keyed rollups, which carry no listing dimension). Adds a
 * corner badge while a filter is active so it's clear the number stays
 * platform-wide. No-ops when no filter is set.
 */
export function PlatformWide({ active, children }: { active: boolean; children: ReactNode }) {
  if (!active) return <>{children}</>;
  return (
    <div className="relative">
      <span
        title="This metric comes from the nightly rollups, which aren't broken down by listing — so it stays platform-wide regardless of the filters."
        className="pointer-events-auto absolute right-3 top-3 z-10 inline-flex items-center gap-1 rounded-full border border-border bg-muted/80 px-2 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur"
      >
        <MapPin className="h-2.5 w-2.5" /> Platform-wide
      </span>
      {children}
    </div>
  );
}

