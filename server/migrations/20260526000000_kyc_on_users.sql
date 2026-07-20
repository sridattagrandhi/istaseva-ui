-- Move KYC from provider_profiles to the user level.
-- Verification is a per-human concept, not a per-role one.
--
-- Note: this codebase does not have a dedicated `users` table — the auth
-- user id is the Firebase UID and per-user data lives in `user_profiles`
-- (UNIQUE user_id). We add the KYC columns there.  The
-- `verification_documents.user_id` column is a bare UUID (auth UID), with
-- no DB-level FK, to match the existing pattern used by `user_profiles.
-- user_id` and `provider_profiles.user_id`.

-- 1. New user-level KYC fields on user_profiles
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- 2. Backfill from provider_profiles (1:1 via UNIQUE user_id).
--    Users without a provider profile keep the default 'pending'.
UPDATE public.user_profiles up
SET verification_status = pp.verification_status,
    verified_at = pp.verified_at
FROM public.provider_profiles pp
WHERE pp.user_id = up.user_id;

-- 3. Documents gain user_id (the auth UID), backfilled via the existing
--    provider_id link. Every existing verification_documents row has a
--    valid provider_id → provider_profiles.user_id link.
--    Type is TEXT to match user_profiles.user_id / provider_profiles.user_id
--    (auth UIDs are Firebase strings, not UUIDs — see migration
--    20260411100000_user_id_uuid_to_text.sql).
ALTER TABLE public.verification_documents
  ADD COLUMN IF NOT EXISTS user_id TEXT;

UPDATE public.verification_documents vd
SET user_id = pp.user_id
FROM public.provider_profiles pp
WHERE vd.provider_id = pp.id AND vd.user_id IS NULL;

-- 4. After backfill, user_id is required; provider_id goes away.
ALTER TABLE public.verification_documents
  ALTER COLUMN user_id SET NOT NULL;

DROP INDEX IF EXISTS idx_verification_documents_provider_id;

ALTER TABLE public.verification_documents
  DROP COLUMN IF EXISTS provider_id;

CREATE INDEX IF NOT EXISTS idx_verification_documents_user_id
  ON public.verification_documents(user_id, created_at DESC);

-- 5. Drop the old columns on provider_profiles.
ALTER TABLE public.provider_profiles
  DROP COLUMN IF EXISTS verification_status,
  DROP COLUMN IF EXISTS verified_at;
