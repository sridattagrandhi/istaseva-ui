import { query } from '../../../common/db/postgres.js';
import { buildMetricFilter, type MetricListingFilter } from './admin-metric-filters.js';

// Revenue drill-down for the admin Revenue tab. Unlike the day-keyed
// analytics rollups (which carry no dimensions), these read the
// TRANSACTIONAL source of truth — payments joined to bookings/listings —
// so revenue can be sliced by any listing attribute without dimensioning
// every rollup table. Volumes are admin-query sized; no caching needed.
//
// Money attribution: a payment counts once it reached 'completed' (later
// refunds keep status 'refunded' but the gross still happened), dated by
// completed_at. Refunds ride along as refund_paise on the same rows.

/** Whitelisted GROUP BY dimensions — NEVER interpolate user input here. */
const DIMS = {
  type: "COALESCE(l.listing_type, 'unknown')",
  category: "COALESCE(NULLIF(btrim(COALESCE(b.service_category, l.category)), ''), 'other')",
  city: "COALESCE(NULLIF(initcap(btrim(l.city)), ''), 'Unknown')",
  state: "COALESCE(NULLIF(initcap(btrim(l.state)), ''), 'Unknown')",
  host: "COALESCE(NULLIF(btrim(u.display_name), ''), 'Unknown host')",
} as const;

export type RevenueDim = keyof typeof DIMS;
export const REVENUE_DIMS = Object.keys(DIMS) as RevenueDim[];

/** Resolve a dimension to its whitelisted SQL fragment, or throw. Belt-and-
 *  suspenders: callers are type-checked and enum-validated upstream, but a bad
 *  string reaching DIMS[dim] would otherwise splice `undefined` (or an inherited
 *  property like `constructor`) into the SQL. Membership is checked against
 *  REVENUE_DIMS (own keys only) so only the five known fragments can be used. */
function dimExpr(dim: RevenueDim): string {
  if (!REVENUE_DIMS.includes(dim)) {
    throw new Error(`Unknown revenue dimension: ${String(dim)}`);
  }
  return DIMS[dim];
}

const BASE = `
  FROM payments p
  JOIN bookings b ON b.id = p.booking_id
  LEFT JOIN listings l ON l.id = b.listing_id
  LEFT JOIN user_profiles u ON u.user_id = l.user_id
  WHERE p.status IN ('completed', 'refunded')
    AND COALESCE(p.completed_at, p.created_at) >= $1::date
    AND COALESCE(p.completed_at, p.created_at) < ($2::date + INTERVAL '1 day')
`;

export interface RevenueBreakdownRow {
  key: string;
  bookings: number;
  gross_paise: string;
  refund_paise: string;
}

export interface RevenueSeriesRow {
  day: string;
  bookings: number;
  gross_paise: string;
  segment_paise: string | null;
}

export interface RevenueListingRow {
  listing_id: string;
  name: string;
  listing_type: string | null;
  city: string | null;
  bookings: number;
  gross_paise: string;
  refund_paise: string;
}

export interface RevenueTotalsRow {
  bookings: number;
  refunded_bookings: number;
  gross_paise: string;
  refund_paise: string;
  discount_paise: string;
  subtotal_paise: string;
  platform_fee_paise: string;
  taxes_paise: string;
  insurance_paise: string;
}

export const adminRevenueRepository = {
  /** Window totals — the Revenue tab's KPI row (and Overview's revenue tile).
   *  Same source as the drill-down panels so the page is self-consistent.
   *  The composition columns (subtotal/fee/tax/insurance/discount) come from
   *  the per-payment snapshots added 2026-05-15; legacy rows have NULLs and
   *  simply contribute 0, so composition can undercount gross on old data. */
  async totals(from: string, to: string, filter?: MetricListingFilter) {
    // Same listing-scoped filter the analytics tabs use. Category matches the
    // listing's own category (l.category) — the value the facet dropdown offers
    // — not the differently-prefixed booking snapshot.
    const f = filter
      ? buildMetricFilter(filter, 2)
      : { sql: '', params: [] as unknown[] };
    const result = await query<RevenueTotalsRow>(
      `SELECT COUNT(DISTINCT b.id)::int AS bookings,
              COUNT(DISTINCT b.id) FILTER (WHERE COALESCE(p.refund_paise, 0) > 0)::int AS refunded_bookings,
              COALESCE(SUM(p.amount_paise), 0)::bigint AS gross_paise,
              COALESCE(SUM(COALESCE(p.refund_paise, 0)), 0)::bigint AS refund_paise,
              COALESCE(SUM(COALESCE(p.discount_paise, 0)), 0)::bigint AS discount_paise,
              COALESCE(SUM(COALESCE(p.subtotal_paise, 0)), 0)::bigint AS subtotal_paise,
              COALESCE(SUM(COALESCE(p.platform_fee_paise, 0)), 0)::bigint AS platform_fee_paise,
              COALESCE(SUM(COALESCE(p.taxes_paise, 0)), 0)::bigint AS taxes_paise,
              COALESCE(SUM(COALESCE(p.insurance_premium_paise, 0)), 0)::bigint AS insurance_paise
       ${BASE}${f.sql}`,
      [from, to, ...f.params]
    );
    return result.rows[0];
  },

  /** Paid revenue grouped by one listing dimension, biggest first. */
  async breakdown(from: string, to: string, dim: RevenueDim, limit: number) {
    const result = await query<RevenueBreakdownRow>(
      `SELECT ${dimExpr(dim)} AS key,
              COUNT(DISTINCT b.id)::int AS bookings,
              COALESCE(SUM(p.amount_paise), 0)::bigint AS gross_paise,
              COALESCE(SUM(COALESCE(p.refund_paise, 0)), 0)::bigint AS refund_paise
       ${BASE}
       GROUP BY 1
       ORDER BY gross_paise DESC, bookings DESC
       LIMIT $3`,
      [from, to, limit]
    );
    return result.rows;
  },

  /**
   * Daily paid revenue; when a segment (dim + key) is given the same query
   * also returns that segment's slice per day so the chart can overlay
   * "segment vs all" from one round trip.
   */
  async series(from: string, to: string, segment?: { dim: RevenueDim; key: string }) {
    const segmentCol = segment
      ? `, COALESCE(SUM(p.amount_paise) FILTER (WHERE lower(${dimExpr(segment.dim)}) = lower($3)), 0)::bigint AS segment_paise`
      : `, NULL AS segment_paise`;
    const params: unknown[] = segment ? [from, to, segment.key] : [from, to];
    const result = await query<RevenueSeriesRow>(
      `SELECT to_char(COALESCE(p.completed_at, p.created_at)::date, 'YYYY-MM-DD') AS day,
              COUNT(DISTINCT b.id)::int AS bookings,
              COALESCE(SUM(p.amount_paise), 0)::bigint AS gross_paise
              ${segmentCol}
       ${BASE}
       GROUP BY 1
       ORDER BY 1`,
      params
    );
    return result.rows;
  },

  /** Top listings by paid revenue, optionally narrowed to a segment. */
  async topListings(from: string, to: string, limit: number, segment?: { dim: RevenueDim; key: string }) {
    const filter = segment ? `AND lower(${dimExpr(segment.dim)}) = lower($4)` : '';
    const params: unknown[] = segment ? [from, to, limit, segment.key] : [from, to, limit];
    const result = await query<RevenueListingRow>(
      `SELECT b.listing_id,
              COALESCE(NULLIF(l.name, ''), NULLIF(l.title, ''), 'Untitled') AS name,
              l.listing_type, l.city,
              COUNT(DISTINCT b.id)::int AS bookings,
              COALESCE(SUM(p.amount_paise), 0)::bigint AS gross_paise,
              COALESCE(SUM(COALESCE(p.refund_paise, 0)), 0)::bigint AS refund_paise
       ${BASE}
         AND b.listing_id IS NOT NULL
         ${filter}
       GROUP BY 1, 2, 3, 4
       ORDER BY gross_paise DESC, bookings DESC
       LIMIT $3`,
      params
    );
    return result.rows;
  },
};
