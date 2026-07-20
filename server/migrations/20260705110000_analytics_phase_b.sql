-- Phase B analytics: cancellations/refunds, reviews, coupons, wishlist.
-- All additive columns on the daily overview rollup; populated going forward.
ALTER TABLE public.analytics_daily_overview
  ADD COLUMN IF NOT EXISTS bookings_cancelled   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_paise         BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reviews_submitted    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reviews_rating_sum   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coupons_applied      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coupons_failed       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_paise       BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wishlist_adds        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wishlist_removes     INTEGER NOT NULL DEFAULT 0;
