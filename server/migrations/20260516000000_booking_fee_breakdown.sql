-- Store the forward fee/GST/discount breakdown on the booking itself, so the
-- payment row can copy these values byte-for-byte at createOrder time rather
-- than reversing them out of agreed_price_paise (which introduces rounding
-- drift and lets the invoice show different numbers than the booking modal).
--
-- All nullable so legacy holds keep working; createHold backfills them going
-- forward and createOrder uses them when present.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS subtotal_paise     INTEGER,
  ADD COLUMN IF NOT EXISTS platform_fee_paise INTEGER,
  ADD COLUMN IF NOT EXISTS taxes_paise        INTEGER,
  ADD COLUMN IF NOT EXISTS discount_paise     INTEGER;
