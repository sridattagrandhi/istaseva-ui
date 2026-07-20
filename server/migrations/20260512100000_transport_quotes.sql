-- Transport quote requests
--
-- A customer asks a transport provider "how much for this trip?" — telling
-- the driver pickup, drop, planned stops, date/time, etc. The provider
-- responds with a price (provider_quote_paise) and a message. The customer
-- can accept the quote, which spins up a booking hold + payment using the
-- existing booking/payment flow (booking_id is set once that hold exists).
--
-- Lifecycle: pending -> quoted -> accepted | rejected
--                              -> expired | cancelled
--   accepted -> booked  (after the booking hold is created)
--
-- Authorization: customers see/cancel their own; providers see/quote
-- requests routed to their provider_profile via listing_id.

CREATE TABLE IF NOT EXISTS public.transport_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  provider_id UUID NOT NULL,
  listing_id UUID,
  pickup_address TEXT NOT NULL,
  drop_address TEXT NOT NULL,
  stops JSONB NOT NULL DEFAULT '[]'::jsonb,
  scheduled_date DATE NOT NULL,
  scheduled_time TEXT,
  estimated_km NUMERIC,
  estimated_duration_minutes INTEGER,
  customer_notes TEXT,
  provider_quote_paise BIGINT,
  provider_message TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'quoted', 'accepted', 'rejected', 'expired', 'cancelled', 'booked')),
  booking_id UUID REFERENCES public.bookings(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  quoted_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transport_quotes_user
  ON public.transport_quotes (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transport_quotes_provider
  ON public.transport_quotes (provider_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transport_quotes_listing
  ON public.transport_quotes (listing_id)
  WHERE listing_id IS NOT NULL;

-- Bump updated_at on any change so the dashboards can sort by recency.
CREATE OR REPLACE FUNCTION public.touch_transport_quotes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_transport_quotes_updated_at ON public.transport_quotes;
CREATE TRIGGER trg_transport_quotes_updated_at
  BEFORE UPDATE ON public.transport_quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_transport_quotes_updated_at();
