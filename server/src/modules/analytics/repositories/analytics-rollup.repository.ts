import { dbQuery, dbTransaction, runDbQuery } from '../../../common/repositories/database.js';
import type { DailyAggregate } from '../services/analytics-rollup.js';

export class AnalyticsRollupRepository {
  /**
   * Persist one day's aggregate. Idempotent: the overview row is UPSERTed on
   * `day`, and the funnel/terms rows for the day are replaced wholesale — so a
   * re-run of the same day converges rather than double-counting.
   */
  writeDailyRollup(day: string, agg: DailyAggregate) {
    const o = agg.overview;
    return dbTransaction(async (client) => {
      await runDbQuery(
        client,
        `INSERT INTO analytics_daily_overview (
           day, active_users, new_signups, logins,
           listing_views_total, listing_views_stay, listing_views_service, listing_views_transport,
           searches, card_clicks, booking_modal_opens, payment_starts,
           bookings_confirmed, call_clicks, message_clicks, revenue_paise,
           bookings_cancelled, refund_paise, reviews_submitted, reviews_rating_sum,
           coupons_applied, coupons_failed, discount_paise, wishlist_adds, wishlist_removes,
           new_listings, active_providers, ai_messages, fraud_signals, fraud_critical, payment_failures, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31, NOW())
         ON CONFLICT (day) DO UPDATE SET
           active_users = EXCLUDED.active_users,
           new_signups = EXCLUDED.new_signups,
           logins = EXCLUDED.logins,
           listing_views_total = EXCLUDED.listing_views_total,
           listing_views_stay = EXCLUDED.listing_views_stay,
           listing_views_service = EXCLUDED.listing_views_service,
           listing_views_transport = EXCLUDED.listing_views_transport,
           searches = EXCLUDED.searches,
           card_clicks = EXCLUDED.card_clicks,
           booking_modal_opens = EXCLUDED.booking_modal_opens,
           payment_starts = EXCLUDED.payment_starts,
           bookings_confirmed = EXCLUDED.bookings_confirmed,
           call_clicks = EXCLUDED.call_clicks,
           message_clicks = EXCLUDED.message_clicks,
           revenue_paise = EXCLUDED.revenue_paise,
           bookings_cancelled = EXCLUDED.bookings_cancelled,
           refund_paise = EXCLUDED.refund_paise,
           reviews_submitted = EXCLUDED.reviews_submitted,
           reviews_rating_sum = EXCLUDED.reviews_rating_sum,
           coupons_applied = EXCLUDED.coupons_applied,
           coupons_failed = EXCLUDED.coupons_failed,
           discount_paise = EXCLUDED.discount_paise,
           wishlist_adds = EXCLUDED.wishlist_adds,
           wishlist_removes = EXCLUDED.wishlist_removes,
           new_listings = EXCLUDED.new_listings,
           active_providers = EXCLUDED.active_providers,
           ai_messages = EXCLUDED.ai_messages,
           fraud_signals = EXCLUDED.fraud_signals,
           fraud_critical = EXCLUDED.fraud_critical,
           payment_failures = EXCLUDED.payment_failures,
           updated_at = NOW()`,
        [
          day, o.active_users, o.new_signups, o.logins,
          o.listing_views_total, o.listing_views_stay, o.listing_views_service, o.listing_views_transport,
          o.searches, o.card_clicks, o.booking_modal_opens, o.payment_starts,
          o.bookings_confirmed, o.call_clicks, o.message_clicks, o.revenue_paise,
          o.bookings_cancelled, o.refund_paise, o.reviews_submitted, o.reviews_rating_sum,
          o.coupons_applied, o.coupons_failed, o.discount_paise, o.wishlist_adds, o.wishlist_removes,
          o.new_listings, o.active_providers, o.ai_messages, o.fraud_signals, o.fraud_critical,
          o.payment_failures,
        ],
      );

      await runDbQuery(client, `DELETE FROM analytics_daily_funnel WHERE day = $1`, [day]);
      for (const f of agg.funnel) {
        await runDbQuery(
          client,
          `INSERT INTO analytics_daily_funnel (day, listing_type, views, card_clicks, modal_opens, payment_starts, bookings, revenue_paise, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())`,
          [day, f.listing_type, f.views, f.card_clicks, f.modal_opens, f.payment_starts, f.bookings, f.revenue_paise],
        );
      }

      await runDbQuery(client, `DELETE FROM analytics_daily_listing_funnel WHERE day = $1`, [day]);
      for (const f of agg.listingFunnel) {
        await runDbQuery(
          client,
          `INSERT INTO analytics_daily_listing_funnel (day, listing_id, views, card_clicks, modal_opens, payment_starts, bookings, revenue_paise, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())`,
          [day, f.listing_id, f.views, f.card_clicks, f.modal_opens, f.payment_starts, f.bookings, f.revenue_paise],
        );
      }

      await runDbQuery(client, `DELETE FROM analytics_daily_platform WHERE day = $1`, [day]);
      for (const p of agg.platform) {
        await runDbQuery(
          client,
          `INSERT INTO analytics_daily_platform (day, platform, events, active_users, updated_at)
           VALUES ($1,$2,$3,$4, NOW())`,
          [day, p.platform, p.events, p.active_users],
        );
      }

      await runDbQuery(client, `DELETE FROM analytics_daily_geo WHERE day = $1`, [day]);
      for (const g of agg.geo) {
        await runDbQuery(
          client,
          `INSERT INTO analytics_daily_geo (day, city, bookings, revenue_paise, updated_at)
           VALUES ($1,$2,$3,$4, NOW())`,
          [day, g.city, g.bookings, g.revenue_paise],
        );
      }

      await runDbQuery(client, `DELETE FROM analytics_daily_acquisition WHERE day = $1`, [day]);
      for (const a of agg.acquisition) {
        await runDbQuery(
          client,
          `INSERT INTO analytics_daily_acquisition (day, channel, sessions, signups, updated_at)
           VALUES ($1,$2,$3,$4, NOW())`,
          [day, a.channel, a.sessions, a.signups],
        );
      }

      await runDbQuery(client, `DELETE FROM analytics_search_terms WHERE day = $1`, [day]);
      for (const t of agg.terms) {
        await runDbQuery(
          client,
          `INSERT INTO analytics_search_terms (day, category, term, count, updated_at)
           VALUES ($1,$2,$3,$4, NOW())`,
          [day, t.category, t.term, t.count],
        );
      }

      await runDbQuery(client, `DELETE FROM analytics_search_places WHERE day = $1`, [day]);
      for (const p of agg.places) {
        await runDbQuery(
          client,
          `INSERT INTO analytics_search_places (day, category, region_type, region, count, updated_at)
           VALUES ($1,$2,$3,$4,$5, NOW())`,
          [day, p.category, p.region_type, p.region, p.count],
        );
      }

      await runDbQuery(client, `DELETE FROM analytics_daily_language WHERE day = $1`, [day]);
      for (const l of agg.languages) {
        await runDbQuery(
          client,
          `INSERT INTO analytics_daily_language (day, language, events, active_users, updated_at)
           VALUES ($1,$2,$3,$4, NOW())`,
          [day, l.language, l.events, l.active_users],
        );
      }

      await runDbQuery(client, `DELETE FROM analytics_daily_origin WHERE day = $1`, [day]);
      for (const o2 of agg.origins) {
        await runDbQuery(
          client,
          `INSERT INTO analytics_daily_origin (day, origin_city, origin_state, active_users, searches, updated_at)
           VALUES ($1,$2,$3,$4,$5, NOW())`,
          [day, o2.origin_city, o2.origin_state, o2.active_users, o2.searches],
        );
      }

      await runDbQuery(client, `DELETE FROM analytics_daily_origin_dest WHERE day = $1`, [day]);
      for (const od of agg.originDest) {
        await runDbQuery(
          client,
          `INSERT INTO analytics_daily_origin_dest (day, origin_city, dest_city, modal_opens, payment_starts, updated_at)
           VALUES ($1,$2,$3,$4,$5, NOW())`,
          [day, od.origin_city, od.dest_city, od.modal_opens, od.payment_starts],
        );
      }

      await runDbQuery(client, `DELETE FROM analytics_daily_payment_failures WHERE day = $1`, [day]);
      for (const pf of agg.paymentFailures) {
        await runDbQuery(
          client,
          `INSERT INTO analytics_daily_payment_failures (day, reason_code, count, updated_at)
           VALUES ($1,$2,$3, NOW())`,
          [day, pf.reason_code, pf.count],
        );
      }

      await runDbQuery(client, `DELETE FROM analytics_daily_cancel_reasons WHERE day = $1`, [day]);
      for (const cr of agg.cancelReasons) {
        await runDbQuery(
          client,
          `INSERT INTO analytics_daily_cancel_reasons (day, reason, count, updated_at)
           VALUES ($1,$2,$3, NOW())`,
          [day, cr.reason, cr.count],
        );
      }
    });
  }

  /**
   * Event-derived customer-profile columns (language, home city, last-active
   * day). COALESCE keeps the newest observation without erasing older data
   * when a day's events lack a field; last_active_day only moves forward so
   * re-running an old day can't regress it.
   */
  async upsertCustomerActivity(rows: Array<{ userId: string; language: string | null; originCity: string | null; day: string }>) {
    for (const r of rows) {
      await dbQuery(
        `INSERT INTO analytics_customer_profiles (user_id, language, home_city, last_active_day, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           language = COALESCE(EXCLUDED.language, analytics_customer_profiles.language),
           home_city = COALESCE(EXCLUDED.home_city, analytics_customer_profiles.home_city),
           last_active_day = GREATEST(COALESCE(EXCLUDED.last_active_day, analytics_customer_profiles.last_active_day), COALESCE(analytics_customer_profiles.last_active_day, EXCLUDED.last_active_day)),
           updated_at = NOW()`,
        [r.userId, r.language, r.originCity, r.day],
      );
    }
  }

  /**
   * Booking-derived customer-profile columns, recomputed wholesale from the
   * transactional source of truth (bookings + payments + user_profiles) —
   * idempotent. Revenue mirrors the emailTotalPaise definition in
   * bookings.service.ts (customer grand total): the latest completed
   * payment's fee breakdown incl. insurance, then its amount_paise, then the
   * booking's agreed price for legacy rows. Cancelled bookings count toward
   * cancelled_total only; revenue/favorite come from
   * confirmed/in_progress/completed bookings.
   */
  refreshCustomerBookingStats() {
    return dbQuery(
      `INSERT INTO analytics_customer_profiles (
         user_id, first_booking_at, last_booking_at, bookings_total, cancelled_total,
         revenue_paise_total, favorite_category, acquisition_channel, updated_at
       )
       SELECT
         b.user_id::text,
         MIN(b.created_at) FILTER (WHERE b.status IN ('confirmed','in_progress','completed')),
         MAX(b.created_at) FILTER (WHERE b.status IN ('confirmed','in_progress','completed')),
         COUNT(*) FILTER (WHERE b.status IN ('confirmed','in_progress','completed'))::int,
         COUNT(*) FILTER (WHERE b.status = 'cancelled')::int,
         COALESCE(SUM(
           CASE WHEN b.status IN ('confirmed','in_progress','completed')
             THEN COALESCE(pay.paid_paise, b.agreed_price_paise, 0)::bigint
             ELSE 0
           END
         ), 0),
         MODE() WITHIN GROUP (ORDER BY b.service_category) FILTER (WHERE b.status IN ('confirmed','in_progress','completed')),
         MAX(up.acquisition_channel),
         NOW()
       FROM bookings b
       LEFT JOIN user_profiles up ON up.user_id = b.user_id::text
       LEFT JOIN LATERAL (
         SELECT CASE
             WHEN p.subtotal_paise IS NOT NULL
               THEN GREATEST(0, p.subtotal_paise - COALESCE(p.discount_paise, 0))
                    + COALESCE(p.platform_fee_paise, 0) + COALESCE(p.taxes_paise, 0)
                    + COALESCE(p.insurance_premium_paise, 0)
             ELSE p.amount_paise
           END AS paid_paise
         FROM payments p
         WHERE p.booking_id = b.id AND p.status = 'completed'
         ORDER BY p.completed_at DESC NULLS LAST, p.created_at DESC
         LIMIT 1
       ) pay ON TRUE
       GROUP BY b.user_id
       ON CONFLICT (user_id) DO UPDATE SET
         first_booking_at = EXCLUDED.first_booking_at,
         last_booking_at = EXCLUDED.last_booking_at,
         bookings_total = EXCLUDED.bookings_total,
         cancelled_total = EXCLUDED.cancelled_total,
         revenue_paise_total = EXCLUDED.revenue_paise_total,
         favorite_category = EXCLUDED.favorite_category,
         acquisition_channel = COALESCE(EXCLUDED.acquisition_channel, analytics_customer_profiles.acquisition_channel),
         updated_at = NOW()`,
    );
  }
}

export const analyticsRollupRepository = new AnalyticsRollupRepository();
