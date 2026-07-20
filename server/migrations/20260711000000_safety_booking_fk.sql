-- SEC-006 hardening: safety_alerts.booking_id / safety_checks.booking_id were
-- bare UUID columns with no FK, so any value (including bookings that never
-- existed) could be persisted. Service-level ownership checks now guard the
-- API path; this backs the invariant at the DB level.
--
-- ON DELETE SET NULL: a safety record must outlive its booking (it is an
-- emergency/audit trail), so deleting a booking detaches rather than cascades.

-- Detach any pre-existing dangling references before adding the constraints.
UPDATE public.safety_alerts sa
   SET booking_id = NULL
 WHERE sa.booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.bookings b WHERE b.id = sa.booking_id);

UPDATE public.safety_checks sc
   SET booking_id = NULL
 WHERE sc.booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.bookings b WHERE b.id = sc.booking_id);

ALTER TABLE public.safety_alerts
  DROP CONSTRAINT IF EXISTS fk_safety_alerts_booking;
ALTER TABLE public.safety_alerts
  ADD CONSTRAINT fk_safety_alerts_booking
  FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;

ALTER TABLE public.safety_checks
  DROP CONSTRAINT IF EXISTS fk_safety_checks_booking;
ALTER TABLE public.safety_checks
  ADD CONSTRAINT fk_safety_checks_booking
  FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;
