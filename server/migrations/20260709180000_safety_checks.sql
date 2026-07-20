-- Safety checks table, referenced by:
--   • safety.service.ts createCheck() — POST /api/safety/checks
--     (web SafetyCheckModal posts in-stay safety check responses)
--
-- Same story as safety_alerts (20260419000000): the table was expected from
-- the original Supabase seed and never made it into the portable schema, so
-- any DB provisioned from server/migrations/ threw
-- `relation "safety_checks" does not exist` on that endpoint.
-- Columns mirror the INSERT in safety.service.ts:47.

CREATE TABLE IF NOT EXISTS public.safety_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID,
  check_type TEXT NOT NULL,
  -- User id (TEXT to match safety_alerts.user_id — Firebase uids) of whoever
  -- initiated the check.
  initiated_by TEXT,
  response TEXT,
  is_resolved BOOLEAN NOT NULL DEFAULT true,
  severity TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_safety_checks_booking_id ON public.safety_checks (booking_id);
CREATE INDEX IF NOT EXISTS idx_safety_checks_created_at ON public.safety_checks (created_at DESC);
