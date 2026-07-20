-- AI-assistant usage, fraud-signal volume, and acquisition-channel rollups.
ALTER TABLE public.analytics_daily_overview
  ADD COLUMN IF NOT EXISTS ai_messages    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fraud_signals  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fraud_critical INTEGER NOT NULL DEFAULT 0;

-- Sessions + signups per acquisition channel per day.
CREATE TABLE IF NOT EXISTS public.analytics_daily_acquisition (
  day         DATE NOT NULL,
  channel     TEXT NOT NULL,
  sessions    INTEGER NOT NULL DEFAULT 0,
  signups     INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, channel)
);
CREATE INDEX IF NOT EXISTS analytics_daily_acquisition_day_sessions_idx
  ON public.analytics_daily_acquisition (day, sessions DESC);
