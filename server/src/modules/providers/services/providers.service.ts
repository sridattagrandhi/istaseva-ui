import { NotFoundError, ValidationError } from '../../../common/errors/app-error.js';
import { providersRepository } from '../repositories/providers.repository.js';
import { providerInsightsRepository, type InsightsCategory } from '../repositories/provider-insights.repository.js';
import { providerProfileUpsertSchema } from '../schemas/provider-profile.schema.js';
import { dbQuery } from '../../../common/repositories/database.js';

const EARNINGS_RANGES: Record<string, number> = { '30d': 30, '90d': 90, '365d': 365 };

// ── Search-demand relevance (Insights tab) ─────────────────────────────────
// Generic tokens that would match half the search log and tell the partner
// nothing about their niche. Keyword sources are listing category/subtype
// slugs and listing names, so this list only needs to cover slug filler and
// common brand-name glue words.
const KEYWORD_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'near', 'best', 'top', 'new', 'good', 'home', 'india',
  'service', 'services', 'other', 'others', 'misc', 'general', 'day', 'full', 'per',
]);

/**
 * Niche keywords from the caller's own listings: category + service subtype
 * slugs (split on non-alphanumerics) plus listing-name words. Lowercased,
 * deduped, stopword-filtered, capped so the SQL pattern list stays small.
 */
function deriveNicheKeywords(
  rows: Array<{ name: string | null; category: string | null; service_categories: string[] | null }>,
): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const sources = [r.category ?? '', ...(r.service_categories ?? []), r.name ?? ''];
    for (const src of sources) {
      // Split on anything that isn't a letter/number/combining mark (any
      // script — listing names can be in Indic scripts).
      for (const tok of src.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u)) {
        if (tok.length >= 3 && !KEYWORD_STOPWORDS.has(tok)) out.add(tok);
      }
    }
  }
  return [...out].slice(0, 50);
}

/** Distinct, lowercased, non-empty values — city/state lists for the place filter. */
function uniqueLower(values: Array<string | null>): string[] {
  return [...new Set(values.map((v) => (v ?? '').trim().toLowerCase()).filter(Boolean))];
}

export class ProvidersService {
  async getMyProfile(userId: string) {
    const result = await providersRepository.getByUserId(userId);
    if (!result.rows[0]) throw new NotFoundError('Provider profile', userId);
    return { data: result.rows[0] };
  }

  async getByUserId(userId: string) {
    const result = await providersRepository.getByUserId(userId);
    if (!result.rows[0]) throw new NotFoundError('Provider profile', userId);
    return { data: { display_name: result.rows[0].display_name, user_id: result.rows[0].user_id } };
  }

  async createProfile(userId: string, payload: Record<string, unknown>) {
    const parsed = providerProfileUpsertSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ValidationError(`Invalid provider profile payload: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }
    const result = await providersRepository.create(userId, parsed.data as Record<string, unknown>);
    return { data: result.rows[0] };
  }

  /**
   * Earnings time series for the calling provider over the requested rolling
   * window. Points are daily for windows up to ~4 months and calendar-month
   * buckets beyond that (1yr / all-time), zero-filled so the x-axis stays
   * continuous even on slow days. Each point carries its bucket-start `date`
   * (ISO) so clients can render a real dated axis.
   *
   * `type` scopes everything (series, byListing, allTime, totals) to one
   * marketplace vertical using the same service_category classification as
   * the clients' bookingKindOf (src/lib/booking-kind.ts / mobile kindOf) —
   * the dashboards are split per vertical, so a cab+salon owner's transport
   * earnings must not leak into their services dashboard.
   */
  async getMyEarnings(userId: string, opts: { range?: string; from?: string; to?: string; listingId?: string; type?: 'stay' | 'service' | 'transport' }) {
    const range = opts.range ?? '30d';
    const listingId = opts.listingId;
    const provider = await providersRepository.getByUserId(userId);
    const providerId = provider.rows[0]?.id;
    if (!providerId) {
      return { data: { range, from: null as string | null, to: null as string | null, series: [], byListing: [], allTime: 0, allTimeNet: 0, totals: { earnings: 0, bookings: 0, commission: 0, net: 0, refunds: 0, discounts: 0, avgRating: null as number | null } } };
    }

    // Resolve the [from, to] window. Explicit ISO dates win; otherwise fall
    // back to the legacy "last N days" window. `from` may be null = all-time
    // (used by the "All" range).
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const to = opts.to || iso(today);
    let from: string | null;
    if (opts.from) {
      from = opts.from;
    } else if (range === 'all') {
      from = null;
    } else {
      const days = EARNINGS_RANGES[range] ?? EARNINGS_RANGES['30d'];
      const f = new Date(today); f.setUTCDate(f.getUTCDate() - (days - 1));
      from = iso(f);
    }

    // "Effectively completed" = the service has been delivered. The DB never
    // flips confirmed -> completed (no job does it), so a past-dated
    // confirmed/in_progress booking is earned revenue. Mirrors the
    // findEligibleBookingForReview predicate so earnings match the Bookings UI.
    const EFFb = `(b.status = 'completed' OR (b.status IN ('confirmed','in_progress') AND b.scheduled_date < CURRENT_DATE))`;
    const winB = `b.scheduled_date <= $2::date AND ($3::date IS NULL OR b.scheduled_date >= $3::date)`;
    // Earned amount = the actual completed-payment total (base + fees + GST +
    // the flat insurance premium) when present, else the agreed price. Mirrors
    // the web dashboard's amountFor so both surfaces show the same number.
    const payJoin = `LEFT JOIN LATERAL (
        SELECT amount_paise, refund_paise FROM payments
        WHERE booking_id = b.id AND status IN ('completed', 'refunded')
        ORDER BY completed_at DESC NULLS LAST, created_at DESC
        LIMIT 1
      ) pay ON true`;
    const AMT = `COALESCE(pay.amount_paise, b.agreed_price_paise)`;
    // Platform commission snapshotted on the booking at hold time (admin
    // Fees panel, business audience). NULL on legacy/pre-panel bookings and
    // wherever resolution fell back — both mean "no commission", so 0.
    // net = gross − commission is what the partner actually keeps once
    // payout deduction goes live; surfacing it now keeps partners' numbers
    // from jumping the day money movement starts.
    const COMM = `COALESCE(b.commission_paise, 0)`;

    // Vertical scoping — SQL mirror of the clients' bookingKindOf. Order
    // matters: transport wins over stay wins over service, and a NULL/empty
    // category classifies as "service", exactly like the client helper.
    // `opts.type` is whitelisted in the controller; these are static
    // fragments, no user input is interpolated.
    const CAT = `LOWER(COALESCE(b.service_category, ''))`;
    const CAT_TRANSPORT = `(${CAT} LIKE 'driver%' OR ${CAT} ~ '(cab|auto|van)')`;
    const CAT_STAYISH = `(${CAT} LIKE 'stay%' OR ${CAT} ~ '(homestay|hotel|lodge|village-stay|farm-stay|heritage|sathram)')`;
    const typeF = opts.type === 'transport'
      ? ` AND ${CAT_TRANSPORT}`
      : opts.type === 'stay'
        ? ` AND NOT ${CAT_TRANSPORT} AND ${CAT_STAYISH}`
        : opts.type === 'service'
          ? ` AND NOT ${CAT_TRANSPORT} AND NOT ${CAT_STAYISH}`
          : '';

    // $1 providerId, $2 to, $3 from(or null), [$4 listingId]
    const winParams: unknown[] = [providerId, to, from];
    const lfB = listingId ? ' AND b.listing_id = $4' : '';
    const tsParams = listingId ? [...winParams, listingId] : winParams;

    const earningsRes = await dbQuery<{ day: string; earnings: string; commission: string; refunds: string; discounts: string; bookings: string }>(
      `SELECT TO_CHAR(b.scheduled_date, 'YYYY-MM-DD') AS day,
              COALESCE(SUM(${AMT}), 0)::bigint AS earnings,
              COALESCE(SUM(${COMM}), 0)::bigint AS commission,
              COALESCE(SUM(COALESCE(pay.refund_paise, 0)), 0)::bigint AS refunds,
              COALESCE(SUM(COALESCE(b.discount_paise, 0)), 0)::bigint AS discounts,
              COUNT(*)::bigint AS bookings
       FROM bookings b
       ${payJoin}
       WHERE b.provider_id = $1 AND ${EFFb} AND ${winB}${lfB}${typeF}
       GROUP BY day`,
      tsParams,
    );

    // Per-listing breakdown over the window (all listings, unfiltered) +
    // all-time total (respects the listing filter when one is selected).
    const byListingRes = await dbQuery<{ listing_id: string; name: string; earnings: string; commission: string; bookings: string }>(
      `SELECT b.listing_id,
              COALESCE(l.name, 'Listing') AS name,
              COALESCE(SUM(${AMT}), 0)::bigint AS earnings,
              COALESCE(SUM(${COMM}), 0)::bigint AS commission,
              COUNT(*)::bigint AS bookings
       FROM bookings b
       LEFT JOIN listings l ON l.id = b.listing_id
       ${payJoin}
       WHERE b.provider_id = $1 AND ${EFFb} AND ${winB}${typeF}
       GROUP BY b.listing_id, l.name
       ORDER BY earnings DESC`,
      [providerId, to, from],
    );

    const allTimeRes = await dbQuery<{ earnings: string; commission: string }>(
      `SELECT COALESCE(SUM(${AMT}), 0)::bigint AS earnings,
              COALESCE(SUM(${COMM}), 0)::bigint AS commission
       FROM bookings b
       ${payJoin}
       WHERE b.provider_id = $1 AND ${EFFb}${listingId ? ' AND b.listing_id = $2' : ''}${typeF}`,
      listingId ? [providerId, listingId] : [providerId],
    );

    // Series: honest daily points for windows up to ~4 months, calendar-month
    // buckets beyond that (1yr / all-time) so the line stays readable. Every
    // point carries the bucket-start ISO `date` for the clients' x-axis;
    // `label` is kept for backward compatibility with older app builds.
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const earningsMap = new Map(earningsRes.rows.map((r) => [r.day, { earnings: Number(r.earnings) / 100, commission: Number(r.commission) / 100, refunds: Number(r.refunds) / 100, discounts: Number(r.discounts) / 100, bookings: Number(r.bookings) }]));
    const days = [...earningsMap.keys()].sort();
    const start = from
      ? new Date(from + 'T00:00:00Z')
      : new Date((days[0] ?? to) + 'T00:00:00Z'); // all-time anchors on the first earning day
    const end = new Date(to + 'T00:00:00Z');
    const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
    const monthly = spanDays > 120;

    const series: Array<{ date: string; label: string; earnings: number; bookings: number }> = [];
    let totalEarnings = 0, totalBookings = 0, totalCommission = 0, totalRefunds = 0, totalDiscounts = 0;
    let bucketKey: string | null = null;
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const dayIso = d.toISOString().slice(0, 10);
      const key = monthly ? dayIso.slice(0, 7) : dayIso;
      if (key !== bucketKey) {
        bucketKey = key;
        const label = monthly
          ? `${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`
          : `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
        series.push({ date: dayIso, label, earnings: 0, bookings: 0 });
      }
      const hit = earningsMap.get(dayIso);
      if (hit) {
        const point = series[series.length - 1];
        point.earnings += hit.earnings; point.bookings += hit.bookings;
        totalEarnings += hit.earnings; totalBookings += hit.bookings;
        totalCommission += hit.commission; totalRefunds += hit.refunds; totalDiscounts += hit.discounts;
      }
    }
    for (const point of series) point.earnings = Math.round(point.earnings * 100) / 100;

    const r2 = (n: number) => Math.round(n * 100) / 100;
    const byListing = byListingRes.rows.map((r) => {
      const earnings = r2(Number(r.earnings) / 100);
      const commission = r2(Number(r.commission) / 100);
      return {
        listingId: r.listing_id,
        name: r.name,
        earnings,
        commission,
        net: r2(earnings - commission),
        bookings: Number(r.bookings),
      };
    });
    const allTime = r2(Number(allTimeRes.rows[0]?.earnings ?? 0) / 100);
    const allTimeCommission = r2(Number(allTimeRes.rows[0]?.commission ?? 0) / 100);

    return {
      data: {
        range,
        from,
        to,
        series,
        byListing,
        allTime,
        allTimeNet: r2(allTime - allTimeCommission),
        totals: {
          earnings: r2(totalEarnings),
          bookings: totalBookings,
          commission: r2(totalCommission),
          net: r2(totalEarnings - totalCommission),
          // Statement extras (rupees): refunds sent back on kept bookings, and
          // the discounts baked into the (already post-discount) gross above.
          refunds: r2(totalRefunds),
          discounts: r2(totalDiscounts),
          avgRating: null as number | null,
        },
      },
    };
  }

  /**
   * Partner-scoped analytics for the dashboards' Insights tab: booking volume
   * + cancellations over time, status mix, cancellation reasons, payment
   * failures, repeat-customer rate, booking lead time, category search demand
   * and (when the per-listing rollup has data) the discovery→booking funnel.
   *
   * Everything except searchDemand is scoped server-side to the caller —
   * bookings by their provider_profiles.id, the funnel by listings.user_id.
   * `category` narrows within that scope; it can never widen it.
   */
  async getMyInsights(userId: string, opts: { category?: string; days?: string; from?: string; to?: string }) {
    const category = opts.category;
    if (category !== 'stay' && category !== 'service' && category !== 'transport') {
      throw new ValidationError(`Invalid insights category: ${String(category)}`);
    }
    const cat: InsightsCategory = category;

    // Window: explicit from/to wins; else trailing `days` (default 30),
    // matching the MetricRangePicker's { days } | { from, to } shape.
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const to = opts.to || iso(today);
    let from = opts.from;
    if (!from) {
      const days = Math.min(Math.max(Math.floor(Number(opts.days)) || 30, 1), 3660);
      const f = new Date(today); f.setUTCDate(f.getUTCDate() - (days - 1));
      from = iso(f);
    }
    // Equal-length window immediately before [from, to] — powers the KPI
    // deltas and the dashed prior-period chart overlay (same pattern as the
    // admin dashboard's previousWindow).
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - fromMs) / 86_400_000) + 1;
    const prevTo = iso(new Date(fromMs - 86_400_000));
    const prevFrom = iso(new Date(fromMs - spanDays * 86_400_000));

    const empty = {
      category: cat, from, to,
      series: [] as Array<{ day: string; bookings: number; cancelled: number }>,
      statusMix: [] as Array<{ status: string; count: number }>,
      cancelReasons: [] as Array<{ reason: string; count: number }>,
      paymentFailures: [] as Array<{ reason: string; count: number }>,
      repeat: { bookers: 0, repeatBookers: 0, repeatRate: null as number | null, medianDaysToSecond: null as number | null },
      leadTime: { medianDays: null as number | null, avgDays: null as number | null },
      searchDemand: [] as Array<{ term: string; count: number }>,
      /** 'niche' when terms were narrowed to the caller's listings; 'category' when that narrowing found nothing and the platform list is shown. */
      searchDemandScope: 'category' as 'niche' | 'category',
      searchPlaces: [] as Array<{ regionType: 'city' | 'state'; region: string; count: number }>,
      funnel: {
        totals: { views: 0, cardClicks: 0, modalOpens: 0, paymentStarts: 0, bookings: 0 },
        byListing: [] as Array<{ listingId: string; name: string; views: number; cardClicks: number; modalOpens: number; paymentStarts: number; bookings: number }>,
      },
      prev: {
        from: prevFrom, to: prevTo,
        series: [] as Array<{ day: string; bookings: number; cancelled: number }>,
        repeat: { repeatRate: null as number | null },
        leadTime: { medianDays: null as number | null },
      },
      heatmap: [] as Array<{ dow: number; hour: number | null; count: number }>,
      stay: null as null | {
        rooms: number;
        series: Array<{ day: string; roomNights: number; revenuePaise: number }>;
        totals: { roomNights: number; occupancyPct: number | null; adrPaise: number | null };
        prevTotals: { occupancyPct: number | null; adrPaise: number | null };
      },
      transport: null as null | {
        pickups: Array<{ label: string; count: number }>;
        modes: Array<{ mode: string; count: number }>;
      },
    };

    const provider = await providersRepository.getByUserId(userId);
    const providerId = provider.rows[0]?.id;

    // Relevance profile from the caller's own listings: niche keywords for
    // the term filter, operating cities/states for the place-demand panel.
    const ownListings = await providerInsightsRepository.ownerListingProfile(userId, cat);
    const keywords = deriveNicheKeywords(ownListings.rows);
    const ownCities = uniqueLower(ownListings.rows.map((r) => r.city));
    const ownStates = uniqueLower(ownListings.rows.map((r) => r.state));

    // Search demand + the ownership-joined funnel still make sense for a
    // partner whose provider_profile hasn't been created yet.
    const [series, statusMix, cancelReasons, paymentFailures, repeat, leadTime, searchDemand, funnelRows,
      prevSeries, prevRepeat, prevLeadTime, heatmap, stayOcc, stayOccPrev, stayRooms, transportDemand, searchPlaces] = await Promise.all([
      providerId ? providerInsightsRepository.bookingSeries(providerId, cat, from, to) : null,
      providerId ? providerInsightsRepository.statusMix(providerId, cat, from, to) : null,
      providerId ? providerInsightsRepository.cancelReasons(providerId, cat, from, to) : null,
      providerId ? providerInsightsRepository.paymentFailures(providerId, cat, from, to) : null,
      providerId ? providerInsightsRepository.repeatStats(providerId, cat, from, to) : null,
      providerId ? providerInsightsRepository.leadTime(providerId, cat, from, to) : null,
      providerInsightsRepository.searchDemand(cat, from, to, keywords.length ? keywords : undefined),
      providerInsightsRepository.listingFunnel(userId, cat, from, to),
      providerId ? providerInsightsRepository.bookingSeries(providerId, cat, prevFrom, prevTo) : null,
      providerId ? providerInsightsRepository.repeatStats(providerId, cat, prevFrom, prevTo) : null,
      providerId ? providerInsightsRepository.leadTime(providerId, cat, prevFrom, prevTo) : null,
      providerId ? providerInsightsRepository.demandHeatmap(providerId, cat, from, to) : null,
      providerId && cat === 'stay' ? providerInsightsRepository.stayOccupancy(providerId, from, to) : null,
      providerId && cat === 'stay' ? providerInsightsRepository.stayOccupancy(providerId, prevFrom, prevTo) : null,
      cat === 'stay' ? providerInsightsRepository.stayRoomInventory(userId) : null,
      providerId && cat === 'transport' ? providerInsightsRepository.transportDemand(providerId, from, to) : null,
      ownCities.length || ownStates.length ? providerInsightsRepository.searchPlaceDemand(cat, from, to, ownCities, ownStates) : null,
    ]);

    // Niche filter found nothing (sparse data / no keyword overlap) — fall
    // back to the unfiltered category list so the panel isn't blank, and tell
    // the client which scope it's looking at.
    let searchTerms = searchDemand.rows;
    let searchDemandScope: 'niche' | 'category' = keywords.length ? 'niche' : 'category';
    if (keywords.length && searchTerms.length === 0) {
      searchTerms = (await providerInsightsRepository.searchDemand(cat, from, to)).rows;
      searchDemandScope = 'category';
    }

    const numOrNull = (v: string | null | undefined): number | null => {
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
    };

    const repeatRow = repeat?.rows[0];
    const bookers = Number(repeatRow?.bookers ?? 0);
    const repeatBookers = Number(repeatRow?.repeat_bookers ?? 0);

    const prevRepeatRow = prevRepeat?.rows[0];
    const prevBookers = Number(prevRepeatRow?.bookers ?? 0);
    const prevRepeatBookers = Number(prevRepeatRow?.repeat_bookers ?? 0);

    // Stay occupancy: room-nights ÷ (inventory × days in window). Rates are
    // null when there's no inventory or nothing sold, so the client can show
    // "—" instead of a fake 0%.
    const rooms = Number(stayRooms?.rows[0]?.rooms ?? 0);
    const occTotals = (rows: Array<{ room_nights: string; revenue_paise: string }> | undefined, days: number) => {
      const roomNights = (rows ?? []).reduce((s, r) => s + Number(r.room_nights), 0);
      const revenue = (rows ?? []).reduce((s, r) => s + Number(r.revenue_paise), 0);
      const available = rooms * days;
      return {
        roomNights,
        occupancyPct: available > 0 ? Math.round((roomNights / available) * 1000) / 10 : null,
        adrPaise: roomNights > 0 ? Math.round(revenue / roomNights) : null,
      };
    };

    const byListing = funnelRows.rows.map((r) => ({
      listingId: r.listing_id,
      name: r.name,
      views: Number(r.views),
      cardClicks: Number(r.card_clicks),
      modalOpens: Number(r.modal_opens),
      paymentStarts: Number(r.payment_starts),
      bookings: Number(r.bookings),
    }));

    return {
      data: {
        ...empty,
        series: (series?.rows ?? []).map((r) => ({ day: r.day, bookings: Number(r.total), cancelled: Number(r.cancelled) })),
        statusMix: (statusMix?.rows ?? []).map((r) => ({ status: r.status, count: Number(r.count) })),
        cancelReasons: (cancelReasons?.rows ?? []).map((r) => ({ reason: r.reason, count: Number(r.count) })),
        paymentFailures: (paymentFailures?.rows ?? []).map((r) => ({ reason: r.reason, count: Number(r.count) })),
        repeat: {
          bookers,
          repeatBookers,
          repeatRate: bookers > 0 ? Math.round((repeatBookers / bookers) * 1000) / 10 : null,
          medianDaysToSecond: numOrNull(repeatRow?.median_days_to_second),
        },
        leadTime: {
          medianDays: numOrNull(leadTime?.rows[0]?.median_days),
          avgDays: numOrNull(leadTime?.rows[0]?.avg_days),
        },
        searchDemand: searchTerms.map((r) => ({ term: r.term, count: Number(r.count) })),
        searchDemandScope,
        searchPlaces: (searchPlaces?.rows ?? []).map((r) => ({
          regionType: r.region_type as 'city' | 'state',
          region: r.region,
          count: Number(r.count),
        })),
        funnel: {
          totals: byListing.reduce(
            (acc, r) => ({
              views: acc.views + r.views,
              cardClicks: acc.cardClicks + r.cardClicks,
              modalOpens: acc.modalOpens + r.modalOpens,
              paymentStarts: acc.paymentStarts + r.paymentStarts,
              bookings: acc.bookings + r.bookings,
            }),
            { views: 0, cardClicks: 0, modalOpens: 0, paymentStarts: 0, bookings: 0 },
          ),
          byListing,
        },
        prev: {
          from: prevFrom, to: prevTo,
          series: (prevSeries?.rows ?? []).map((r) => ({ day: r.day, bookings: Number(r.total), cancelled: Number(r.cancelled) })),
          repeat: { repeatRate: prevBookers > 0 ? Math.round((prevRepeatBookers / prevBookers) * 1000) / 10 : null },
          leadTime: { medianDays: numOrNull(prevLeadTime?.rows[0]?.median_days) },
        },
        heatmap: (heatmap?.rows ?? []).map((r) => ({
          dow: Number(r.dow),
          hour: r.hour == null ? null : Number(r.hour),
          count: Number(r.count),
        })),
        stay: cat === 'stay'
          ? {
              rooms,
              series: (stayOcc?.rows ?? []).map((r) => ({ day: r.day, roomNights: Number(r.room_nights), revenuePaise: Number(r.revenue_paise) })),
              totals: occTotals(stayOcc?.rows, spanDays),
              prevTotals: (({ occupancyPct, adrPaise }) => ({ occupancyPct, adrPaise }))(occTotals(stayOccPrev?.rows, spanDays)),
            }
          : null,
        transport: cat === 'transport'
          ? {
              pickups: (transportDemand?.rows ?? []).filter((r) => r.kind === 'pickup').map((r) => ({ label: r.label, count: Number(r.count) })),
              modes: (transportDemand?.rows ?? []).filter((r) => r.kind === 'mode').map((r) => ({ mode: r.label, count: Number(r.count) })),
            }
          : null,
      },
    };
  }

  /** Idempotent: create the profile if it doesn't exist, otherwise update.
   *  Used by the onboarding flow which doesn't know whether the user has a
   *  provider_profile yet (might or might not have onboarded a listing). */
  async upsertProfile(userId: string, payload: Record<string, unknown>) {
    const parsed = providerProfileUpsertSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ValidationError(`Invalid provider profile payload: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }
    const existing = await providersRepository.getByUserId(userId);
    if (existing.rows[0]) {
      const updated = await providersRepository.update(existing.rows[0].id, parsed.data as Record<string, unknown>);
      return { data: updated.rows[0] };
    }
    const created = await providersRepository.create(userId, parsed.data as Record<string, unknown>);
    return { data: created.rows[0] };
  }
}

export const providersService = new ProvidersService();
