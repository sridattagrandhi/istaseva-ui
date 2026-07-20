-- Admin ops console: platform coupons + queryable redemptions.
--
-- 1. Platform coupons — created by admins, not tied to a host.
--    host_user_id becomes nullable; is_platform=true marks them and skips the
--    host-ownership check at quote/consume time. Host coupon behavior is
--    unchanged (is_platform defaults false, host_user_id still set).
--
-- 2. coupon_users — "certain people" targeting. When a coupon has rows here,
--    only those user_ids may redeem it. No rows = open to everyone in scope.
--
-- 3. coupon_redemptions — who redeemed what, on which booking, for how much.
--    uses_count alone can't answer any of that. Written inside the same
--    transaction as the booking hold, right after the booking row exists.

ALTER TABLE public.coupons
  ALTER COLUMN host_user_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS is_platform boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by  text;  -- admin Firebase UID for platform coupons

-- A coupon must be either a host coupon (owner set) or a platform coupon.
ALTER TABLE public.coupons
  DROP CONSTRAINT IF EXISTS coupons_owner_or_platform;
ALTER TABLE public.coupons
  ADD CONSTRAINT coupons_owner_or_platform
  CHECK (host_user_id IS NOT NULL OR is_platform);

CREATE TABLE IF NOT EXISTS public.coupon_users (
  coupon_id uuid NOT NULL REFERENCES public.coupons(id) ON DELETE CASCADE,
  user_id   text NOT NULL,
  PRIMARY KEY (coupon_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_users_user ON public.coupon_users (user_id);

CREATE TABLE IF NOT EXISTS public.coupon_redemptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id      uuid NOT NULL REFERENCES public.coupons(id) ON DELETE CASCADE,
  booking_id     uuid,
  user_id        text NOT NULL,
  discount_paise integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon
  ON public.coupon_redemptions (coupon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user
  ON public.coupon_redemptions (user_id, created_at DESC);
