-- Booking / payment human-facing references (support lookup).
--
-- Users see a 16-char UPPERCASE hex reference instead of a raw UUID.
-- The reference is DERIVED from the row's own UUID (first 16 hex chars,
-- uppercased) via a STORED generated column, so:
--   * existing rows are backfilled automatically at ALTER time,
--   * new rows get one with no application code or trigger,
--   * clients can derive the identical value locally from the UUID they
--     already have (id.replace(/-/g,'').slice(0,16).toUpperCase()) — no API
--     contract change needed,
--   * support pastes the code a caller reads out into an exact-match query.
-- 16 hex chars = 64 bits of the v4 UUID — collision odds are negligible at
-- any realistic row count; the unique index is a tripwire, not a workload.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS booking_reference TEXT
  GENERATED ALWAYS AS (upper(left(replace(id::text, '-', ''), 16))) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_booking_reference
  ON public.bookings (booking_reference);

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS payment_reference TEXT
  GENERATED ALWAYS AS (upper(left(replace(id::text, '-', ''), 16))) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_payment_reference
  ON public.payments (payment_reference);
