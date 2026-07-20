-- Add agreed_price_paise to bookings so the price is locked in at hold creation time
-- and can be validated at payment time (accounts for dynamic pricing, duration, etc.)
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS agreed_price_paise INTEGER;

-- Also add listing_id reference for traceability
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS listing_id UUID;
