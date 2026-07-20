-- Admin listing takedown ("delete") — a SOFT archive, deliberately not a row
-- deletion: bookings/payments reference listings for invoices, disputes and
-- GST-retention obligations, and several child tables (room types,
-- availability overrides, listing coupons, fee rules) cascade on a hard
-- DELETE. Archive mirrors the ban machinery (20260706010000): separate
-- admin-only columns outside LISTING_MUTABLE_FIELDS so the owner can never
-- clear them, public-surface queries exclude archived rows, and a trigger
-- makes "no new bookings on an archived listing" hold for every insert path.
--
-- archive ≠ ban: ban is a policy-violation state (host sees the reason, admin
-- may unban after remediation); archive is a takedown/removal. Self-serve
-- host/provider/driver deletion is gone entirely — only admins archive.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS archived_at     timestamptz,
  ADD COLUMN IF NOT EXISTS archived_reason text,
  ADD COLUMN IF NOT EXISTS archived_by     text;  -- admin Firebase UID

CREATE INDEX IF NOT EXISTS idx_listings_archived
  ON public.listings (id) WHERE archived_at IS NOT NULL;

-- Extend the booking-reject invariant to cover archived listings too.
CREATE OR REPLACE FUNCTION public.reject_booking_on_banned_listing()
RETURNS trigger AS $$
BEGIN
  IF NEW.listing_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = NEW.listing_id AND (l.banned_at IS NOT NULL OR l.archived_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'listing % is banned or archived and cannot be booked', NEW.listing_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
