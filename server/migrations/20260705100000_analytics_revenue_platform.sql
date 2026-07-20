-- Phase A analytics expansion: revenue (GMV) + web/mobile platform split.
-- All additive; the nightly rollup populates them going forward.

-- Revenue in paise (GMV) — summed from `booking_confirmed` event amounts.
ALTER TABLE public.analytics_daily_overview  ADD COLUMN IF NOT EXISTS revenue_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.analytics_daily_funnel    ADD COLUMN IF NOT EXISTS revenue_paise BIGINT NOT NULL DEFAULT 0;

-- Per-day usage split by client platform (web / mobile / server).
CREATE TABLE IF NOT EXISTS public.analytics_daily_platform (
  day           DATE NOT NULL,
  platform      TEXT NOT NULL,
  events        INTEGER NOT NULL DEFAULT 0,
  active_users  INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, platform)
);
