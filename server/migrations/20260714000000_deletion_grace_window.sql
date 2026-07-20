-- 48h deletion grace window (PRIV-002 follow-up).
--
-- Deletion requests no longer erase immediately: the erase job may only run
-- once execute_after has passed, and the user can cancel the open request in
-- that window (POST /me/deletion-request/cancel). Export requests keep
-- execute_after = NOW() (immediate). Existing open deletion rows keep the
-- default (= already past), so nothing pending gets stuck by this migration.

ALTER TABLE account_requests
  ADD COLUMN IF NOT EXISTS execute_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
