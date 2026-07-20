-- Payouts ledger + partner payout accounts.
--
-- Money flow reality: Razorpay settles ALL customer payments into the
-- platform's account; nothing pays hosts automatically. This migration adds
-- the bookkeeping half of payouts:
--   payout_accounts — where a partner wants their money (bank or UPI),
--                     one ACTIVE account per user (partial unique index).
--   payouts         — the ledger. One row per recorded payout. Recording is
--                     manual (admin console) for now; when RazorpayX/Route
--                     is wired, the executor writes the same rows.
--   bookings.payout_id — stamps which payout covered each booking, so
--                     "pending vs paid" is answerable per booking and a
--                     booking can never be paid out twice.
--
-- A booking is PAYABLE when (enforced in SQL by the admin/provider services,
-- kept in one place there):
--   effectively completed (status='completed', or confirmed/in_progress with
--   a past date — mirrors the earnings predicate) AND a completed payment
--   exists AND no refund exists AND payout_id IS NULL AND the fee-breakdown
--   snapshot exists (subtotal_paise NOT NULL; legacy rows without it are
--   excluded rather than guessed at).
-- Payable amount per booking = subtotal − discount − commission (all
-- snapshotted at hold time; NULL commission = 0).

CREATE TABLE IF NOT EXISTS public.payout_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Firebase uid (TEXT, same convention as bookings.user_id).
  user_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('bank', 'upi')),
  account_holder TEXT,
  account_number TEXT,
  ifsc TEXT,
  upi_id TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payout_accounts_method_shape CHECK (
    (method = 'bank' AND account_holder IS NOT NULL AND account_number IS NOT NULL AND ifsc IS NOT NULL AND upi_id IS NULL) OR
    (method = 'upi'  AND upi_id IS NOT NULL AND account_number IS NULL AND ifsc IS NULL)
  )
);

-- One active payout destination per partner; edits deactivate + insert so
-- old payout rows keep pointing at the details that were actually used.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_accounts_one_active
  ON public.payout_accounts (user_id) WHERE active;

CREATE TABLE IF NOT EXISTS public.payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_user_id TEXT NOT NULL,
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  booking_count INTEGER NOT NULL CHECK (booking_count > 0),
  method TEXT NOT NULL,
  -- MASKED destination frozen at payout time (last-4 only) — the ledger must
  -- stay meaningful after the partner changes accounts, without holding a
  -- second full copy of the credentials.
  account_snapshot JSONB,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'reversed')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payouts_provider
  ON public.payouts (provider_user_id, created_at DESC);

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS payout_id UUID REFERENCES public.payouts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_payout
  ON public.bookings (payout_id) WHERE payout_id IS NOT NULL;
