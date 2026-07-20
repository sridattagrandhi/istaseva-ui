-- Host-issued discount codes.
--
-- A coupon belongs to a host (user_profiles.user_id — TEXT since the UUID→TEXT
-- migration) and optionally to a specific listing. If listing_id is NULL the
-- coupon is valid across every listing the host owns.
--
-- Codes are case-insensitive; we store them uppercased and enforce global
-- uniqueness so redemption can look up purely by code.
--
-- Redemption semantics:
--   * percent discounts are capped at 100%
--   * fixed discounts are rupees (numeric, not paise) to mirror listing.price
--   * uses_count is incremented atomically when a booking using this coupon
--     transitions to confirmed (or at hold time — see coupons.service.ts)
--
-- We also add a nullable coupon_id column on bookings so the applied discount
-- is traceable per-booking.

CREATE TABLE IF NOT EXISTS public.coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_user_id TEXT NOT NULL,
  listing_id UUID REFERENCES public.listings(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value NUMERIC NOT NULL CHECK (discount_value > 0),
  max_uses INTEGER,
  uses_count INTEGER NOT NULL DEFAULT 0,
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (discount_type <> 'percent' OR discount_value <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_code_unique ON public.coupons (UPPER(code));
CREATE INDEX IF NOT EXISTS idx_coupons_host ON public.coupons (host_user_id);
CREATE INDEX IF NOT EXISTS idx_coupons_listing ON public.coupons (listing_id);

-- Track which coupon (if any) was applied to a booking. Nullable.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS coupon_id UUID REFERENCES public.coupons(id) ON DELETE SET NULL;
