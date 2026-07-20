import { apiRequest, getJsonHeaders } from "@/lib/api-client";

// Client for the admin analytics endpoints (backed by the nightly rollup
// tables). All routes require an authenticated user with the `admin` role.

export interface MetricsRange {
  from: string;
  to: string;
  days: number;
}

export interface OverviewRow {
  day: string;
  active_users: number;
  new_signups: number;
  logins: number;
  listing_views_total: number;
  listing_views_stay: number;
  listing_views_service: number;
  listing_views_transport: number;
  searches: number;
  card_clicks: number;
  booking_modal_opens: number;
  payment_starts: number;
  bookings_confirmed: number;
  call_clicks: number;
  message_clicks: number;
  revenue_paise: number;
  bookings_cancelled: number;
  refund_paise: number;
  reviews_submitted: number;
  reviews_rating_sum: number;
  coupons_applied: number;
  coupons_failed: number;
  discount_paise: number;
  wishlist_adds: number;
  wishlist_removes: number;
  new_listings: number;
  active_providers: number;
  ai_messages: number;
  fraud_signals: number;
  fraud_critical: number;
}

export interface GeoResponse {
  range: MetricsRange;
  cities: Array<{ city: string; bookings: number; revenuePaise: number }>;
  /** True when a listing filter re-sourced the cities from bookings⨝listings. */
  filtered?: boolean;
}

export interface AcquisitionResponse {
  range: MetricsRange;
  channels: Array<{ channel: string; sessions: number; signups: number }>;
}

export interface PlatformRow {
  platform: string;
  events: number;
  activeUsers: number;
}

export interface OverviewResponse {
  range: MetricsRange;
  /** The equal-length window immediately before `range` — KPI deltas + chart overlay. */
  prevRange: MetricsRange;
  totals: Omit<OverviewRow, "day">;
  prevTotals: Omit<OverviewRow, "day">;
  series: OverviewRow[];
  prevSeries: OverviewRow[];
  platform: PlatformRow[];
}

export interface FunnelTypeRow {
  listingType: string;
  views: number;
  cardClicks: number;
  modalOpens: number;
  paymentStarts: number;
  bookings: number;
  revenuePaise: number;
}

export interface FunnelResponse {
  range: MetricsRange;
  byType: FunnelTypeRow[];
}

export interface SearchTermRow {
  category: string;
  term: string;
  count: number;
}

export interface SearchTermsResponse {
  range: MetricsRange;
  terms: SearchTermRow[];
}

export interface EngagementResponse {
  range: MetricsRange;
  totals: { callClicks: number; messageClicks: number };
  series: Array<{ day: string; callClicks: number; messageClicks: number }>;
}

export interface CustomersResponse {
  range: MetricsRange;
  /** True when a listing filter narrowed the booking-backed panels. */
  filtered?: boolean;
  newVsReturning: Array<{
    day: string;
    newBookers: number;
    returningBookers: number;
    newRevenuePaise: number;
    returningRevenuePaise: number;
  }>;
  repeat: {
    bookers: number;
    repeatBookers: number;
    repeatRate: number;
    medianDaysToSecond: number | null;
  };
  aovBands: Array<{ band: string; bookings: number }>;
  crossover: Array<{ combo: string; customers: number }>;
  topCustomers: Array<{
    userId: string;
    displayName: string | null;
    email: string | null;
    phone: string | null;
    firstBookingAt: string | null;
    lastBookingAt: string | null;
    bookingsTotal: number;
    cancelledTotal: number;
    revenuePaiseTotal: number;
    favoriteCategory: string | null;
    homeCity: string | null;
    language: string | null;
    acquisitionChannel: string | null;
    lastActiveDay: string | null;
  }>;
}

export interface LanguagesResponse {
  range: MetricsRange;
  languages: Array<{ language: string; events: number; activeUsers: number }>;
}

export interface OriginsResponse {
  range: MetricsRange;
  origins: Array<{ originCity: string; originState: string; activeUsers: number; searches: number }>;
}

export interface OriginDestResponse {
  range: MetricsRange;
  pairs: Array<{ originCity: string; destCity: string; modalOpens: number; paymentStarts: number }>;
}

export interface PaymentFailuresResponse {
  range: MetricsRange;
  reasons: Array<{ reasonCode: string; count: number }>;
}

export interface CancelReasonsResponse {
  range: MetricsRange;
  reasons: Array<{ reason: string; count: number }>;
}


// ── Revenue drill-down (payments source of truth, not the rollups) ──

export type RevenueDim = "type" | "category" | "city" | "state" | "host";

export interface RevenueSegment {
  dim: RevenueDim;
  key: string;
}

export interface RevenueTotals {
  bookings: number;
  refundedBookings: number;
  grossPaise: number;
  refundPaise: number;
  netPaise: number;
  aovPaise: number;
  // Composition from per-payment snapshots (0 on legacy pre-snapshot payments).
  discountPaise: number;
  subtotalPaise: number;
  platformFeePaise: number;
  taxesPaise: number;
  insurancePaise: number;
}

export interface RevenueSummaryResponse {
  range: MetricsRange;
  prevRange: MetricsRange;
  totals: RevenueTotals;
  prevTotals: RevenueTotals;
}

export interface RevenueBreakdownResponse {
  range: MetricsRange;
  dim: RevenueDim;
  rows: Array<{ key: string; bookings: number; grossPaise: number; refundPaise: number }>;
}

export interface RevenueSeriesResponse {
  range: MetricsRange;
  prevRange: MetricsRange;
  segment: RevenueSegment | null;
  series: Array<{ day: string; bookings: number; grossPaise: number; segmentPaise: number | null }>;
  /** Overall gross for the previous window, densified — index-aligned with `series`. */
  prevSeries: Array<{ day: string; grossPaise: number }>;
}

export interface FreshnessResponse {
  /** Latest day present in the nightly rollups (null before the first run). */
  latestDay: string | null;
}

export interface RevenueListingsResponse {
  range: MetricsRange;
  segment: RevenueSegment | null;
  listings: Array<{
    listingId: string;
    name: string;
    listingType: string | null;
    city: string | null;
    bookings: number;
    grossPaise: number;
    refundPaise: number;
  }>;
}

async function get<T>(path: string): Promise<T> {
  const result = await apiRequest<T>(path, { headers: getJsonHeaders(false) });
  if (!result.success || !result.data) {
    throw new Error(result.error || "Failed to load metrics");
  }
  return result.data;
}

/** A trailing-day count (7d/30d/90d) or an explicit calendar range (month/year/FY). */
export type AdminRange = { days: number } | { from: string; to: string };

/** Stable query-string for a range — also usable as a react-query key fragment. */
export function rangeQuery(range: AdminRange): string {
  return "from" in range ? `from=${range.from}&to=${range.to}` : `days=${range.days}`;
}

// ── Analytics filter bar (vertical / category / geo / specific listing) ──
// Applies only to tiles backed by bookings/listings/payments; the day-keyed
// rollups carry no such dimensions, so behavioral tiles stay platform-wide.

export interface AdminMetricFilter {
  types: string[];
  categories: string[];
  states: string[];
  cities: string[];
  /** Exact listing id from the search picker (null = no single-listing filter). */
  listingId: string | null;
  /** Display label for the picked listing — client-only, never sent to the API. */
  listingLabel: string | null;
}

export const EMPTY_ADMIN_FILTER: AdminMetricFilter = {
  types: [],
  categories: [],
  states: [],
  cities: [],
  listingId: null,
  listingLabel: null,
};

/** Any narrowing active — the signal a tab uses to fetch the live filtered data. */
export function adminFilterActive(f: AdminMetricFilter): boolean {
  return (
    f.types.length > 0 ||
    f.categories.length > 0 ||
    f.states.length > 0 ||
    f.cities.length > 0 ||
    !!f.listingId
  );
}

/** `&`-prefixed query fragment (empty when inactive, so callers stay backward
 *  compatible). Also a stable react-query key fragment. */
export function filterQuery(f: AdminMetricFilter): string {
  const parts: string[] = [];
  const list = (key: string, values: string[]) => {
    if (values.length) parts.push(`${key}=${encodeURIComponent(values.join(","))}`);
  };
  list("types", f.types);
  list("categories", f.categories);
  list("states", f.states);
  list("cities", f.cities);
  if (f.listingId) parts.push(`listingId=${encodeURIComponent(f.listingId)}`);
  return parts.length ? `&${parts.join("&")}` : "";
}

export interface FilteredBookingsResponse {
  range: MetricsRange;
  prevRange: MetricsRange;
  totals: { bookings: number; revenuePaise: number };
  prevTotals: { bookings: number; revenuePaise: number };
  series: Array<{ day: string; bookings: number; revenuePaise: number }>;
  prevSeries: Array<{ day: string; bookings: number; revenuePaise: number }>;
}

export interface FilteredProvidersResponse {
  range: MetricsRange;
  totals: {
    newListings: number;
    activeProviders: number;
    bookings: number;
    providerRevenuePaise: number;
    reviews: number;
    reviewsRatingSum: number;
  };
  series: Array<{ day: string; listings: number }>;
}


/** Query-string fragment for an optional drill-down segment. */
const segmentQuery = (segment: RevenueSegment | null) =>
  segment ? `&dim=${segment.dim}&key=${encodeURIComponent(segment.key)}` : "";

export const adminMetrics = {
  overview: (range: AdminRange) => get<OverviewResponse>(`/api/admin/metrics/overview?${rangeQuery(range)}`),
  funnel: (range: AdminRange) => get<FunnelResponse>(`/api/admin/metrics/funnel?${rangeQuery(range)}`),
  searchTerms: (range: AdminRange, limit = 20) =>
    get<SearchTermsResponse>(`/api/admin/metrics/search-terms?${rangeQuery(range)}&limit=${limit}`),
  engagement: (range: AdminRange) => get<EngagementResponse>(`/api/admin/metrics/engagement?${rangeQuery(range)}`),
  geo: (range: AdminRange, limit = 15, filter?: AdminMetricFilter) =>
    get<GeoResponse>(`/api/admin/metrics/geo?${rangeQuery(range)}&limit=${limit}${filter ? filterQuery(filter) : ""}`),
  acquisition: (range: AdminRange, limit = 12) => get<AcquisitionResponse>(`/api/admin/metrics/acquisition?${rangeQuery(range)}&limit=${limit}`),
  customers: (range: AdminRange, limit = 10, filter?: AdminMetricFilter) =>
    get<CustomersResponse>(`/api/admin/metrics/customers?${rangeQuery(range)}&limit=${limit}${filter ? filterQuery(filter) : ""}`),
  /** Filtered Bookings tile + daily chart (Overview) — call only when a filter is active. */
  filteredBookings: (range: AdminRange, filter: AdminMetricFilter) =>
    get<FilteredBookingsResponse>(`/api/admin/metrics/bookings?${rangeQuery(range)}${filterQuery(filter)}`),
  /** Filtered Providers tiles + new-listings chart — call only when a filter is active. */
  filteredProviders: (range: AdminRange, filter: AdminMetricFilter) =>
    get<FilteredProvidersResponse>(`/api/admin/metrics/providers?${rangeQuery(range)}${filterQuery(filter)}`),
  languages: (range: AdminRange) => get<LanguagesResponse>(`/api/admin/metrics/languages?${rangeQuery(range)}`),
  origins: (range: AdminRange, limit = 15) => get<OriginsResponse>(`/api/admin/metrics/origins?${rangeQuery(range)}&limit=${limit}`),
  originDest: (range: AdminRange, limit = 15) => get<OriginDestResponse>(`/api/admin/metrics/origin-dest?${rangeQuery(range)}&limit=${limit}`),
  paymentFailures: (range: AdminRange) => get<PaymentFailuresResponse>(`/api/admin/metrics/payment-failures?${rangeQuery(range)}`),
  cancelReasons: (range: AdminRange) => get<CancelReasonsResponse>(`/api/admin/metrics/cancel-reasons?${rangeQuery(range)}`),
  freshness: () => get<FreshnessResponse>(`/api/admin/metrics/freshness`),
  revenueSummary: (range: AdminRange, filter?: AdminMetricFilter) =>
    get<RevenueSummaryResponse>(`/api/admin/metrics/revenue/summary?${rangeQuery(range)}${filter ? filterQuery(filter) : ""}`),
  revenueBreakdown: (range: AdminRange, dim: RevenueDim, limit = 12) =>
    get<RevenueBreakdownResponse>(`/api/admin/metrics/revenue/breakdown?${rangeQuery(range)}&dim=${dim}&limit=${limit}`),
  revenueSeries: (range: AdminRange, segment: RevenueSegment | null) =>
    get<RevenueSeriesResponse>(`/api/admin/metrics/revenue/series?${rangeQuery(range)}${segmentQuery(segment)}`),
  revenueListings: (range: AdminRange, segment: RevenueSegment | null, limit = 10) =>
    get<RevenueListingsResponse>(`/api/admin/metrics/revenue/listings?${rangeQuery(range)}${segmentQuery(segment)}&limit=${limit}`),
};
