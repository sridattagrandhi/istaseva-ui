// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { aggregateDailyMetrics, type RollupEvent } from './analytics-rollup.js';

const ev = (over: Partial<RollupEvent>): RollupEvent => ({ userId: 'anonymous', ...over });

describe('aggregateDailyMetrics', () => {
  it('returns zeroed overview and empty funnel/terms for no events', () => {
    const { overview, funnel, terms, platform } = aggregateDailyMetrics([]);
    expect(overview.active_users).toBe(0);
    expect(overview.bookings_confirmed).toBe(0);
    expect(overview.revenue_paise).toBe(0);
    expect(funnel).toEqual([]);
    expect(terms).toEqual([]);
    expect(platform).toEqual([]);
  });

  it('sums booking revenue into overview + per-type funnel', () => {
    const { overview, funnel } = aggregateDailyMetrics([
      ev({ eventType: 'booking_confirmed', listingType: 'stay', platform: 'server', props: { revenuePaise: 50000 } }),
      ev({ eventType: 'booking_confirmed', listingType: 'stay', platform: 'server', props: { revenuePaise: 30000 } }),
      ev({ eventType: 'booking_confirmed', listingType: 'transport', platform: 'server', props: { revenuePaise: 12000 } }),
    ]);
    expect(overview.revenue_paise).toBe(92000);
    expect(funnel.find((f) => f.listing_type === 'stay')!.revenue_paise).toBe(80000);
    expect(funnel.find((f) => f.listing_type === 'transport')!.revenue_paise).toBe(12000);
  });

  it('aggregates cancellations, reviews, coupons and wishlist', () => {
    const { overview } = aggregateDailyMetrics([
      ev({ eventType: 'booking_cancelled', props: { refundPaise: 5000 } }),
      ev({ eventType: 'booking_cancelled', props: { refundPaise: 0 } }),
      ev({ eventType: 'review_submitted', props: { rating: 5 } }),
      ev({ eventType: 'review_submitted', props: { rating: 3 } }),
      ev({ eventType: 'coupon_applied', props: { discountPaise: 2000 } }),
      ev({ eventType: 'coupon_failed' }),
      ev({ eventType: 'wishlist_add' }),
      ev({ eventType: 'wishlist_add' }),
      ev({ eventType: 'wishlist_remove' }),
    ]);
    expect(overview.bookings_cancelled).toBe(2);
    expect(overview.refund_paise).toBe(5000);
    expect(overview.reviews_submitted).toBe(2);
    expect(overview.reviews_rating_sum).toBe(8); // avg 4.0
    expect(overview.coupons_applied).toBe(1);
    expect(overview.coupons_failed).toBe(1);
    expect(overview.discount_paise).toBe(2000);
    expect(overview.wishlist_adds).toBe(2);
    expect(overview.wishlist_removes).toBe(1);
  });

  it('counts AI messages and fraud signals (high/critical → critical)', () => {
    const { overview } = aggregateDailyMetrics([
      ev({ eventType: 'ai_message' }),
      ev({ eventType: 'ai_message' }),
      ev({ eventType: 'fraud_signal', props: { riskLevel: 'low' } }),
      ev({ eventType: 'fraud_signal', props: { riskLevel: 'critical' } }),
      ev({ eventType: 'fraud_signal', props: { riskLevel: 'high' } }),
    ]);
    expect(overview.ai_messages).toBe(2);
    expect(overview.fraud_signals).toBe(3);
    expect(overview.fraud_critical).toBe(2); // high + critical
  });

  it('attributes sessions + signups to acquisition channels', () => {
    const { acquisition } = aggregateDailyMetrics([
      ev({ eventType: 'listing_viewed', channel: 'google', sessionId: 's1' }),
      ev({ eventType: 'signup', channel: 'google', sessionId: 's1' }),
      ev({ eventType: 'listing_viewed', channel: 'google', sessionId: 's2' }),
      ev({ eventType: 'signup', channel: 'direct', sessionId: 's3' }),
      ev({ eventType: 'ai_message', sessionId: 's9' }), // no channel (server) → excluded
    ]);
    const google = acquisition.find((a) => a.channel === 'google')!;
    expect(google).toMatchObject({ sessions: 2, signups: 1 });
    expect(acquisition.find((a) => a.channel === 'direct')).toMatchObject({ sessions: 1, signups: 1 });
    expect(acquisition.some((a) => a.channel === '')).toBe(false);
  });

  it('splits events + distinct actors by platform', () => {
    const { platform } = aggregateDailyMetrics([
      ev({ eventType: 'listing_viewed', listingType: 'stay', platform: 'web', userId: 'u1' }),
      ev({ eventType: 'card_clicked', listingType: 'stay', platform: 'web', userId: 'u1' }),
      ev({ eventType: 'listing_viewed', listingType: 'stay', platform: 'mobile', deviceId: 'd9' }),
    ]);
    const web = platform.find((p) => p.platform === 'web')!;
    const mob = platform.find((p) => p.platform === 'mobile')!;
    expect(web).toMatchObject({ events: 2, active_users: 1 });
    expect(mob).toMatchObject({ events: 1, active_users: 1 });
  });

  it('counts overview metrics and splits listing views by type', () => {
    const { overview } = aggregateDailyMetrics([
      ev({ eventType: 'login', userId: 'u1' }),
      ev({ eventType: 'signup', userId: 'u2' }),
      ev({ eventType: 'listing_viewed', listingType: 'stay', userId: 'u1' }),
      ev({ eventType: 'listing_viewed', listingType: 'service', userId: 'u1' }),
      ev({ eventType: 'listing_viewed', listingType: 'transport', deviceId: 'd9' }),
      ev({ eventType: 'provider_call_clicked', userId: 'u1' }),
    ]);
    expect(overview.logins).toBe(1);
    expect(overview.new_signups).toBe(1);
    expect(overview.listing_views_total).toBe(3);
    expect(overview.listing_views_stay).toBe(1);
    expect(overview.listing_views_service).toBe(1);
    expect(overview.listing_views_transport).toBe(1);
    expect(overview.call_clicks).toBe(1);
  });

  it('counts distinct active users by auth id, falling back to device id', () => {
    const { overview } = aggregateDailyMetrics([
      ev({ eventType: 'listing_viewed', listingType: 'stay', userId: 'u1' }),
      ev({ eventType: 'card_clicked', listingType: 'stay', userId: 'u1' }), // same actor
      ev({ eventType: 'listing_viewed', listingType: 'stay', userId: 'anonymous', deviceId: 'd1' }),
      ev({ eventType: 'listing_viewed', listingType: 'stay', userId: 'anonymous', deviceId: 'd1' }), // same device
      ev({ eventType: 'listing_viewed', listingType: 'stay', userId: 'anonymous', deviceId: 'd2' }),
      ev({ eventType: 'listing_viewed', listingType: 'stay', userId: 'anonymous' }), // no device → not counted
    ]);
    expect(overview.active_users).toBe(3); // u1, d1, d2
  });

  it('builds the per-type funnel from view→click→modal→payment→booking', () => {
    const { funnel } = aggregateDailyMetrics([
      ev({ eventType: 'listing_viewed', listingType: 'stay' }),
      ev({ eventType: 'listing_viewed', listingType: 'stay' }),
      ev({ eventType: 'card_clicked', listingType: 'stay' }),
      ev({ eventType: 'booking_modal_opened', listingType: 'stay' }),
      ev({ eventType: 'payment_started', listingType: 'stay' }),
      ev({ eventType: 'booking_confirmed', listingType: 'stay' }),
      ev({ eventType: 'listing_viewed', listingType: 'transport' }),
    ]);
    const stay = funnel.find((f) => f.listing_type === 'stay')!;
    expect(stay).toMatchObject({ views: 2, card_clicks: 1, modal_opens: 1, payment_starts: 1, bookings: 1 });
    expect(funnel.find((f) => f.listing_type === 'transport')).toMatchObject({ views: 1, bookings: 0 });
    // Never fabricates a row for a type with no events.
    expect(funnel.find((f) => f.listing_type === 'service')).toBeUndefined();
  });

  it('aggregates search terms per category, normalized, ignoring termless searches', () => {
    const { terms, overview } = aggregateDailyMetrics([
      ev({ eventType: 'search_performed', listingType: 'stay', props: { q: 'Tirupati' } }),
      ev({ eventType: 'search_performed', listingType: 'stay', props: { q: 'tirupati' } }), // same term after lowercase
      ev({ eventType: 'search_performed', listingType: 'service', props: { q: 'cleaning' } }),
      ev({ eventType: 'search_performed', listingType: 'stay', props: { hasPlace: true } }), // place-only, no term
    ]);
    expect(overview.searches).toBe(4);
    const tirupati = terms.find((t) => t.term === 'tirupati' && t.category === 'stay')!;
    expect(tirupati.count).toBe(2);
    expect(terms.find((t) => t.term === 'cleaning' && t.category === 'service')!.count).toBe(1);
    expect(terms).toHaveLength(2); // place-only search contributes no term row
  });

  it('aggregates searched places per category as separate city/state rows, normalized', () => {
    const { places } = aggregateDailyMetrics([
      ev({ eventType: 'search_performed', listingType: 'stay', props: { hasPlace: true, city: 'Hyderabad', state: 'Telangana' } }),
      ev({ eventType: 'search_performed', listingType: 'stay', props: { hasPlace: true, city: 'hyderabad', state: 'Telangana' } }), // same after lowercase
      ev({ eventType: 'search_performed', listingType: 'stay', props: { hasPlace: true, state: 'Telangana' } }), // state only
      ev({ eventType: 'search_performed', listingType: 'stay', props: { q: 'tirupati' } }), // no place → no rows
    ]);
    expect(places.find((p) => p.region_type === 'city' && p.region === 'hyderabad' && p.category === 'stay')!.count).toBe(2);
    expect(places.find((p) => p.region_type === 'state' && p.region === 'telangana')!.count).toBe(3);
    expect(places).toHaveLength(2);
  });

  it('splits language mix by client platform events only (normalized lowercase)', () => {
    const { languages } = aggregateDailyMetrics([
      ev({ eventType: 'listing_viewed', platform: 'web', language: 'te', userId: 'u1' }),
      ev({ eventType: 'card_clicked', platform: 'web', language: 'TE', userId: 'u1' }), // same actor + lang after lowercase
      ev({ eventType: 'listing_viewed', platform: 'mobile', language: 'hi', deviceId: 'd1' }),
      ev({ eventType: 'booking_confirmed', platform: 'server', language: 'en', userId: 'u2' }), // server → excluded
      ev({ eventType: 'listing_viewed', platform: 'web', userId: 'u3' }), // no language → excluded
    ]);
    expect(languages.find((l) => l.language === 'te')).toMatchObject({ events: 2, active_users: 1 });
    expect(languages.find((l) => l.language === 'hi')).toMatchObject({ events: 1, active_users: 1 });
    expect(languages.some((l) => l.language === 'en')).toBe(false);
  });

  it('aggregates customer origins (actors + searches) keyed on city+state', () => {
    const { origins } = aggregateDailyMetrics([
      ev({ eventType: 'search_performed', platform: 'web', originCity: 'Bengaluru', originState: 'Karnataka', userId: 'u1' }),
      ev({ eventType: 'listing_viewed', platform: 'web', originCity: 'Bengaluru', originState: 'Karnataka', userId: 'u2' }),
      ev({ eventType: 'search_performed', platform: 'mobile', originCity: 'Chennai', originState: 'Tamil Nadu', deviceId: 'd1' }),
      ev({ eventType: 'search_performed', platform: 'web', userId: 'u3' }), // no origin → excluded
    ]);
    const blr = origins.find((o) => o.origin_city === 'Bengaluru')!;
    expect(blr).toMatchObject({ origin_state: 'Karnataka', active_users: 2, searches: 1 });
    expect(origins.find((o) => o.origin_city === 'Chennai')).toMatchObject({ active_users: 1, searches: 1 });
    expect(origins).toHaveLength(2);
  });

  it('builds origin→destination pairs from modal opens + payment starts', () => {
    const { originDest } = aggregateDailyMetrics([
      ev({ eventType: 'booking_modal_opened', platform: 'web', originCity: 'Bengaluru', props: { destCity: 'Coorg' } }),
      ev({ eventType: 'payment_started', platform: 'web', originCity: 'Bengaluru', props: { destCity: 'Coorg' } }),
      ev({ eventType: 'booking_modal_opened', platform: 'web', originCity: 'Bengaluru' }), // no destCity → excluded
      ev({ eventType: 'booking_modal_opened', platform: 'web', props: { destCity: 'Coorg' } }), // no origin → excluded
    ]);
    expect(originDest).toHaveLength(1);
    expect(originDest[0]).toMatchObject({ origin_city: 'Bengaluru', dest_city: 'Coorg', modal_opens: 1, payment_starts: 1 });
  });

  it('counts payment failures from the webhook plus client dismissals only', () => {
    const { overview, paymentFailures } = aggregateDailyMetrics([
      ev({ eventType: 'payment_failed', platform: 'server', props: { reasonCode: 'BAD_REQUEST_ERROR' } }),
      ev({ eventType: 'payment_failed', platform: 'web', props: { reasonCode: 'user_dismissed' } }),
      // Client-observed real failure: diagnostics only — the webhook reports
      // the same failure authoritatively, so counting both would double it.
      ev({ eventType: 'payment_failed', platform: 'web', props: { reasonCode: 'BAD_REQUEST_ERROR' } }),
    ]);
    expect(overview.payment_failures).toBe(2);
    expect(paymentFailures.find((p) => p.reason_code === 'BAD_REQUEST_ERROR')).toMatchObject({ count: 1 });
    expect(paymentFailures.find((p) => p.reason_code === 'user_dismissed')).toMatchObject({ count: 1 });
  });

  it('buckets cancellation reasons, defaulting reasonless cancels to unspecified', () => {
    const { cancelReasons, overview } = aggregateDailyMetrics([
      ev({ eventType: 'booking_cancelled', platform: 'server', props: { refundPaise: 0, reason: 'plans_changed' } }),
      ev({ eventType: 'booking_cancelled', platform: 'server', props: { refundPaise: 0, reason: 'plans_changed' } }),
      ev({ eventType: 'booking_cancelled', platform: 'server', props: { refundPaise: 0 } }),
    ]);
    expect(overview.bookings_cancelled).toBe(3);
    expect(cancelReasons.find((r) => r.reason === 'plans_changed')).toMatchObject({ count: 2 });
    expect(cancelReasons.find((r) => r.reason === 'unspecified')).toMatchObject({ count: 1 });
  });

  it('builds the per-listing funnel from UUID-validated listingIds only', () => {
    const lid = '11111111-2222-4333-8444-555555555555';
    const { listingFunnel } = aggregateDailyMetrics([
      ev({ eventType: 'listing_viewed', listingType: 'stay', listingId: lid }),
      ev({ eventType: 'listing_viewed', listingType: 'stay', listingId: lid.toUpperCase() }),
      ev({ eventType: 'card_clicked', listingType: 'stay', listingId: lid }),
      ev({ eventType: 'booking_modal_opened', listingType: 'stay', listingId: lid }),
      ev({ eventType: 'payment_started', listingType: 'stay', listingId: lid }),
      ev({ eventType: 'booking_confirmed', listingType: 'stay', listingId: lid, platform: 'server', props: { revenuePaise: 9900 } }),
      // Non-UUID ids (mock slugs, garbage) must not create rows — the rollup
      // table's UUID column would reject them and abort the transaction.
      ev({ eventType: 'listing_viewed', listingType: 'stay', listingId: 'mock-heritage-goa' }),
      ev({ eventType: 'listing_viewed', listingType: 'stay' }),
    ]);
    expect(listingFunnel).toHaveLength(1);
    const row = listingFunnel[0];
    expect(row.listing_id).toBe(lid);
    expect(row.views).toBe(2); // case-insensitive: upper-cased id folds into the same row
    expect(row.card_clicks).toBe(1);
    expect(row.modal_opens).toBe(1);
    expect(row.payment_starts).toBe(1);
    expect(row.bookings).toBe(1);
    expect(row.revenue_paise).toBe(9900);
  });
});
