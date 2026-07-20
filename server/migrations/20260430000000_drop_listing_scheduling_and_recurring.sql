-- Rollback for 20260429000000_listing_scheduling_and_recurring.sql.
--
-- The Tier 1 service-scheduling experiment was abandoned: the UI surfaces
-- were too heavy for the village-provider audience and we backed out the
-- code in the same session. The up-migration's file is gone (untracked,
-- never committed), but its row is still in schema_migrations on staging,
-- and the columns/table it created still exist.
--
-- IF EXISTS guards make this safe on:
--   - staging (columns/table present → dropped),
--   - any fresh DB where the up-migration never ran (no-op).

BEGIN;

DROP INDEX IF EXISTS idx_bookings_series;

ALTER TABLE public.bookings
  DROP COLUMN IF EXISTS booking_series_id;

ALTER TABLE public.bookings
  DROP COLUMN IF EXISTS series_occurrence_index;

DROP TABLE IF EXISTS public.booking_series;

ALTER TABLE public.listings DROP COLUMN IF EXISTS service_kind;
ALTER TABLE public.listings DROP COLUMN IF EXISTS duration_minutes;
ALTER TABLE public.listings DROP COLUMN IF EXISTS min_notice_minutes;
ALTER TABLE public.listings DROP COLUMN IF EXISTS max_advance_days;
ALTER TABLE public.listings DROP COLUMN IF EXISTS cancellation_window_minutes;
ALTER TABLE public.listings DROP COLUMN IF EXISTS capacity;
ALTER TABLE public.listings DROP COLUMN IF EXISTS requires_consecutive_days;

COMMIT;
