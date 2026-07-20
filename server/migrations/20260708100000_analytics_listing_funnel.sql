-- Per-listing discovery→booking funnel rollup, feeding the partner dashboards'
-- Insights tab ("your listing got N views this week"). Same pipeline as
-- analytics_daily_funnel: the rollup job reads one day of analytics_events
-- from DynamoDB and replaces the day's rows wholesale (idempotent re-runs).
-- Raw events already carry listingId; rows without one simply don't
-- contribute here.
CREATE TABLE IF NOT EXISTS public.analytics_daily_listing_funnel (
  day             DATE NOT NULL,
  listing_id      UUID NOT NULL,
  views           INTEGER NOT NULL DEFAULT 0,
  card_clicks     INTEGER NOT NULL DEFAULT 0,
  modal_opens     INTEGER NOT NULL DEFAULT 0,
  payment_starts  INTEGER NOT NULL DEFAULT 0,
  bookings        INTEGER NOT NULL DEFAULT 0,
  revenue_paise   BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, listing_id)
);

-- Partner queries filter by their listings first, then the day window.
CREATE INDEX IF NOT EXISTS analytics_daily_listing_funnel_listing_idx
  ON public.analytics_daily_listing_funnel (listing_id, day);
