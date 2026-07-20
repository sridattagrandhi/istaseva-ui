-- P3: Provider scheduling fields. Adds the data the smart-schedule needs to
-- be genuinely smart per-provider instead of falling back to assumptions
-- (everyone uses a scooter, everyone works 8-8 every day).
--
-- vehicle_class       drives the travel-time multiplier in travel-time.ts
-- max_jobs_per_day    caps daily load so we don't dispatch a 12th job
-- working_hours       per-weekday opening windows incl. weekly off (NULL day)
-- provider_blackout_dates table is reserved for v3 UI; column exists now so
-- adding rows later doesn't require a migration on a populated table.

BEGIN;

ALTER TABLE public.provider_profiles
  ADD COLUMN IF NOT EXISTS vehicle_class TEXT NOT NULL DEFAULT 'scooter'
    CHECK (vehicle_class IN ('walk', 'scooter', 'car', 'van'));

ALTER TABLE public.provider_profiles
  ADD COLUMN IF NOT EXISTS max_jobs_per_day INTEGER NOT NULL DEFAULT 6
    CHECK (max_jobs_per_day BETWEEN 1 AND 50);

-- working_hours shape:
--   { "mon": ["09:00","19:00"], "tue": [...], ..., "sun": null }
-- A null entry means the provider doesn't work that day. Times are local
-- (IST) and 24-hour. Default is the most-common Indian service window:
-- Mon-Sat 09:00-19:00, Sunday off. Providers confirm/adjust during onboarding.
ALTER TABLE public.provider_profiles
  ADD COLUMN IF NOT EXISTS working_hours JSONB NOT NULL DEFAULT '{
    "mon": ["09:00", "19:00"],
    "tue": ["09:00", "19:00"],
    "wed": ["09:00", "19:00"],
    "thu": ["09:00", "19:00"],
    "fri": ["09:00", "19:00"],
    "sat": ["09:00", "19:00"],
    "sun": null
  }'::jsonb;

CREATE TABLE IF NOT EXISTS public.provider_blackout_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES public.provider_profiles(id) ON DELETE CASCADE,
  blackout_date DATE NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_id, blackout_date)
);

CREATE INDEX IF NOT EXISTS idx_provider_blackout_provider_date
  ON public.provider_blackout_dates (provider_id, blackout_date);

COMMIT;
