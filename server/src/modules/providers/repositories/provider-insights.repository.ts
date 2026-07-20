import { dbQuery } from '../../../common/repositories/database.js';

export type InsightsCategory = 'stay' | 'service' | 'transport';

/**
 * Booking category classification — mirrors the partner dashboards' own
 * client-side filters exactly (Host: serviceCategory starts with "stay",
 * Transport: starts with "driver-", Provider: everything else), falling back
 * to the typed listings.listing_type column only when service_category is
 * missing. Keeping the two in agreement matters: the Insights tab renders
 * next to booking lists filtered with the client rule, and the numbers must
 * match what the partner sees there.
 */
const CAT_EXPR = `CASE
    WHEN b.service_category ILIKE 'stay%' THEN 'stay'
    WHEN b.service_category ILIKE 'driver-%' THEN 'transport'
    WHEN b.service_category IS NOT NULL THEN 'service'
    ELSE COALESCE(l.listing_type, 'service')
  END`;

// Every booking query is scoped to the calling partner's provider_profiles.id
// FIRST ($1) — the category/date params only ever narrow within that. This is
// the authorization boundary: nothing here may return another partner's rows.
const BASE = `FROM bookings b
  LEFT JOIN listings l ON l.id = b.listing_id
  WHERE b.provider_id = $1 AND ${CAT_EXPR} = $2`;

export class ProviderInsightsRepository {
  /** Bookings received per day (by created_at), with the cancelled share. */
  bookingSeries(providerId: string, category: InsightsCategory, from: string, to: string) {
    return dbQuery<{ day: string; total: string; cancelled: string }>(
      `SELECT TO_CHAR(b.created_at::date, 'YYYY-MM-DD') AS day,
              COUNT(*)::bigint AS total,
              COUNT(*) FILTER (WHERE b.status = 'cancelled')::bigint AS cancelled
       ${BASE}
         AND b.created_at::date BETWEEN $3::date AND $4::date
       GROUP BY 1 ORDER BY 1`,
      [providerId, category, from, to],
    );
  }

  statusMix(providerId: string, category: InsightsCategory, from: string, to: string) {
    return dbQuery<{ status: string; count: string }>(
      `SELECT b.status::text AS status, COUNT(*)::bigint AS count
       ${BASE}
         AND b.created_at::date BETWEEN $3::date AND $4::date
       GROUP BY 1 ORDER BY 2 DESC`,
      [providerId, category, from, to],
    );
  }

  /** Windowed on when the cancellation happened, not when the booking was made. */
  cancelReasons(providerId: string, category: InsightsCategory, from: string, to: string) {
    return dbQuery<{ reason: string; count: string }>(
      `SELECT COALESCE(NULLIF(TRIM(b.cancellation_reason), ''), 'unspecified') AS reason,
              COUNT(*)::bigint AS count
       ${BASE}
         AND b.status = 'cancelled'
         AND COALESCE(b.cancelled_at, b.created_at)::date BETWEEN $3::date AND $4::date
       GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      [providerId, category, from, to],
    );
  }

  /**
   * Failed payment attempts against this partner's bookings, from the
   * transactional payments table (fresher than the platform-wide analytics
   * rollup, and scopable — the rollup is keyed (day, reason) only).
   */
  paymentFailures(providerId: string, category: InsightsCategory, from: string, to: string) {
    return dbQuery<{ reason: string; count: string }>(
      `SELECT COALESCE(NULLIF(TRIM(p.failed_reason), ''), 'unknown') AS reason,
              COUNT(*)::bigint AS count
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       LEFT JOIN listings l ON l.id = b.listing_id
       WHERE b.provider_id = $1 AND ${CAT_EXPR} = $2
         AND p.status = 'failed'
         AND p.created_at::date BETWEEN $3::date AND $4::date
       GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      [providerId, category, from, to],
    );
  }

  /**
   * Repeat customers among bookings created in the window (kept bookings
   * only), plus the median days between a customer's first and second one —
   * the same shape the admin Customers page computes platform-wide.
   */
  repeatStats(providerId: string, category: InsightsCategory, from: string, to: string) {
    return dbQuery<{ bookers: string; repeat_bookers: string; median_days_to_second: string | null }>(
      `WITH booked AS (
         SELECT b.user_id, b.created_at,
                ROW_NUMBER() OVER (PARTITION BY b.user_id ORDER BY b.created_at) AS rn
         ${BASE}
           AND b.status IN ('confirmed', 'in_progress', 'completed')
           AND b.created_at::date BETWEEN $3::date AND $4::date
       ), pairs AS (
         SELECT EXTRACT(EPOCH FROM (s.created_at - f.created_at)) / 86400.0 AS days_to_second
         FROM booked f
         JOIN booked s ON s.user_id = f.user_id AND f.rn = 1 AND s.rn = 2
       )
       SELECT (SELECT COUNT(DISTINCT user_id) FROM booked)::bigint AS bookers,
              (SELECT COUNT(DISTINCT user_id) FROM booked WHERE rn >= 2)::bigint AS repeat_bookers,
              (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY days_to_second) FROM pairs)::text AS median_days_to_second`,
      [providerId, category, from, to],
    );
  }

  /** How far ahead customers book: scheduled_date minus booking creation. */
  leadTime(providerId: string, category: InsightsCategory, from: string, to: string) {
    return dbQuery<{ median_days: string | null; avg_days: string | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (b.scheduled_date - b.created_at::date))::text AS median_days,
              AVG(b.scheduled_date - b.created_at::date)::text AS avg_days
       ${BASE}
         AND b.status NOT IN ('expired')
         AND b.created_at::date BETWEEN $3::date AND $4::date`,
      [providerId, category, from, to],
    );
  }

  /**
   * When demand lands: kept bookings bucketed by scheduled day-of-week ×
   * start hour. `dow` is ISO (1=Mon..7=Sun); `hour` is NULL when the booking
   * has no start_time (stays — the client renders weekday bars instead).
   * Note: day/package transport bookings carry the working-window start as
   * start_time, not a true pickup hour.
   */
  demandHeatmap(providerId: string, category: InsightsCategory, from: string, to: string) {
    return dbQuery<{ dow: string; hour: string | null; count: string }>(
      `SELECT EXTRACT(ISODOW FROM b.scheduled_date)::int AS dow,
              EXTRACT(HOUR FROM b.start_time)::int AS hour,
              COUNT(*)::bigint AS count
       ${BASE}
         AND b.status NOT IN ('cancelled', 'expired')
         AND b.scheduled_date BETWEEN $3::date AND $4::date
       GROUP BY 1, 2`,
      [providerId, category, from, to],
    );
  }

  /**
   * Stay occupancy: room-nights sold per calendar day (each booking expanded
   * across its nights; end_date is checkout-exclusive) with the booking's
   * charge allocated evenly per night for ADR. Kept bookings only.
   */
  stayOccupancy(providerId: string, from: string, to: string) {
    return dbQuery<{ day: string; room_nights: string; revenue_paise: string }>(
      `SELECT TO_CHAR(d.day::date, 'YYYY-MM-DD') AS day,
              SUM(COALESCE(b.room_count, 1))::bigint AS room_nights,
              SUM(ROUND(
                COALESCE(pay.amount_paise, b.agreed_price_paise, 0)::numeric
                / GREATEST(COALESCE(b.end_date, b.scheduled_date + 1) - b.scheduled_date, 1)
              ))::bigint AS revenue_paise
       FROM bookings b
       LEFT JOIN listings l ON l.id = b.listing_id
       LEFT JOIN LATERAL (
         SELECT amount_paise FROM payments
         WHERE booking_id = b.id AND status = 'completed'
         ORDER BY completed_at DESC NULLS LAST, created_at DESC
         LIMIT 1
       ) pay ON true
       JOIN LATERAL generate_series(
         b.scheduled_date::timestamp,
         (COALESCE(b.end_date, b.scheduled_date + 1) - 1)::timestamp,
         interval '1 day'
       ) AS d(day) ON true
       WHERE b.provider_id = $1 AND ${CAT_EXPR} = $2
         AND b.status IN ('confirmed', 'in_progress', 'completed')
         AND d.day::date BETWEEN $3::date AND $4::date
       GROUP BY 1 ORDER BY 1`,
      [providerId, 'stay', from, to],
    );
  }

  /**
   * Sellable room inventory across the caller's stay listings (ownership
   * scope, same as the funnel). Listings without room types count as one
   * unit — a homestay booked whole is still one sellable "room".
   */
  stayRoomInventory(userId: string) {
    return dbQuery<{ rooms: string }>(
      `SELECT COALESCE(SUM(rooms), 0)::bigint AS rooms
       FROM (
         SELECT COALESCE(NULLIF(SUM(rt.quantity), 0), 1) AS rooms
         FROM listings l
         LEFT JOIN listing_room_types rt ON rt.listing_id = l.id
         WHERE l.user_id = $1 AND l.listing_type = 'stay'
           AND COALESCE(l.status, 'active') NOT IN ('banned', 'suspended', 'inactive', 'paused', 'rejected')
         GROUP BY l.id
       ) per_listing`,
      [userId],
    );
  }

  /**
   * Transport demand shape from the booking notes JSON (bookings capture only
   * a pickup — no drop/destination exists in the schema, so "routes" aren't
   * derivable). `pickup` areas group on the address's first comma component;
   * `mode` is the trip type (cab/hourly/day/package). The regex guard skips
   * legacy free-text notes that aren't JSON.
   */
  transportDemand(providerId: string, from: string, to: string) {
    return dbQuery<{ kind: string; label: string; count: string }>(
      `WITH t AS (
         SELECT CASE WHEN b.notes ~ '^\\s*\\{' THEN b.notes::jsonb ELSE NULL END AS nj
         ${BASE}
           AND b.status NOT IN ('cancelled', 'expired')
           AND b.scheduled_date BETWEEN $3::date AND $4::date
       )
       (SELECT 'pickup' AS kind,
               LOWER(TRIM(SPLIT_PART(nj->>'pickup', ',', 1))) AS label,
               COUNT(*)::bigint AS count
        FROM t WHERE COALESCE(TRIM(nj->>'pickup'), '') <> ''
        GROUP BY 2 ORDER BY 3 DESC LIMIT 8)
       UNION ALL
       (SELECT 'mode' AS kind,
               COALESCE(NULLIF(TRIM(nj->>'mode'), ''), 'other') AS label,
               COUNT(*)::bigint AS count
        FROM t WHERE nj IS NOT NULL
        GROUP BY 2 ORDER BY 3 DESC)`,
      [providerId, 'transport', from, to],
    );
  }

  /**
   * Category-level search demand from the platform rollup. Deliberately NOT
   * partner-scoped — searches aren't listing-attributable pre-click, so this
   * is the one "your category, not your listings" panel. Read-only aggregate.
   *
   * `keywords` (optional) narrows the platform terms to the caller's own
   * niche — terms containing any of their listing-derived keywords. The
   * filter runs BEFORE the top-N cut so a salon owner sees the top salon
   * searches, not whatever salon terms survived a global top 10.
   */
  searchDemand(category: InsightsCategory, from: string, to: string, keywords?: string[]) {
    const params: unknown[] = [category, from, to];
    let filter = '';
    if (keywords && keywords.length > 0) {
      // Escape LIKE metacharacters — keywords come from listing text.
      params.push(keywords.map((k) => `%${k.replace(/[\\%_]/g, '\\$&')}%`));
      filter = ` AND term ILIKE ANY($4)`;
    }
    return dbQuery<{ term: string; count: string }>(
      `SELECT term, SUM(count)::bigint AS count
       FROM analytics_search_terms
       WHERE category = $1 AND day BETWEEN $2::date AND $3::date${filter}
       GROUP BY term ORDER BY 2 DESC LIMIT 10`,
      params,
    );
  }

  /**
   * The caller's own listing text + places, feeding the search-demand
   * relevance filters. Ownership scope (listings.user_id), same as the
   * funnel; only active-ish listings count so a banned listing can't keep
   * steering the panel.
   */
  ownerListingProfile(userId: string, category: InsightsCategory) {
    // service_categories lives on provider_profiles (the profile-level
    // subtype list), not on listings — join it in as an extra keyword source.
    return dbQuery<{ name: string | null; category: string | null; service_categories: string[] | null; city: string | null; state: string | null }>(
      `SELECT l.name, l.category, p.service_categories, l.city, l.state
       FROM listings l
       LEFT JOIN provider_profiles p ON p.user_id = l.user_id
       WHERE l.user_id = $1 AND l.listing_type = $2
         AND COALESCE(l.status, 'active') NOT IN ('banned', 'suspended', 'inactive', 'paused', 'rejected')`,
      [userId, category],
    );
  }

  /**
   * Where customers are searching, from the place rollup (stay searches are
   * mostly place-picked and carry no term). Filtered to the caller's own
   * operating cities/states — regions are stored lowercased at rollup time.
   */
  searchPlaceDemand(category: InsightsCategory, from: string, to: string, cities: string[], states: string[]) {
    return dbQuery<{ region_type: string; region: string; count: string }>(
      `SELECT region_type, region, SUM(count)::bigint AS count
       FROM analytics_search_places
       WHERE category = $1 AND day BETWEEN $2::date AND $3::date
         AND ((region_type = 'city' AND region = ANY($4)) OR (region_type = 'state' AND region = ANY($5)))
       GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`,
      [category, from, to, cities, states],
    );
  }

  /**
   * Per-listing discovery→booking funnel, scoped by listing OWNERSHIP
   * (listings.user_id = the caller) — the rollup table itself has no owner
   * column, so the join is the authorization boundary here.
   */
  listingFunnel(userId: string, category: InsightsCategory, from: string, to: string) {
    return dbQuery<{
      listing_id: string; name: string; views: string; card_clicks: string;
      modal_opens: string; payment_starts: string; bookings: string;
    }>(
      `SELECT f.listing_id,
              COALESCE(l.name, 'Listing') AS name,
              SUM(f.views)::bigint AS views,
              SUM(f.card_clicks)::bigint AS card_clicks,
              SUM(f.modal_opens)::bigint AS modal_opens,
              SUM(f.payment_starts)::bigint AS payment_starts,
              SUM(f.bookings)::bigint AS bookings
       FROM analytics_daily_listing_funnel f
       JOIN listings l ON l.id = f.listing_id
       WHERE l.user_id = $1 AND l.listing_type = $2
         AND f.day BETWEEN $3::date AND $4::date
       GROUP BY f.listing_id, l.name
       ORDER BY views DESC`,
      [userId, category, from, to],
    );
  }
}

export const providerInsightsRepository = new ProviderInsightsRepository();
