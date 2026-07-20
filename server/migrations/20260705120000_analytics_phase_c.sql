-- Phase C analytics: provider supply metrics + geographic demand.
ALTER TABLE public.analytics_daily_overview
  ADD COLUMN IF NOT EXISTS new_listings     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_providers INTEGER NOT NULL DEFAULT 0;

-- Bookings + revenue per city per day (from booking_confirmed events).
CREATE TABLE IF NOT EXISTS public.analytics_daily_geo (
  day           DATE NOT NULL,
  city          TEXT NOT NULL,
  bookings      INTEGER NOT NULL DEFAULT 0,
  revenue_paise BIGINT  NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, city)
);
CREATE INDEX IF NOT EXISTS analytics_daily_geo_day_bookings_idx
  ON public.analytics_daily_geo (day, bookings DESC);
