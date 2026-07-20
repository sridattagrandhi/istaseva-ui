ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS amount_paise INTEGER;

UPDATE public.payments
SET amount_paise = ROUND(amount * 100)::INTEGER
WHERE amount_paise IS NULL
  AND amount IS NOT NULL;

ALTER TABLE public.payments
  ALTER COLUMN amount_paise SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'payments_amount_paise_positive_check'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_amount_paise_positive_check
      CHECK (amount_paise > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payments_provider_payment_id
  ON public.payments(provider_payment_id);

CREATE TABLE IF NOT EXISTS public.webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.cleanup_expired_booking_holds()
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  expired_lock_count INTEGER := 0;
  expired_booking_count INTEGER := 0;
BEGIN
  UPDATE public.slot_locks
  SET status = 'expired',
      released_at = NOW()
  WHERE status = 'active'
    AND expires_at + INTERVAL '60 seconds' < NOW();

  GET DIAGNOSTICS expired_lock_count = ROW_COUNT;

  UPDATE public.bookings
  SET status = 'expired',
      expired_at = NOW(),
      updated_at = NOW()
  WHERE status = 'pending'
    AND hold_expires_at IS NOT NULL
    AND hold_expires_at + INTERVAL '60 seconds' < NOW();

  GET DIAGNOSTICS expired_booking_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'expired_locks', expired_lock_count,
    'expired_bookings', expired_booking_count
  );
END;
$$;
