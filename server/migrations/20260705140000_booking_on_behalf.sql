-- Host-books-on-behalf → guest pays via QR/payment-link.
--
-- A host creates a booking for a walk-up guest who has no account. The row is
-- an ordinary `pending` hold (so every existing conflict/availability/sweeper
-- path treats it identically) but with a long `hold_expires_at` and these
-- extra columns:
--   booked_on_behalf   — flags the row so per-user guards (pending cap, single
--                        active hold per provider) can ignore it; a host may
--                        hold many such slots at once.
--   created_by_user_id — the host who made it (audit / dashboard scoping).
--   guest_contact      — { name, phone, email? } of the paying guest. This is
--                        who the confirmation SMS/email targets, NOT user_id
--                        (which stays the host, preserving ownership/access).
--   payment_link_id/url — the Razorpay Payment Link that delivers the QR.

-- NOTE: user ids in this system are Firebase UIDs (TEXT), not UUIDs —
-- bookings.user_id and user_profiles.user_id are both text. created_by_user_id
-- must match or inserts fail with "invalid input syntax for type uuid".
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS booked_on_behalf   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by_user_id text,
  ADD COLUMN IF NOT EXISTS guest_contact      jsonb,
  ADD COLUMN IF NOT EXISTS payment_link_id    text,
  ADD COLUMN IF NOT EXISTS payment_link_url   text;

-- Host dashboard lists "bookings I made for guests" by creator.
CREATE INDEX IF NOT EXISTS idx_bookings_created_by
  ON public.bookings (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;
