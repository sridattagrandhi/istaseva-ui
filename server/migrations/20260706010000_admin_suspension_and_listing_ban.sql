-- Admin ops console: enforcement primitives.
--
-- 1. User suspension — user_profiles.is_suspended. Enforced at the API layer
--    (require-auth checks a Redis-cached copy of this flag on every request,
--    and Firebase-disable blocks new sign-ins) and excluded from public
--    listing surfaces. The column here is the source of truth the cache
--    refills from.
--
-- 2. Listing ban — deliberately SEPARATE from is_active/is_published (both
--    host-controlled via the listings PATCH allowlist). banned_* columns are
--    NOT in LISTING_MUTABLE_FIELDS, so a host cannot clear them; only the
--    admin ban/unban endpoints write them.
--
-- 3. DB invariant (per repo rules): a booking row must never be created for
--    a banned listing, no matter which code path inserts it. Service-level
--    checks exist too, but the trigger is what makes the rule hold for every
--    future path (on-behalf, agent tools, admin, ...).

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS is_suspended      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspended_at      timestamptz,
  ADD COLUMN IF NOT EXISTS suspension_reason text;

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS banned_at     timestamptz,
  ADD COLUMN IF NOT EXISTS banned_reason text,
  ADD COLUMN IF NOT EXISTS banned_by     text;  -- admin Firebase UID

-- Public-surface queries filter on these; partial indexes keep them cheap.
CREATE INDEX IF NOT EXISTS idx_user_profiles_suspended
  ON public.user_profiles (user_id) WHERE is_suspended;
CREATE INDEX IF NOT EXISTS idx_listings_banned
  ON public.listings (id) WHERE banned_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.reject_booking_on_banned_listing()
RETURNS trigger AS $$
BEGIN
  IF NEW.listing_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = NEW.listing_id AND l.banned_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'listing % is banned and cannot be booked', NEW.listing_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reject_booking_on_banned_listing ON public.bookings;
CREATE TRIGGER trg_reject_booking_on_banned_listing
  BEFORE INSERT ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_booking_on_banned_listing();
