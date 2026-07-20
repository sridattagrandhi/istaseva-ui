-- Multi-night stay support for bookings.
--
-- Previously bookings carried only `scheduled_date` (the check-in / service
-- day). For stays, the check-out date was stashed inside `notes` JSON, so
-- the conflict checks at hold time and the booked-dates calendar API only
-- ever considered the check-in night. That allowed overlapping stay
-- bookings whenever two guests picked different check-in dates but their
-- ranges overlapped.
--
-- This adds an explicit `end_date` column (check-out, exclusive — guests
-- occupy nights from scheduled_date up to but not including end_date) and
-- backfills it:
--   - service / transport bookings → end_date = scheduled_date (same day)
--   - stay bookings with a JSON `checkOut` in notes → that date
--   - everything else → scheduled_date as a safe single-night default

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS end_date DATE;

-- Best-effort backfill of historical stay bookings whose checkout date was
-- only ever stored in notes. The JSON parse is wrapped to ignore notes that
-- are free text or malformed.
UPDATE public.bookings
   SET end_date = (
     CASE
       WHEN notes IS NOT NULL
            AND notes ~ '^\s*\{'
            AND (notes::jsonb ->> 'checkOut') ~ '^\d{4}-\d{2}-\d{2}$'
       THEN (notes::jsonb ->> 'checkOut')::date
       ELSE scheduled_date
     END
   )
 WHERE end_date IS NULL;

-- Defensive: any malformed JSON that slipped past the regex falls back to
-- the same-day default so the NOT NULL constraint below succeeds.
UPDATE public.bookings SET end_date = scheduled_date WHERE end_date IS NULL;

ALTER TABLE public.bookings
  ALTER COLUMN end_date SET NOT NULL;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_end_date_after_start
  CHECK (end_date >= scheduled_date);

-- Speeds up the multi-night overlap check used in conflict detection and
-- in the booked-dates calendar endpoint.
CREATE INDEX IF NOT EXISTS idx_bookings_provider_date_range
  ON public.bookings(provider_id, scheduled_date, end_date)
  WHERE status IN ('pending', 'confirmed', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_bookings_listing_date_range
  ON public.bookings(listing_id, scheduled_date, end_date)
  WHERE status IN ('pending', 'confirmed', 'in_progress');
