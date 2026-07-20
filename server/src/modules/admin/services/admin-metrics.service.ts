import { adminMetricsRepository } from '../repositories/admin-metrics.repository.js';
import { adminRevenueRepository, REVENUE_DIMS, type RevenueDim } from '../repositories/admin-revenue.repository.js';
import { EMPTY_METRIC_FILTER, metricFilterActive, type MetricListingFilter } from '../repositories/admin-metric-filters.js';

// Postgres returns SUM()/COUNT() as strings and DATE as a Date — normalize both
// so the JSON the dashboard consumes is plain numbers + YYYY-MM-DD strings.
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const ymd = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

// Numeric columns on the overview series.
const OVERVIEW_KEYS = [
  'active_users', 'new_signups', 'logins',
  'listing_views_total', 'listing_views_stay', 'listing_views_service', 'listing_views_transport',
  'searches', 'card_clicks', 'booking_modal_opens', 'payment_starts',
  'bookings_confirmed', 'call_clicks', 'message_clicks', 'revenue_paise',
  'bookings_cancelled', 'refund_paise', 'reviews_submitted', 'reviews_rating_sum',
  'coupons_applied', 'coupons_failed', 'discount_paise', 'wishlist_adds', 'wishlist_removes',
  'new_listings', 'active_providers', 'ai_messages', 'fraud_signals', 'fraud_critical',
  'payment_failures',
] as const;

export interface MetricsWindow {
  from: string;
  to: string;
  days: number;
}

export type WindowOpts = { days?: number; from?: string; to?: string };

const isYmd = (s?: string): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export class AdminMetricsService {
  /**
   * Resolve an inclusive UTC date window. Accepts either an explicit
   * `{ from, to }` calendar range (used by the month / year / financial-year
   * pickers) or a trailing `{ days }` count (the 7d/30d/90d quick ranges).
   */
  window(opts: WindowOpts): MetricsWindow {
    if (isYmd(opts.from) && isYmd(opts.to) && opts.from <= opts.to) {
      const spanDays = Math.round(
        (Date.parse(`${opts.to}T00:00:00Z`) - Date.parse(`${opts.from}T00:00:00Z`)) / 86_400_000,
      ) + 1;
      return { from: opts.from, to: opts.to, days: Math.min(spanDays, 400) };
    }
    const clamped = Math.min(Math.max(Math.floor(opts.days || 30), 1), 400);
    const now = Date.now();
    const to = new Date(now).toISOString().slice(0, 10);
    const from = new Date(now - (clamped - 1) * 86_400_000).toISOString().slice(0, 10);
    return { from, to, days: clamped };
  }

  /** The equal-length window immediately before `range` — powers the
   *  period-over-period KPI deltas and the dashed prior-period chart overlay. */
  previousWindow(range: MetricsWindow): MetricsWindow {
    const fromMs = Date.parse(`${range.from}T00:00:00Z`);
    const to = new Date(fromMs - 86_400_000).toISOString().slice(0, 10);
    const from = new Date(fromMs - range.days * 86_400_000).toISOString().slice(0, 10);
    return { from, to, days: range.days };
  }

  async getOverview(opts: WindowOpts) {
    const range = this.window(opts);
    const prevRange = this.previousWindow(range);
    const [result, prevResult, platformResult] = await Promise.all([
      adminMetricsRepository.overviewSeries(range.from, range.to),
      adminMetricsRepository.overviewSeries(prevRange.from, prevRange.to),
      adminMetricsRepository.platformTotals(range.from, range.to),
    ]);
    const toSeries = (rows: Array<Record<string, unknown>>) =>
      rows.map((r) => {
        const row: Record<string, number | string> = { day: ymd(r.day) };
        for (const k of OVERVIEW_KEYS) row[k] = num(r[k]);
        return row;
      });
    const toTotals = (series: Array<Record<string, number | string>>) => {
      const totals: Record<string, number> = {};
      for (const k of OVERVIEW_KEYS) totals[k] = series.reduce((s, r) => s + (r[k] as number), 0);
      return totals;
    };
    const series = toSeries(result.rows);
    const prevSeries = toSeries(prevResult.rows);

    const platform = platformResult.rows.map((r: Record<string, unknown>) => ({
      platform: String(r.platform),
      events: num(r.events),
      activeUsers: num(r.active_users),
    }));
    return { range, prevRange, totals: toTotals(series), prevTotals: toTotals(prevSeries), series, prevSeries, platform };
  }

  /** Latest rollup day — lets the dashboard say how fresh the nightly data is. */
  async getFreshness() {
    const result = await adminMetricsRepository.latestRollupDay();
    const day = (result.rows[0] as Record<string, unknown> | undefined)?.day;
    return { latestDay: day == null ? null : ymd(day) };
  }

  async getFunnel(opts: WindowOpts) {
    const range = this.window(opts);
    const result = await adminMetricsRepository.funnelByType(range.from, range.to);
    const byType = result.rows.map((r: Record<string, unknown>) => ({
      listingType: String(r.listing_type),
      views: num(r.views),
      cardClicks: num(r.card_clicks),
      modalOpens: num(r.modal_opens),
      paymentStarts: num(r.payment_starts),
      bookings: num(r.bookings),
      revenuePaise: num(r.revenue_paise),
    }));
    return { range, byType };
  }

  async getSearchTerms(opts: WindowOpts, limit: number) {
    const range = this.window(opts);
    const cappedLimit = Math.min(Math.max(Math.floor(limit) || 20, 1), 100);
    const result = await adminMetricsRepository.topSearchTerms(range.from, range.to, cappedLimit);
    const terms = result.rows.map((r: Record<string, unknown>) => ({
      category: String(r.category),
      term: String(r.term),
      count: num(r.count),
    }));
    return { range, terms };
  }

  async getGeo(opts: WindowOpts, limit: number, filter: MetricListingFilter = EMPTY_METRIC_FILTER) {
    const range = this.window(opts);
    const cappedLimit = Math.min(Math.max(Math.floor(limit) || 15, 1), 100);
    // Rollup groups by booking city but carries no listing dims; when a filter
    // is active, re-source from bookings⨝listings (grouped by listing city).
    const result = metricFilterActive(filter)
      ? await adminMetricsRepository.filteredTopCities(range.from, range.to, cappedLimit, filter)
      : await adminMetricsRepository.topCities(range.from, range.to, cappedLimit);
    const cities = result.rows.map((r: Record<string, unknown>) => ({
      city: String(r.city),
      bookings: num(r.bookings),
      revenuePaise: num(r.revenue_paise),
    }));
    return { range, cities, filtered: metricFilterActive(filter) };
  }

  async getAcquisition(opts: WindowOpts, limit: number) {
    const range = this.window(opts);
    const cappedLimit = Math.min(Math.max(Math.floor(limit) || 12, 1), 100);
    const result = await adminMetricsRepository.topChannels(range.from, range.to, cappedLimit);
    const channels = result.rows.map((r: Record<string, unknown>) => ({
      channel: String(r.channel),
      sessions: num(r.sessions),
      signups: num(r.signups),
    }));
    return { range, channels };
  }

  async getLanguages(opts: WindowOpts) {
    const range = this.window(opts);
    const result = await adminMetricsRepository.languageTotals(range.from, range.to);
    const languages = result.rows.map((r: Record<string, unknown>) => ({
      language: String(r.language),
      events: num(r.events),
      activeUsers: num(r.active_users),
    }));
    return { range, languages };
  }

  async getOrigins(opts: WindowOpts, limit: number) {
    const range = this.window(opts);
    const cappedLimit = Math.min(Math.max(Math.floor(limit) || 15, 1), 100);
    const result = await adminMetricsRepository.topOrigins(range.from, range.to, cappedLimit);
    const origins = result.rows.map((r: Record<string, unknown>) => ({
      originCity: String(r.origin_city),
      originState: String(r.origin_state ?? ''),
      activeUsers: num(r.active_users),
      searches: num(r.searches),
    }));
    return { range, origins };
  }

  async getOriginDest(opts: WindowOpts, limit: number) {
    const range = this.window(opts);
    const cappedLimit = Math.min(Math.max(Math.floor(limit) || 15, 1), 100);
    const result = await adminMetricsRepository.topOriginDestPairs(range.from, range.to, cappedLimit);
    const pairs = result.rows.map((r: Record<string, unknown>) => ({
      originCity: String(r.origin_city),
      destCity: String(r.dest_city),
      modalOpens: num(r.modal_opens),
      paymentStarts: num(r.payment_starts),
    }));
    return { range, pairs };
  }

  async getPaymentFailures(opts: WindowOpts) {
    const range = this.window(opts);
    const result = await adminMetricsRepository.paymentFailureReasons(range.from, range.to);
    const reasons = result.rows.map((r: Record<string, unknown>) => ({
      reasonCode: String(r.reason_code),
      count: num(r.count),
    }));
    return { range, reasons };
  }

  async getCancelReasons(opts: WindowOpts) {
    const range = this.window(opts);
    const result = await adminMetricsRepository.cancelReasons(range.from, range.to);
    const reasons = result.rows.map((r: Record<string, unknown>) => ({
      reason: String(r.reason),
      count: num(r.count),
    }));
    return { range, reasons };
  }

  /** Customer bundle for the admin Customers page: new-vs-returning series,
   *  all-time repeat stats, AOV bands, category crossover, top customers. */
  async getCustomers(opts: WindowOpts, topLimit: number, filter: MetricListingFilter = EMPTY_METRIC_FILTER) {
    const range = this.window(opts);
    const cappedLimit = Math.min(Math.max(Math.floor(topLimit) || 10, 1), 50);
    const active = metricFilterActive(filter);
    // new-vs-returning, AOV bands, crossover + top-customers respond to the
    // filter (booking-backed); repeat stats stay all-time / platform-wide.
    const [nvr, repeat, bands, crossover, top] = await Promise.all([
      active
        ? adminMetricsRepository.filteredNewVsReturningDaily(range.from, range.to, filter)
        : adminMetricsRepository.newVsReturningDaily(range.from, range.to),
      adminMetricsRepository.repeatStats(),
      active
        ? adminMetricsRepository.filteredAovBands(range.from, range.to, filter)
        : adminMetricsRepository.aovBands(range.from, range.to),
      active ? adminMetricsRepository.filteredCrossover(filter) : adminMetricsRepository.categoryCrossover(),
      active
        ? adminMetricsRepository.filteredTopCustomers(range.from, range.to, cappedLimit, filter)
        : adminMetricsRepository.topCustomers(cappedLimit),
    ]);

    const series = nvr.rows.map((r: Record<string, unknown>) => ({
      day: ymd(r.day),
      newBookers: num(r.new_bookers),
      returningBookers: num(r.returning_bookers),
      newRevenuePaise: num(r.new_revenue_paise),
      returningRevenuePaise: num(r.returning_revenue_paise),
    }));
    const repeatRow = (repeat.rows[0] ?? {}) as Record<string, unknown>;
    const bookers = num(repeatRow.bookers);
    const repeatBookers = num(repeatRow.repeat_bookers);
    return {
      range,
      filtered: active,
      newVsReturning: series,
      repeat: {
        bookers,
        repeatBookers,
        repeatRate: bookers > 0 ? repeatBookers / bookers : 0,
        medianDaysToSecond: repeatRow.median_days_to_second == null ? null : Number(repeatRow.median_days_to_second),
      },
      aovBands: bands.rows.map((r: Record<string, unknown>) => ({ band: String(r.band), bookings: num(r.bookings) })),
      crossover: crossover.rows.map((r: Record<string, unknown>) => ({ combo: String(r.combo), customers: num(r.customers) })),
      topCustomers: top.rows.map((r: Record<string, unknown>) => ({
        userId: String(r.user_id),
        displayName: r.display_name == null ? null : String(r.display_name),
        email: r.email == null ? null : String(r.email),
        phone: r.phone == null ? null : String(r.phone),
        firstBookingAt: r.first_booking_at ? new Date(r.first_booking_at as string).toISOString() : null,
        lastBookingAt: r.last_booking_at ? new Date(r.last_booking_at as string).toISOString() : null,
        bookingsTotal: num(r.bookings_total),
        cancelledTotal: num(r.cancelled_total),
        revenuePaiseTotal: num(r.revenue_paise_total),
        favoriteCategory: r.favorite_category == null ? null : String(r.favorite_category),
        homeCity: r.home_city == null ? null : String(r.home_city),
        language: r.language == null ? null : String(r.language),
        acquisitionChannel: r.acquisition_channel == null ? null : String(r.acquisition_channel),
        lastActiveDay: r.last_active_day == null ? null : ymd(r.last_active_day),
      })),
    };
  }

  /** Call / message engagement as a daily series + totals (from the overview table). */
  async getEngagement(opts: WindowOpts) {
    const range = this.window(opts);
    const result = await adminMetricsRepository.overviewSeries(range.from, range.to);
    const series = result.rows.map((r: Record<string, unknown>) => ({
      day: ymd(r.day),
      callClicks: num(r.call_clicks),
      messageClicks: num(r.message_clicks),
    }));
    const totals = {
      callClicks: series.reduce((s, r) => s + r.callClicks, 0),
      messageClicks: series.reduce((s, r) => s + r.messageClicks, 0),
    };
    return { range, totals, series };
  }

  /** Filtered Bookings tile + daily chart (confirmed bookings, live source).
   *  Only called when a filter is active — the unfiltered Overview stays on the
   *  nightly rollup. Returns this window and the prior equal-length one so the
   *  KPI delta + dashed prior-period overlay keep working. */
  async getFilteredBookings(opts: WindowOpts, filter: MetricListingFilter) {
    const range = this.window(opts);
    const prevRange = this.previousWindow(range);
    const [rows, prevRows] = await Promise.all([
      adminMetricsRepository.filteredBookingSeries(range.from, range.to, filter),
      adminMetricsRepository.filteredBookingSeries(prevRange.from, prevRange.to, filter),
    ]);
    const map = (rs: Array<Record<string, unknown>>) =>
      rs.map((r) => ({ day: ymd(r.day), bookings: num(r.bookings), revenuePaise: num(r.revenue_paise) }));
    const series = map(rows.rows);
    const prevSeries = map(prevRows.rows);
    const sum = (s: Array<{ bookings: number; revenuePaise: number }>) => ({
      bookings: s.reduce((a, r) => a + r.bookings, 0),
      revenuePaise: s.reduce((a, r) => a + r.revenuePaise, 0),
    });
    return { range, prevRange, totals: sum(series), prevTotals: sum(prevSeries), series, prevSeries };
  }

  /** Filtered Providers tiles (new listings, active providers, provider
   *  revenue, reviews) + the daily new-listings chart. Live source. */
  async getFilteredProviders(opts: WindowOpts, filter: MetricListingFilter) {
    const range = this.window(opts);
    const [listingRows, stats] = await Promise.all([
      adminMetricsRepository.filteredNewListingsSeries(range.from, range.to, filter),
      adminMetricsRepository.filteredProviderStats(range.from, range.to, filter),
    ]);
    const [bookingStats, reviewStats] = stats;
    const series = listingRows.rows.map((r: Record<string, unknown>) => ({ day: ymd(r.day), listings: num(r.listings) }));
    const b = (bookingStats.rows[0] ?? {}) as Record<string, unknown>;
    const rv = (reviewStats.rows[0] ?? {}) as Record<string, unknown>;
    return {
      range,
      totals: {
        newListings: series.reduce((a, r) => a + r.listings, 0),
        activeProviders: num(b.active_providers),
        bookings: num(b.bookings),
        providerRevenuePaise: num(b.revenue_paise),
        reviews: num(rv.reviews),
        reviewsRatingSum: num(rv.rating_sum),
      },
      series,
    };
  }

  /** Validated drill-down segment from raw query input; null when absent/bad. */
  private revenueSegment(dim?: string, key?: string): { dim: RevenueDim; key: string } | null {
    if (!dim || !key?.trim()) return null;
    if (!REVENUE_DIMS.includes(dim as RevenueDim)) return null;
    return { dim: dim as RevenueDim, key: key.trim().slice(0, 100) };
  }

  /** Window totals from the payments source of truth — powers the Revenue
   *  KPI row and Overview's revenue tile. The event-based rollups undercount
   *  revenue (capture only exists since 2026-07-06 and webhook-confirmed
   *  on-behalf payments never emit client events), so money KPIs read
   *  payments directly and rollups stay for behavioral metrics. */
  async getRevenueSummary(opts: WindowOpts, filter: MetricListingFilter = EMPTY_METRIC_FILTER) {
    const range = this.window(opts);
    const prevRange = this.previousWindow(range);
    const [row, prevRow] = await Promise.all([
      adminRevenueRepository.totals(range.from, range.to, filter),
      adminRevenueRepository.totals(prevRange.from, prevRange.to, filter),
    ]);
    const shape = (r: typeof row) => {
      const bookings = num(r?.bookings);
      const grossPaise = num(r?.gross_paise);
      const refundPaise = num(r?.refund_paise);
      return {
        bookings,
        refundedBookings: num(r?.refunded_bookings),
        grossPaise,
        refundPaise,
        netPaise: grossPaise - refundPaise,
        aovPaise: bookings > 0 ? Math.round(grossPaise / bookings) : 0,
        // Composition snapshots (0 on pre-2026-05-15 legacy payments).
        discountPaise: num(r?.discount_paise),
        subtotalPaise: num(r?.subtotal_paise),
        platformFeePaise: num(r?.platform_fee_paise),
        taxesPaise: num(r?.taxes_paise),
        insurancePaise: num(r?.insurance_paise),
      };
    };
    return { range, prevRange, totals: shape(row), prevTotals: shape(prevRow) };
  }

  /** Paid revenue grouped by a listing dimension (payments source of truth). */
  async getRevenueBreakdown(opts: WindowOpts, dimRaw: string | undefined, limit: number) {
    const range = this.window(opts);
    const dim: RevenueDim = REVENUE_DIMS.includes(dimRaw as RevenueDim) ? (dimRaw as RevenueDim) : 'type';
    const capped = Math.min(Math.max(Math.floor(limit) || 12, 1), 50);
    const rows = await adminRevenueRepository.breakdown(range.from, range.to, dim, capped);
    return {
      range,
      dim,
      rows: rows.map((r) => ({
        key: String(r.key),
        bookings: num(r.bookings),
        grossPaise: num(r.gross_paise),
        refundPaise: num(r.refund_paise),
      })),
    };
  }

  /** Daily paid revenue, densified over the window; optionally overlays one
   *  segment's slice (dim + key) for the "click a bar → see its trend" UX.
   *  Also returns the previous equal-length window (overall gross only, index-
   *  aligned by day offset) for the dashed prior-period overlay. */
  async getRevenueSeries(opts: WindowOpts, dim?: string, key?: string) {
    const range = this.window(opts);
    const prevRange = this.previousWindow(range);
    const segment = this.revenueSegment(dim, key);
    const [rows, prevRows] = await Promise.all([
      adminRevenueRepository.series(range.from, range.to, segment ?? undefined),
      adminRevenueRepository.series(prevRange.from, prevRange.to),
    ]);
    const byDay = new Map(rows.map((r) => [ymd(r.day), r]));
    const series: Array<{ day: string; bookings: number; grossPaise: number; segmentPaise: number | null }> = [];
    for (let t = Date.parse(`${range.from}T00:00:00Z`); t <= Date.parse(`${range.to}T00:00:00Z`); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      const row = byDay.get(day);
      series.push({
        day,
        bookings: num(row?.bookings),
        grossPaise: num(row?.gross_paise),
        segmentPaise: segment ? num(row?.segment_paise) : null,
      });
    }
    const prevByDay = new Map(prevRows.map((r) => [ymd(r.day), r]));
    const prevSeries: Array<{ day: string; grossPaise: number }> = [];
    for (let t = Date.parse(`${prevRange.from}T00:00:00Z`); t <= Date.parse(`${prevRange.to}T00:00:00Z`); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      prevSeries.push({ day, grossPaise: num(prevByDay.get(day)?.gross_paise) });
    }
    return { range, prevRange, segment, series, prevSeries };
  }

  /** Top listings by paid revenue, optionally narrowed to a segment. */
  async getRevenueListings(opts: WindowOpts, dim: string | undefined, key: string | undefined, limit: number) {
    const range = this.window(opts);
    const segment = this.revenueSegment(dim, key);
    const capped = Math.min(Math.max(Math.floor(limit) || 10, 1), 50);
    const rows = await adminRevenueRepository.topListings(range.from, range.to, capped, segment ?? undefined);
    return {
      range,
      segment,
      listings: rows.map((r) => ({
        listingId: String(r.listing_id),
        name: String(r.name),
        listingType: r.listing_type == null ? null : String(r.listing_type),
        city: r.city == null ? null : String(r.city),
        bookings: num(r.bookings),
        grossPaise: num(r.gross_paise),
        refundPaise: num(r.refund_paise),
      })),
    };
  }
}

export const adminMetricsService = new AdminMetricsService();
