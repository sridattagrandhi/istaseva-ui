-- Customer analytics rollup tables (admin "Customers" dashboard).
--
-- Daily dimension tables follow the analytics_phase_c pattern: composite PK on
-- (day, dimension), rewritten wholesale per day by the nightly rollup
-- (DELETE-by-day + INSERT), so re-running a day is idempotent.
--
-- analytics_customer_profiles is a per-customer aggregate (RFM-style) refreshed
-- nightly from Postgres bookings plus event-derived activity (language, home
-- city). It exists so lifetime totals survive the 1-year TTL on raw events.
-- Aggregate/segment reporting only — the admin API must never expose it as a
-- browsable per-person activity log.

CREATE TABLE IF NOT EXISTS public.analytics_daily_language (
  day          DATE NOT NULL,
  language     TEXT NOT NULL,
  events       INTEGER NOT NULL DEFAULT 0,
  active_users INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, language)
);

CREATE TABLE IF NOT EXISTS public.analytics_daily_origin (
  day          DATE NOT NULL,
  origin_city  TEXT NOT NULL,
  origin_state TEXT NOT NULL DEFAULT '',
  active_users INTEGER NOT NULL DEFAULT 0,
  searches     INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, origin_city, origin_state)
);

CREATE INDEX IF NOT EXISTS analytics_daily_origin_day_users_idx
  ON public.analytics_daily_origin (day, active_users DESC);

CREATE TABLE IF NOT EXISTS public.analytics_daily_origin_dest (
  day            DATE NOT NULL,
  origin_city    TEXT NOT NULL,
  dest_city      TEXT NOT NULL,
  modal_opens    INTEGER NOT NULL DEFAULT 0,
  payment_starts INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, origin_city, dest_city)
);

CREATE TABLE IF NOT EXISTS public.analytics_daily_payment_failures (
  day         DATE NOT NULL,
  reason_code TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, reason_code)
);

CREATE TABLE IF NOT EXISTS public.analytics_daily_cancel_reasons (
  day        DATE NOT NULL,
  reason     TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, reason)
);

CREATE TABLE IF NOT EXISTS public.analytics_customer_profiles (
  user_id             TEXT PRIMARY KEY,
  first_booking_at    TIMESTAMPTZ,
  last_booking_at     TIMESTAMPTZ,
  bookings_total      INTEGER NOT NULL DEFAULT 0,
  cancelled_total     INTEGER NOT NULL DEFAULT 0,
  revenue_paise_total BIGINT NOT NULL DEFAULT 0,
  favorite_category   TEXT,
  home_city           TEXT,
  language            TEXT,
  acquisition_channel TEXT,
  last_active_day     DATE,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.analytics_daily_overview
  ADD COLUMN IF NOT EXISTS payment_failures INTEGER NOT NULL DEFAULT 0;

-- Customer metrics (new-vs-returning, repeat rate) are computed at query time
-- over bookings windowed by created_at; only (user_id) is indexed today.
CREATE INDEX IF NOT EXISTS idx_bookings_created_at
  ON public.bookings (created_at);
