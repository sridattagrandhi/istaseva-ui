-- Scope a coupon to a listing category (stay / service / transport).
--
-- Background: coupons.listing_id is nullable to mean "any of the host's
-- listings". That was fine when hosts only owned stays, but now the same
-- user can own services + transport too. Without a kind, a coupon created
-- from the Transport-side dashboard would silently apply to a stay or
-- service booking too — the user explicitly does NOT want that.
--
-- Resolution: add `category` (TEXT, nullable) that restricts the coupon to
-- bookings whose listing.listing_type matches. NULL = legacy semantics
-- ("any of the owner's listings"), so existing rows continue to work.

ALTER TABLE public.coupons
  ADD COLUMN IF NOT EXISTS category TEXT
    CHECK (category IS NULL OR category IN ('stay', 'service', 'transport'));

-- Filtering coupons by category on listMine becomes a hot path once the
-- provider / transport dashboards land.
CREATE INDEX IF NOT EXISTS idx_coupons_host_category
  ON public.coupons (host_user_id, category);
