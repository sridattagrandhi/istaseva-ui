-- Safety alerts table, referenced by:
--   • safety.service.ts            — SOS / user-initiated alerts
--   • fraud-signals.service.ts     — auto-created when a fraud signal is critical
--
-- Originally expected to be seeded by Supabase; missing from the portable
-- schema until now, which caused fraud-signal criticality writes to throw
-- `relation "safety_alerts" does not exist`.

CREATE TABLE IF NOT EXISTS public.safety_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  booking_id UUID,
  alert_type TEXT NOT NULL,
  description TEXT,
  location_lat DOUBLE PRECISION,
  location_lng DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'open',
  emergency_contacts_notified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_safety_alerts_user_id      ON public.safety_alerts (user_id);
CREATE INDEX IF NOT EXISTS idx_safety_alerts_booking_id   ON public.safety_alerts (booking_id);
CREATE INDEX IF NOT EXISTS idx_safety_alerts_status       ON public.safety_alerts (status);
CREATE INDEX IF NOT EXISTS idx_safety_alerts_created_at   ON public.safety_alerts (created_at DESC);
