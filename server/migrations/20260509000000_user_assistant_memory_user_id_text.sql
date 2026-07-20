-- Phase 4 follow-up.
--
-- The original 20260508120000_user_assistant_memory.sql declared
-- user_id as UUID. That was wrong: this stack uses Firebase / Cognito
-- for auth, and their UIDs are 28-char alphanumeric strings, not RFC-4122
-- UUIDs. The same widening was done historically for other user-id
-- columns in 20260411100000_user_id_uuid_to_text.sql; this migration
-- closes that gap for user_assistant_memory.
--
-- Safe to run unconditionally:
--   * The table is empty in any environment that has it — writes have
--     been failing since Phase 4 shipped because the firebase UID
--     never matched the UUID type, so there's no data to coerce.
--   * `ALTER COLUMN ... TYPE TEXT USING user_id::text` casts whatever
--     UUID values DID make it in (none expected) cleanly.

ALTER TABLE public.user_assistant_memory
  ALTER COLUMN user_id TYPE TEXT USING user_id::text;
