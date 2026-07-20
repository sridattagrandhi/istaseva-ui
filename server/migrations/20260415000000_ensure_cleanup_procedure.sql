-- Idempotent: ensures cleanup_expired_booking_holds() exists.
-- Safe to run even if 0001/0002 already applied it.
CREATE OR REPLACE FUNCTION public.cleanup_expired_booking_holds()
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  expired_lock_count    INTEGER := 0;
  expired_booking_count INTEGER := 0;
BEGIN
  -- Expire any slot locks whose hold window has passed
  UPDATE public.slot_locks
  SET    status      = 'expired',
         released_at = NOW()
  WHERE  status    = 'active'
    AND  expires_at <= NOW();

  GET DIAGNOSTICS expired_lock_count = ROW_COUNT;

  -- Expire any pending bookings whose hold window has passed
  UPDATE public.bookings
  SET    status     = 'expired',
         expired_at = NOW(),
         updated_at = NOW()
  WHERE  status          = 'pending'
    AND  hold_expires_at IS NOT NULL
    AND  hold_expires_at <= NOW();

  GET DIAGNOSTICS expired_booking_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'expired_locks',    expired_lock_count,
    'expired_bookings', expired_booking_count
  );
END;
$$;
