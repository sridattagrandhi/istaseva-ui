import { lowerList } from './admin-bookings.repository.js';

// Shared listing-scoped filter for the admin ANALYTICS tabs (Overview /
// Providers / Geographic / Customers). Unlike the day-keyed rollups — which
// carry no category/geo dimension — the filterable tiles read the
// transactional bookings/listings/payments tables, so a vertical / category /
// city / state / single-listing filter can be applied with a plain WHERE.
//
// Matching semantics mirror the ops-screen filters (admin-bookings /
// admin-listings repositories) exactly, so the same facet values select the
// same rows on both surfaces: case-insensitive, trimmed, against a `listings`
// alias `l` (and, for category, the booking's snapshot when present).

export interface MetricListingFilter {
  types: string[];
  categories: string[];
  states: string[];
  cities: string[];
  /** Exact listing id (the "query by specific listing" search picker). */
  listingId: string | null;
}

export const EMPTY_METRIC_FILTER: MetricListingFilter = {
  types: [],
  categories: [],
  states: [],
  cities: [],
  listingId: null,
};

/** True when any filter narrows the result — the signal to switch a tile from
 *  the pre-aggregated rollups to the live transactional query. */
export function metricFilterActive(f: MetricListingFilter): boolean {
  return (
    f.types.length > 0 ||
    f.categories.length > 0 ||
    f.states.length > 0 ||
    f.cities.length > 0 ||
    !!f.listingId
  );
}

/**
 * AND-clauses filtering a `listings` row (alias `l`), appended after the
 * caller's existing WHERE. Params bind starting at `$${start + 1}`; the
 * returned `sql` already carries its leading ` AND ` (empty string when
 * nothing is set, so it's always safe to interpolate).
 *
 * `categoryExpr` lets booking-based callers match the category against the
 * booking's snapshot first (`COALESCE(b.service_category, l.category)`) — the
 * same expression the bookings ops screen filters on — while listing-only
 * callers fall back to the plain `l.category` default.
 */
export function buildMetricFilter(
  f: MetricListingFilter,
  start: number,
  opts: { categoryExpr?: string } = {},
): { sql: string; params: unknown[] } {
  const categoryExpr = opts.categoryExpr ?? 'l.category';
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    clauses.push(clause.replaceAll('?', `$${start + params.length}`));
  };

  if (f.types.length) add('lower(l.listing_type) = ANY(?)', lowerList(f.types));
  if (f.categories.length) add(`lower(btrim(${categoryExpr})) = ANY(?)`, lowerList(f.categories));
  if (f.states.length) add('lower(btrim(l.state)) = ANY(?)', lowerList(f.states));
  if (f.cities.length) add('lower(btrim(l.city)) = ANY(?)', lowerList(f.cities));
  if (f.listingId) add('l.id::text = ?', f.listingId);

  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}
