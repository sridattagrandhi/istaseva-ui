-- Nightly rollup targets for behavioural analytics. Raw events live append-only
-- in the `analytics_events` DynamoDB table (1-yr TTL); a daily batch job reads
-- one calendar day via the table's `date-index` GSI, aggregates it, and UPSERTs
-- into these Postgres tables. Postgres is the query surface for the admin
-- dashboard — DynamoDB is bad at "count all events this week".
--
-- All three tables are keyed on `day` (UTC calendar date) so a re-run of the
-- same day overwrites rather than double-counts (idempotent rollups).

-- One row per day: platform-wide headline counters.
CREATE TABLE IF NOT EXISTS public.analytics_daily_overview (
  day                       DATE PRIMARY KEY,
  active_users              INTEGER NOT NULL DEFAULT 0,
  new_signups               INTEGER NOT NULL DEFAULT 0,
  logins                    INTEGER NOT NULL DEFAULT 0,
  listing_views_total       INTEGER NOT NULL DEFAULT 0,
  listing_views_stay        INTEGER NOT NULL DEFAULT 0,
  listing_views_service     INTEGER NOT NULL DEFAULT 0,
  listing_views_transport   INTEGER NOT NULL DEFAULT 0,
  searches                  INTEGER NOT NULL DEFAULT 0,
  card_clicks               INTEGER NOT NULL DEFAULT 0,
  booking_modal_opens       INTEGER NOT NULL DEFAULT 0,
  payment_starts            INTEGER NOT NULL DEFAULT 0,
  bookings_confirmed        INTEGER NOT NULL DEFAULT 0,
  call_clicks               INTEGER NOT NULL DEFAULT 0,
  message_clicks            INTEGER NOT NULL DEFAULT 0,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (day, listing_type): the discovery→booking funnel per category.
CREATE TABLE IF NOT EXISTS public.analytics_daily_funnel (
  day             DATE NOT NULL,
  listing_type    TEXT NOT NULL,
  views           INTEGER NOT NULL DEFAULT 0,
  card_clicks     INTEGER NOT NULL DEFAULT 0,
  modal_opens     INTEGER NOT NULL DEFAULT 0,
  payment_starts  INTEGER NOT NULL DEFAULT 0,
  bookings        INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, listing_type)
);

-- Top search terms per (day, category). `term` is the normalized query text
-- captured on `search_performed`; place-only stay searches carry no term.
CREATE TABLE IF NOT EXISTS public.analytics_search_terms (
  day         DATE NOT NULL,
  category    TEXT NOT NULL,
  term        TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, category, term)
);
CREATE INDEX IF NOT EXISTS analytics_search_terms_day_count_idx
  ON public.analytics_search_terms (day, count DESC);
