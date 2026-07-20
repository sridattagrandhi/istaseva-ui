-- Fix: fee_rules.created_by / deactivated_by were declared UUID, but user
-- ids in this system are Firebase uids — opaque TEXT ("gnWuth6hys…"), not
-- UUIDs. Every authenticated rule create blew up with
--   invalid input syntax for type uuid
-- before the row was even validated. TEXT matches the house convention
-- (admin_actions.actor_user_id, bookings.user_id/created_by_user_id are all
-- TEXT for the same reason — see 20260705150000_created_by_user_id_text).
--
-- USING ...::text keeps any existing values (there are none in practice —
-- inserts failed — but idempotent-safe either way).

ALTER TABLE public.fee_rules
  ALTER COLUMN created_by TYPE TEXT USING created_by::text,
  ALTER COLUMN deactivated_by TYPE TEXT USING deactivated_by::text;
