-- Persist the fee breakdown that drives cancellation refunds, host payouts,
-- and the GST invoice line items. Until now `payments.amount_paise` was the
-- only money field stored, so we couldn't compute "refund subtotal but keep
-- the platform fee" or settle the host's share independently.
--
-- All columns are nullable so legacy rows don't break; insertPayment will
-- populate them going forward.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS subtotal_paise          INTEGER,
  ADD COLUMN IF NOT EXISTS platform_fee_paise      INTEGER,
  ADD COLUMN IF NOT EXISTS taxes_paise             INTEGER,
  ADD COLUMN IF NOT EXISTS insurance_premium_paise INTEGER,
  -- Actual amount sent back to the customer's source instrument. NULL until a
  -- refund is issued; matches what we passed to Razorpay refundPayment.
  ADD COLUMN IF NOT EXISTS refund_paise            INTEGER;

-- Cancellation policy lives on the listing — host's choice, surfaced to
-- guests at booking time. Default 'flexible' so existing listings behave
-- exactly as before (full refund) until hosts opt into a stricter policy.
DO $$ BEGIN
  CREATE TYPE public.cancellation_policy AS ENUM ('flexible', 'moderate', 'strict');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS cancellation_policy public.cancellation_policy NOT NULL DEFAULT 'flexible';
