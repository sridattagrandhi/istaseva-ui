// design/api/adminMetrics.ts — admin analytics client (mobile).
// Hits the same /api/admin/metrics/* endpoints as the web dashboard; all are
// gated server-side by requireRole('admin'). The axios client injects the
// Firebase token, so an admin account is authorized automatically.
import { api } from "@/lib/api";

export type AdminRange = { days: number } | { from: string; to: string };
function q(r: AdminRange): string {
  return "from" in r ? `from=${r.from}&to=${r.to}` : `days=${r.days}`;
}

// ── Analytics listing filter (vertical / category / geo / one listing) ──
// Mirrors web src/domains/analytics/admin-metrics.service.ts. Only tiles
// backed by bookings/listings/payments respond; the day-keyed rollups carry
// no listing dimensions, so behavioral tiles stay platform-wide (badged).

export type AdminMetricFilter = {
  types: string[];
  categories: string[];
  states: string[];
  cities: string[];
  /** Exact listing id from the search picker (null = no single-listing filter). */
  listingId: string | null;
  /** Display label for the picked listing — client-only, never sent to the API. */
  listingLabel: string | null;
};

export const EMPTY_ADMIN_FILTER: AdminMetricFilter = {
  types: [], categories: [], states: [], cities: [], listingId: null, listingLabel: null,
};

/** Any narrowing active — the signal a tab uses to fetch the live filtered data. */
export function adminFilterActive(f: AdminMetricFilter): boolean {
  return f.types.length > 0 || f.categories.length > 0 || f.states.length > 0 || f.cities.length > 0 || !!f.listingId;
}

/** `&`-prefixed query fragment (empty when inactive) — also a stable react-query key fragment. */
export function filterQ(f: AdminMetricFilter): string {
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

export type OverviewTotals = {
  active_users: number; new_signups: number; logins: number;
  listing_views_total: number; listing_views_stay: number; listing_views_service: number; listing_views_transport: number;
  searches: number; card_clicks: number; booking_modal_opens: number; payment_starts: number;
  bookings_confirmed: number; call_clicks: number; message_clicks: number; revenue_paise: number;
  bookings_cancelled: number; refund_paise: number; reviews_submitted: number; reviews_rating_sum: number;
  coupons_applied: number; coupons_failed: number; discount_paise: number; wishlist_adds: number; wishlist_removes: number;
  new_listings: number; active_providers: number;
  ai_messages: number; fraud_signals: number; fraud_critical: number;
};
export type OverviewResponse = {
  range: { from: string; to: string; days: number };
  /** Equal-length window immediately before `range` — KPI deltas + chart overlay. */
  prevRange: { from: string; to: string; days: number };
  totals: OverviewTotals;
  prevTotals: OverviewTotals;
  series: any[];
  prevSeries: any[];
  platform: Array<{ platform: string; events: number; activeUsers: number }>;
};
export type FunnelResponse = { range: any; byType: Array<{ listingType: string; views: number; cardClicks: number; modalOpens: number; paymentStarts: number; bookings: number; revenuePaise: number }> };
export type GeoResponse = { range: any; cities: Array<{ city: string; bookings: number; revenuePaise: number }> };
export type SearchTermsResponse = { range: any; terms: Array<{ category: string; term: string; count: number }> };
export type EngagementResponse = { range: any; totals: { callClicks: number; messageClicks: number }; series: Array<{ day: string; callClicks: number; messageClicks: number }> };
export type AcquisitionResponse = { range: any; channels: Array<{ channel: string; sessions: number; signups: number }> };

export type TopCustomer = {
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
};
export type CustomersResponse = {
  range: any;
  newVsReturning: Array<{ day: string; newBookers: number; returningBookers: number; newRevenuePaise: number; returningRevenuePaise: number }>;
  repeat: { bookers: number; repeatBookers: number; repeatRate: number; medianDaysToSecond: number | null };
  aovBands: Array<{ band: string; bookings: number }>;
  crossover: Array<{ combo: string; customers: number }>;
  topCustomers: TopCustomer[];
};
export type LanguagesResponse = { range: any; languages: Array<{ language: string; events: number; activeUsers: number }> };
export type OriginsResponse = { range: any; origins: Array<{ originCity: string; originState: string; activeUsers: number; searches: number }> };
export type OriginDestResponse = { range: any; pairs: Array<{ originCity: string; destCity: string; modalOpens: number; paymentStarts: number }> };
export type PaymentFailuresResponse = { range: any; reasons: Array<{ reasonCode: string; count: number }> };
export type CancelReasonsResponse = { range: any; reasons: Array<{ reason: string; count: number }> };

export async function fetchOverview(r: AdminRange): Promise<OverviewResponse> {
  const res = await api.get(`/api/admin/metrics/overview?${q(r)}`);
  return res.data;
}
export async function fetchFunnel(r: AdminRange): Promise<FunnelResponse> {
  const res = await api.get(`/api/admin/metrics/funnel?${q(r)}`);
  return res.data;
}
export async function fetchGeo(r: AdminRange, limit = 10, filter?: AdminMetricFilter): Promise<GeoResponse> {
  const res = await api.get(`/api/admin/metrics/geo?${q(r)}&limit=${limit}${filter ? filterQ(filter) : ""}`);
  return res.data;
}
export async function fetchSearchTerms(r: AdminRange, limit = 15): Promise<SearchTermsResponse> {
  const res = await api.get(`/api/admin/metrics/search-terms?${q(r)}&limit=${limit}`);
  return res.data;
}
export async function fetchEngagement(r: AdminRange): Promise<EngagementResponse> {
  const res = await api.get(`/api/admin/metrics/engagement?${q(r)}`);
  return res.data;
}
export async function fetchAcquisition(r: AdminRange, limit = 10): Promise<AcquisitionResponse> {
  const res = await api.get(`/api/admin/metrics/acquisition?${q(r)}&limit=${limit}`);
  return res.data;
}
export async function fetchCustomers(r: AdminRange, limit = 10, filter?: AdminMetricFilter): Promise<CustomersResponse> {
  const res = await api.get(`/api/admin/metrics/customers?${q(r)}&limit=${limit}${filter ? filterQ(filter) : ""}`);
  return res.data;
}
export async function fetchLanguages(r: AdminRange): Promise<LanguagesResponse> {
  const res = await api.get(`/api/admin/metrics/languages?${q(r)}`);
  return res.data;
}
export async function fetchOrigins(r: AdminRange, limit = 10): Promise<OriginsResponse> {
  const res = await api.get(`/api/admin/metrics/origins?${q(r)}&limit=${limit}`);
  return res.data;
}
export async function fetchOriginDest(r: AdminRange, limit = 10): Promise<OriginDestResponse> {
  const res = await api.get(`/api/admin/metrics/origin-dest?${q(r)}&limit=${limit}`);
  return res.data;
}
export async function fetchPaymentFailures(r: AdminRange): Promise<PaymentFailuresResponse> {
  const res = await api.get(`/api/admin/metrics/payment-failures?${q(r)}`);
  return res.data;
}
export async function fetchCancelReasons(r: AdminRange): Promise<CancelReasonsResponse> {
  const res = await api.get(`/api/admin/metrics/cancel-reasons?${q(r)}`);
  return res.data;
}
export type FreshnessResponse = {
  /** Latest day present in the nightly rollups (null before the first run). */
  latestDay: string | null;
};
export async function fetchFreshness(): Promise<FreshnessResponse> {
  const res = await api.get(`/api/admin/metrics/freshness`);
  return res.data;
}
export const rangeKey = (r: AdminRange) => ("from" in r ? `${r.from}_${r.to}` : `d${r.days}`);

// ── Revenue drill-down (payments source of truth, not the rollups) ──

export type RevenueDim = "type" | "category" | "city" | "state" | "host";
export type RevenueSegment = { dim: RevenueDim; key: string };
export type RevenueTotals = {
  bookings: number; refundedBookings: number;
  grossPaise: number; refundPaise: number; netPaise: number; aovPaise: number;
  // Composition from per-payment snapshots (0 on legacy pre-snapshot payments).
  discountPaise: number; subtotalPaise: number; platformFeePaise: number;
  taxesPaise: number; insurancePaise: number;
};
export type RevenueSummaryResponse = {
  range: any;
  prevRange: { from: string; to: string; days: number };
  totals: RevenueTotals;
  prevTotals: RevenueTotals;
};
export type RevenueBreakdownResponse = {
  range: any;
  dim: RevenueDim;
  rows: Array<{ key: string; bookings: number; grossPaise: number; refundPaise: number }>;
};
export type RevenueSeriesResponse = {
  range: any;
  prevRange: { from: string; to: string; days: number };
  segment: RevenueSegment | null;
  series: Array<{ day: string; bookings: number; grossPaise: number; segmentPaise: number | null }>;
  /** Overall gross for the previous window, densified — index-aligned with `series`. */
  prevSeries: Array<{ day: string; grossPaise: number }>;
};
export type RevenueListingsResponse = {
  range: any;
  segment: RevenueSegment | null;
  listings: Array<{
    listingId: string; name: string; listingType: string | null; city: string | null;
    bookings: number; grossPaise: number; refundPaise: number;
  }>;
};

const segQ = (s: RevenueSegment | null) => (s ? `&dim=${s.dim}&key=${encodeURIComponent(s.key)}` : "");

export async function fetchRevenueSummary(r: AdminRange, filter?: AdminMetricFilter): Promise<RevenueSummaryResponse> {
  const res = await api.get(`/api/admin/metrics/revenue/summary?${q(r)}${filter ? filterQ(filter) : ""}`);
  return res.data as RevenueSummaryResponse;
}
export async function fetchRevenueBreakdown(r: AdminRange, dim: RevenueDim, limit = 12): Promise<RevenueBreakdownResponse> {
  const res = await api.get(`/api/admin/metrics/revenue/breakdown?${q(r)}&dim=${dim}&limit=${limit}`);
  return res.data as RevenueBreakdownResponse;
}
export async function fetchRevenueSeries(r: AdminRange, segment: RevenueSegment | null): Promise<RevenueSeriesResponse> {
  const res = await api.get(`/api/admin/metrics/revenue/series?${q(r)}${segQ(segment)}`);
  return res.data as RevenueSeriesResponse;
}
export async function fetchRevenueListings(r: AdminRange, segment: RevenueSegment | null, limit = 10): Promise<RevenueListingsResponse> {
  const res = await api.get(`/api/admin/metrics/revenue/listings?${q(r)}${segQ(segment)}&limit=${limit}`);
  return res.data as RevenueListingsResponse;
}

// ── Filtered live metrics (only fetched while a filter is active) ──
// The rollups can't be sliced by listing dims, so these endpoints re-source
// the Bookings tile/chart and the Providers tiles from bookings⨝listings.

export type FilteredBookingsResponse = {
  range: { from: string; to: string; days: number };
  prevRange: { from: string; to: string; days: number };
  totals: { bookings: number; revenuePaise: number };
  prevTotals: { bookings: number; revenuePaise: number };
  series: Array<{ day: string; bookings: number; revenuePaise: number }>;
  prevSeries: Array<{ day: string; bookings: number; revenuePaise: number }>;
};

export type FilteredProvidersResponse = {
  range: { from: string; to: string; days: number };
  totals: {
    newListings: number;
    activeProviders: number;
    bookings: number;
    providerRevenuePaise: number;
    reviews: number;
    reviewsRatingSum: number;
  };
  series: Array<{ day: string; listings: number }>;
};

export async function fetchFilteredBookings(r: AdminRange, filter: AdminMetricFilter): Promise<FilteredBookingsResponse> {
  const res = await api.get(`/api/admin/metrics/bookings?${q(r)}${filterQ(filter)}`);
  return res.data as FilteredBookingsResponse;
}
export async function fetchFilteredProviders(r: AdminRange, filter: AdminMetricFilter): Promise<FilteredProvidersResponse> {
  const res = await api.get(`/api/admin/metrics/providers?${q(r)}${filterQ(filter)}`);
  return res.data as FilteredProvidersResponse;
}
