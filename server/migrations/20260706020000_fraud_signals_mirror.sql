-- Admin ops console: Postgres mirror of fraud signals.
--
-- The authoritative event stream stays in DynamoDB (fraud_signals table,
-- 1-year TTL, partitioned by userId) — good for per-user timelines, unusable
-- for the ops console's cross-user questions ("all critical signals this
-- week", "top event types"). fraudSignalsService.createSignal dual-writes
-- here; no backfill — the screen starts at deploy time. Mirror-write failures
-- must never block signal ingestion (best-effort, logged).

CREATE TABLE IF NOT EXISTS public.fraud_signals (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text NOT NULL,
  event_type text NOT NULL,
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  device_id  text,
  session_id text,
  ip_address text,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fraud_signals_risk
  ON public.fraud_signals (risk_level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_user
  ON public.fraud_signals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_type
  ON public.fraud_signals (event_type, created_at DESC);
