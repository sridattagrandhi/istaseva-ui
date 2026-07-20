import { dbQuery } from '../../../common/repositories/database.js';
import { buildMetricFilter, type MetricListingFilter } from './admin-metric-filters.js';

// Category is matched on the LISTING's own category (l.category) — that's what
// the facet dropdown is populated from, so the picked value always resolves.
// (Booking `service_category` is prefixed differently, e.g. 'stay:hotel' vs the
// listing's 'hotel', so matching on it would silently miss stay/transport rows.)
const BOOKED = "b.status IN ('confirmed','in_progress','completed')";

// Read-only access to the analytics rollup tables (populated by the nightly
// rollup job). All queries are windowed on `day` (inclusive) and read the
// pre-aggregated Postgres tables — never the raw DynamoDB events.
export class AdminMetricsRepository {
  overviewSeries(from: string, to: string) {
    return dbQuery(
      `SELECT day, active_users, new_signups, logins,
              listing_views_total, listing_views_stay, listing_views_service, listing_views_transport,
              searches, card_clicks, booking_modal_opens, payment_starts,
              bookings_confirmed, call_clicks, message_clicks, revenue_paise,
              bookings_cancelled, refund_paise, reviews_submitted, reviews_rating_sum,
              coupons_applied, coupons_failed, discount_paise, wishlist_adds, wishlist_removes,
              new_listings, active_providers, ai_messages, fraud_signals, fraud_critical
         FROM analytics_daily_overview
        WHERE day BETWEEN $1 AND $2
        ORDER BY day ASC`,
      [from, to],
    );
  }

  funnelByType(from: string, to: string) {
    return dbQuery(
      `SELECT listing_type,
              SUM(views)          AS views,
              SUM(card_clicks)    AS card_clicks,
              SUM(modal_opens)    AS modal_opens,
              SUM(payment_starts) AS payment_starts,
              SUM(bookings)       AS bookings,
              SUM(revenue_paise)  AS revenue_paise
         FROM analytics_daily_funnel
        WHERE day BETWEEN $1 AND $2
        GROUP BY listing_type
        ORDER BY listing_type ASC`,
      [from, to],
    );
  }

  topCities(from: string, to: string, limit: number) {
    return dbQuery(
      `SELECT city, SUM(bookings) AS bookings, SUM(revenue_paise) AS revenue_paise
         FROM analytics_daily_geo
        WHERE day BETWEEN $1 AND $2
        GROUP BY city
        ORDER BY bookings DESC, revenue_paise DESC
        LIMIT $3`,
      [from, to, limit],
    );
  }

  topChannels(from: string, to: string, limit: number) {
    return dbQuery(
      `SELECT channel, SUM(sessions) AS sessions, SUM(signups) AS signups
         FROM analytics_daily_acquisition
        WHERE day BETWEEN $1 AND $2
        GROUP BY channel
        ORDER BY sessions DESC, signups DESC
        LIMIT $3`,
      [from, to, limit],
    );
  }

  /** Latest day the nightly rollup has written — the dashboard's "data
   *  through" freshness note. */
  latestRollupDay() {
    return dbQuery(`SELECT MAX(day) AS day FROM analytics_daily_overview`);
  }

  platformTotals(from: string, to: string) {
    return dbQuery(
      `SELECT platform, SUM(events) AS events, MAX(active_users) AS active_users
         FROM analytics_daily_platform
        WHERE day BETWEEN $1 AND $2
        GROUP BY platform
        ORDER BY events DESC`,
      [from, to],
    );
  }

  topSearchTerms(from: string, to: string, limit: number) {
    return dbQuery(
      `SELECT category, term, SUM(count) AS count
         FROM analytics_search_terms
        WHERE day BETWEEN $1 AND $2
        GROUP BY category, term
        ORDER BY count DESC, term ASC
        LIMIT $3`,
      [from, to, limit],
    );
  }

  languageTotals(from: string, to: string) {
    // MAX(active_users) not SUM — daily actives are distinct-per-day and
    // can't be summed across days without double counting (same rule as
    // platformTotals).
    return dbQuery(
      `SELECT language, SUM(events) AS events, MAX(active_users) AS active_users
         FROM analytics_daily_language
        WHERE day BETWEEN $1 AND $2
        GROUP BY language
        ORDER BY events DESC`,
      [from, to],
    );
  }

  topOrigins(from: string, to: string, limit: number) {
    return dbQuery(
      `SELECT origin_city, origin_state, MAX(active_users) AS active_users, SUM(searches) AS searches
         FROM analytics_daily_origin
        WHERE day BETWEEN $1 AND $2
        GROUP BY origin_city, origin_state
        ORDER BY active_users DESC, searches DESC
        LIMIT $3`,
      [from, to, limit],
    );
  }

  topOriginDestPairs(from: string, to: string, limit: number) {
    return dbQuery(
      `SELECT origin_city, dest_city, SUM(modal_opens) AS modal_opens, SUM(payment_starts) AS payment_starts
         FROM analytics_daily_origin_dest
        WHERE day BETWEEN $1 AND $2
        GROUP BY origin_city, dest_city
        ORDER BY payment_starts DESC, modal_opens DESC
        LIMIT $3`,
      [from, to, limit],
    );
  }

  paymentFailureReasons(from: string, to: string) {
    return dbQuery(
      `SELECT reason_code, SUM(count) AS count
         FROM analytics_daily_payment_failures
        WHERE day BETWEEN $1 AND $2
        GROUP BY reason_code
        ORDER BY count DESC`,
      [from, to],
    );
  }

  cancelReasons(from: string, to: string) {
    return dbQuery(
      `SELECT reason, SUM(count) AS count
         FROM analytics_daily_cancel_reasons
        WHERE day BETWEEN $1 AND $2
        GROUP BY reason
        ORDER BY count DESC`,
      [from, to],
    );
  }

  // ── Customer metrics: query-time SQL over the transactional bookings table
  // (small volume; no rollup staleness). "Booked" = confirmed/in_progress/
  // completed. Idempotent reads; idx_bookings_created_at covers the window.

  /** Daily new vs returning bookers. First-ever booking is computed over ALL
   *  history (the CTE is unwindowed), then the series is windowed — so a
   *  customer acquired before the window still counts as returning. */
  newVsReturningDaily(from: string, to: string) {
    return dbQuery(
      `WITH booked AS (
         SELECT user_id, created_at, COALESCE(agreed_price_paise, 0) AS paid_paise,
                MIN(created_at) OVER (PARTITION BY user_id) AS first_at
           FROM bookings
          WHERE status IN ('confirmed','in_progress','completed')
       )
       SELECT created_at::date AS day,
              COUNT(DISTINCT user_id) FILTER (WHERE created_at = first_at)  AS new_bookers,
              COUNT(DISTINCT user_id) FILTER (WHERE created_at > first_at)  AS returning_bookers,
              COALESCE(SUM(paid_paise) FILTER (WHERE created_at = first_at), 0) AS new_revenue_paise,
              COALESCE(SUM(paid_paise) FILTER (WHERE created_at > first_at), 0) AS returning_revenue_paise
         FROM booked
        WHERE created_at::date BETWEEN $1 AND $2
        GROUP BY 1
        ORDER BY 1 ASC`,
      [from, to],
    );
  }

  /** All-time repeat rate + median days between first and second booking. */
  repeatStats() {
    return dbQuery(
      `WITH ranked AS (
         SELECT user_id, created_at,
                ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at) AS rn
           FROM bookings
          WHERE status IN ('confirmed','in_progress','completed')
       ),
       pairs AS (
         SELECT a.user_id,
                EXTRACT(EPOCH FROM (b.created_at - a.created_at)) / 86400.0 AS days_to_second
           FROM ranked a
           JOIN ranked b ON b.user_id = a.user_id AND b.rn = 2
          WHERE a.rn = 1
       )
       SELECT
         (SELECT COUNT(DISTINCT user_id) FROM ranked)                    AS bookers,
         (SELECT COUNT(DISTINCT user_id) FROM ranked WHERE rn >= 2)      AS repeat_bookers,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY days_to_second) FROM pairs) AS median_days_to_second`,
    );
  }

  /** Booking-value histogram over the window (paise band edges). */
  aovBands(from: string, to: string) {
    return dbQuery(
      `SELECT CASE
                WHEN paid < 50000  THEN 'under_500'
                WHEN paid < 100000 THEN '500_1k'
                WHEN paid < 250000 THEN '1k_2_5k'
                WHEN paid < 500000 THEN '2_5k_5k'
                ELSE '5k_plus'
              END AS band,
              COUNT(*) AS bookings
         FROM (
           SELECT COALESCE(agreed_price_paise, 0) AS paid
             FROM bookings
            WHERE status IN ('confirmed','in_progress','completed')
              AND created_at::date BETWEEN $1 AND $2
         ) x
        GROUP BY 1`,
      [from, to],
    );
  }

  /** All-time per-customer kind combinations (stay/service/transport).
   *  Kind rule mirrors bookings.service.ts (isStayBooking / 'driver-'). */
  categoryCrossover() {
    return dbQuery(
      `WITH kinds AS (
         SELECT DISTINCT user_id,
                CASE
                  WHEN lower(COALESCE(service_category, '')) LIKE 'driver-%' THEN 'transport'
                  WHEN lower(COALESCE(service_category, '')) LIKE '%hotel%'
                    OR lower(COALESCE(service_category, '')) LIKE '%homestay%'
                    OR lower(COALESCE(service_category, '')) LIKE 'stay%' THEN 'stay'
                  ELSE 'service'
                END AS kind
           FROM bookings
          WHERE status IN ('confirmed','in_progress','completed')
       )
       SELECT combo, COUNT(*) AS customers
         FROM (
           SELECT user_id, string_agg(kind, '+' ORDER BY kind) AS combo
             FROM kinds
            GROUP BY user_id
         ) t
        GROUP BY combo
        ORDER BY customers DESC`,
    );
  }

  /** Top customers by lifetime revenue from the nightly RFM rollup, joined to
   *  user_profiles for identity (name/email/phone). Contact fields are only
   *  exposed behind requireRole('admin') — same visibility the admin user
   *  search already grants — and only in the detail popup, not the table. */
  topCustomers(limit: number) {
    return dbQuery(
      `SELECT p.user_id, p.first_booking_at, p.last_booking_at, p.bookings_total, p.cancelled_total,
              p.revenue_paise_total, p.favorite_category, p.home_city, p.language, p.acquisition_channel, p.last_active_day,
              up.display_name, up.email, up.phone
         FROM analytics_customer_profiles p
         LEFT JOIN user_profiles up ON up.user_id = p.user_id
        WHERE p.bookings_total > 0
        ORDER BY p.revenue_paise_total DESC, p.bookings_total DESC
        LIMIT $1`,
      [limit],
    );
  }

  // ── Filtered transactional metrics ──────────────────────────────────────
  // Powers the analytics tabs' filterable tiles when a vertical / category /
  // geo / listing filter is active. These read bookings/listings/reviews
  // directly (the rollups carry no such dimensions). Each joins `listings l`
  // so the shared filter can bind against it; the join is on the unique
  // listings PK, so it never fans a booking/review row out.

  /** Daily CONFIRMED bookings + agreed-price revenue for the window. Mirrors
   *  the overview rollup's `bookings_confirmed` semantics, filter-scoped. */
  filteredBookingSeries(from: string, to: string, filter: MetricListingFilter) {
    const f = buildMetricFilter(filter, 2);
    return dbQuery(
      `SELECT b.created_at::date AS day,
              COUNT(*)::int AS bookings,
              COALESCE(SUM(COALESCE(b.agreed_price_paise, 0)), 0)::bigint AS revenue_paise
         FROM bookings b
         LEFT JOIN listings l ON l.id = b.listing_id
        WHERE ${BOOKED}
          AND b.created_at::date BETWEEN $1 AND $2${f.sql}
        GROUP BY 1
        ORDER BY 1 ASC`,
      [from, to, ...f.params],
    );
  }

  /** Daily NEW listings (created in-window) for the Providers tab. */
  filteredNewListingsSeries(from: string, to: string, filter: MetricListingFilter) {
    const f = buildMetricFilter(filter, 2);
    return dbQuery(
      `SELECT l.created_at::date AS day, COUNT(*)::int AS listings
         FROM listings l
        WHERE l.created_at::date BETWEEN $1 AND $2${f.sql}
        GROUP BY 1
        ORDER BY 1 ASC`,
      [from, to, ...f.params],
    );
  }

  /** Distinct active providers, provider revenue, confirmed bookings + reviews
   *  in-window for the filtered Providers tiles. Reviews attach to listings via
   *  reviews.stay_id (TEXT holding the listing uuid); provider-only reviews
   *  (NULL stay_id) can't match a listing filter and drop out — correct here. */
  filteredProviderStats(from: string, to: string, filter: MetricListingFilter) {
    const bf = buildMetricFilter(filter, 2);
    const bookings = dbQuery(
      `SELECT COUNT(DISTINCT l.user_id)::int AS active_providers,
              COUNT(*)::int AS bookings,
              COALESCE(SUM(COALESCE(b.agreed_price_paise, 0)), 0)::bigint AS revenue_paise
         FROM bookings b
         JOIN listings l ON l.id = b.listing_id
        WHERE ${BOOKED}
          AND b.created_at::date BETWEEN $1 AND $2${bf.sql}`,
      [from, to, ...bf.params],
    );
    const rf = buildMetricFilter(filter, 2);
    const reviews = dbQuery(
      `SELECT COUNT(*)::int AS reviews,
              COALESCE(SUM(r.rating), 0)::int AS rating_sum
         FROM reviews r
         JOIN listings l ON l.id::text = r.stay_id
        WHERE r.created_at::date BETWEEN $1 AND $2${rf.sql}`,
      [from, to, ...rf.params],
    );
    return Promise.all([bookings, reviews]);
  }

  /** Top cities by confirmed bookings + revenue, grouped by the LISTING's city
   *  (the rollup groups by booking city, but the rollup has no listing dims to
   *  filter on — so the filtered path attributes demand to the listing city). */
  filteredTopCities(from: string, to: string, limit: number, filter: MetricListingFilter) {
    const f = buildMetricFilter(filter, 4);
    return dbQuery(
      `SELECT initcap(btrim(l.city)) AS city,
              COUNT(*)::int AS bookings,
              COALESCE(SUM(COALESCE(b.agreed_price_paise, 0)), 0)::bigint AS revenue_paise
         FROM bookings b
         JOIN listings l ON l.id = b.listing_id
        WHERE ${BOOKED}
          AND b.created_at::date BETWEEN $1 AND $2
          AND btrim(COALESCE(l.city, '')) <> ''${f.sql}
        GROUP BY 1
        ORDER BY bookings DESC, revenue_paise DESC
        LIMIT $3`,
      [from, to, limit, ...f.params],
    );
  }

  /** Filtered new-vs-returning daily series. "First-ever" is scoped to the
   *  filtered set, so `new` = a customer's first booking WITHIN the filter. */
  filteredNewVsReturningDaily(from: string, to: string, filter: MetricListingFilter) {
    const f = buildMetricFilter(filter, 3);
    return dbQuery(
      `WITH booked AS (
         SELECT b.user_id, b.created_at, COALESCE(b.agreed_price_paise, 0) AS paid_paise,
                MIN(b.created_at) OVER (PARTITION BY b.user_id) AS first_at
           FROM bookings b
           LEFT JOIN listings l ON l.id = b.listing_id
          WHERE ${BOOKED}${f.sql}
       )
       SELECT created_at::date AS day,
              COUNT(DISTINCT user_id) FILTER (WHERE created_at = first_at)  AS new_bookers,
              COUNT(DISTINCT user_id) FILTER (WHERE created_at > first_at)  AS returning_bookers,
              COALESCE(SUM(paid_paise) FILTER (WHERE created_at = first_at), 0) AS new_revenue_paise,
              COALESCE(SUM(paid_paise) FILTER (WHERE created_at > first_at), 0) AS returning_revenue_paise
         FROM booked
        WHERE created_at::date BETWEEN $1 AND $2
        GROUP BY 1
        ORDER BY 1 ASC`,
      [from, to, ...f.params],
    );
  }

  /** Filtered booking-value histogram. */
  filteredAovBands(from: string, to: string, filter: MetricListingFilter) {
    const f = buildMetricFilter(filter, 3);
    return dbQuery(
      `SELECT CASE
                WHEN paid < 50000  THEN 'under_500'
                WHEN paid < 100000 THEN '500_1k'
                WHEN paid < 250000 THEN '1k_2_5k'
                WHEN paid < 500000 THEN '2_5k_5k'
                ELSE '5k_plus'
              END AS band,
              COUNT(*) AS bookings
         FROM (
           SELECT COALESCE(b.agreed_price_paise, 0) AS paid
             FROM bookings b
             LEFT JOIN listings l ON l.id = b.listing_id
            WHERE ${BOOKED}
              AND b.created_at::date BETWEEN $1 AND $2${f.sql}
         ) x
        GROUP BY 1`,
      [from, to, ...f.params],
    );
  }

  /** Filtered all-time category crossover (kind combos among customers with at
   *  least one booking matching the filter). */
  filteredCrossover(filter: MetricListingFilter) {
    const f = buildMetricFilter(filter, 1);
    return dbQuery(
      `WITH kinds AS (
         SELECT DISTINCT b.user_id,
                CASE
                  WHEN lower(COALESCE(b.service_category, '')) LIKE 'driver-%' THEN 'transport'
                  WHEN lower(COALESCE(b.service_category, '')) LIKE '%hotel%'
                    OR lower(COALESCE(b.service_category, '')) LIKE '%homestay%'
                    OR lower(COALESCE(b.service_category, '')) LIKE 'stay%' THEN 'stay'
                  ELSE 'service'
                END AS kind
           FROM bookings b
           LEFT JOIN listings l ON l.id = b.listing_id
          WHERE ${BOOKED}${f.sql}
       )
       SELECT combo, COUNT(*) AS customers
         FROM (
           SELECT user_id, string_agg(kind, '+' ORDER BY kind) AS combo
             FROM kinds
            GROUP BY user_id
         ) t
        GROUP BY combo
        ORDER BY customers DESC`,
      f.params,
    );
  }

  /** Filtered top customers, sourced LIVE from in-window bookings (the nightly
   *  profile rollup can't be sliced by listing dims). Profile-only columns
   *  (favorite/home city/language/channel/last active) aren't available here
   *  and come back NULL — the table renders them as "—". */
  filteredTopCustomers(from: string, to: string, limit: number, filter: MetricListingFilter) {
    const f = buildMetricFilter(filter, 4);
    return dbQuery(
      `SELECT b.user_id,
              MIN(b.created_at) AS first_booking_at,
              MAX(b.created_at) AS last_booking_at,
              COUNT(*) FILTER (WHERE ${BOOKED})::int AS bookings_total,
              COUNT(*) FILTER (WHERE b.status = 'cancelled')::int AS cancelled_total,
              COALESCE(SUM(COALESCE(b.agreed_price_paise, 0)) FILTER (WHERE ${BOOKED}), 0)::bigint AS revenue_paise_total,
              up.display_name, up.email, up.phone
         FROM bookings b
         JOIN listings l ON l.id = b.listing_id
         LEFT JOIN user_profiles up ON up.user_id = b.user_id
        WHERE b.created_at::date BETWEEN $1 AND $2${f.sql}
        GROUP BY b.user_id, up.display_name, up.email, up.phone
       HAVING COUNT(*) FILTER (WHERE ${BOOKED}) > 0
        ORDER BY revenue_paise_total DESC, bookings_total DESC
        LIMIT $3`,
      [from, to, limit, ...f.params],
    );
  }
}

export const adminMetricsRepository = new AdminMetricsRepository();
