-- Fix: created_by_user_id was created as uuid, but user ids in this system are
-- Firebase UIDs (TEXT — same as bookings.user_id / user_profiles.user_id), so
-- host-on-behalf inserts failed with "invalid input syntax for type uuid".
-- Idempotent: casting text→text is a no-op for DBs that got the corrected
-- initial migration.
ALTER TABLE public.bookings
  ALTER COLUMN created_by_user_id TYPE text USING created_by_user_id::text;
