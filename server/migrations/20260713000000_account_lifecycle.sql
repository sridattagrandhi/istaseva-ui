-- Account lifecycle: DSAR export + account deletion (PRIV-002 / LEG-003 / LEG-017).
--
-- account_requests is the status/audit spine for both flows: one row per
-- user-initiated export or deletion request. Deletion is soft-flag first
-- (user_profiles.is_deleted, enforced by require-auth like is_suspended),
-- then an async job hard-deletes/anonymizes across stores and marks the
-- request completed. The user_profiles row itself is ANONYMIZED, never
-- deleted, so the is_deleted flag keeps blocking any still-live tokens.

CREATE TABLE IF NOT EXISTS public.account_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('export', 'deletion')),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'processing', 'completed', 'failed', 'cancelled')),
  error TEXT,
  -- Export bundles live in S3 (uploads bucket, <userId>/exports/...); the
  -- download URL is presigned fresh on every GET, so only the key is stored.
  export_key TEXT,
  export_expires_at TIMESTAMPTZ,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_requests_user
  ON public.account_requests(user_id, requested_at DESC);

-- At most one open request per (user, type): POST endpoints are idempotent
-- and return the existing open request instead of stacking duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_requests_open_unique
  ON public.account_requests(user_id, type)
  WHERE status IN ('requested', 'processing');

-- The recovery sweeper scans for requested/stale-processing rows.
CREATE INDEX IF NOT EXISTS idx_account_requests_pending
  ON public.account_requests(status, requested_at)
  WHERE status IN ('requested', 'processing');

DROP TRIGGER IF EXISTS update_account_requests_updated_at ON public.account_requests;
CREATE TRIGGER update_account_requests_updated_at
  BEFORE UPDATE ON public.account_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Deletion soft-flag, mirroring the is_suspended shape from
-- 20260706010000_admin_suspension_and_listing_ban.sql.
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_user_profiles_deleted
  ON public.user_profiles(user_id)
  WHERE is_deleted;
