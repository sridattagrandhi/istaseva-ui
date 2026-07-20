-- Per-user coupon redemption cap.
--
-- Previously only the global `max_uses` was enforced, so a single account could
-- redeem the same "50% off" code on every booking. This adds a per-user cap.
--
-- Default 1 = once per customer, the near-universal intent. Existing rows are
-- backfilled to 1 by the constant DEFAULT. Set a higher integer, or NULL for
-- unlimited-per-user, on coupons deliberately meant to be repeatable by the
-- same person.
--
-- Enforcement lives in coupons.service.consume(): after the coupon row is
-- locked (by the uses_count UPDATE) it counts this user's prior redemptions and
-- rejects the hold when the cap is reached. Concurrent holds by the same guest
-- serialize on that row lock, so the count can't be raced. The composite index
-- keeps that count cheap inside the booking-hold transaction.

ALTER TABLE public.coupons
  ADD COLUMN IF NOT EXISTS max_uses_per_user INTEGER DEFAULT 1;

ALTER TABLE public.coupons
  DROP CONSTRAINT IF EXISTS coupons_max_uses_per_user_positive;
ALTER TABLE public.coupons
  ADD CONSTRAINT coupons_max_uses_per_user_positive
  CHECK (max_uses_per_user IS NULL OR max_uses_per_user > 0);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_user
  ON public.coupon_redemptions (coupon_id, user_id);
