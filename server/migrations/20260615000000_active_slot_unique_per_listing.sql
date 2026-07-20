-- Booking active-slot uniqueness: scope per-LISTING, and exclude multi-room stays.
--
-- The original index (0001_portable_initial_schema.sql) was:
--   UNIQUE (provider_id, scheduled_date, start_time, end_time)
--     WHERE status IN ('pending','confirmed','in_progress')
--
-- Two correctness problems, both surfaced by the Ista AI sathram flow:
--
-- 1) PROVIDER-scoped, not LISTING-scoped. A host owns multiple listings under
--    one provider_profile (a cab + a salon, a sathram + a hotel). The
--    booking-scope invariant is per-LISTING (see CLAUDE.md). With provider
--    scoping, booking listing B falsely collided with an existing active
--    booking on listing A whenever they shared the default window — e.g. two
--    stays under one host both default to a 14:00 check-in on the same date,
--    so the second booking died with "This time slot was just taken" even
--    though nothing on listing B was booked. The row-level conflict check
--    (findConflictingBookingsForUpdate) is already per-listing; only this DB
--    index lagged behind.
--
-- 2) Stays don't have slot exclusivity — they have ROOM INVENTORY. A hotel /
--    sathram with 5 Single rooms can hold 5 concurrent bookings on the same
--    date. A unique slot index can't model "up to quantity"; that's enforced
--    by room_count + the FOR UPDATE quantity check under an advisory lock.
--    Multi-room stay bookings carry a non-null room_type_id, so we exclude
--    them here and let the counting path own their concurrency.
--
-- Net effect of the new index:
--   - services / transport            (room_type_id NULL): one active booking
--     per (listing, date, time-slot). Correct, and now listing-scoped.
--   - single-unit stays / homestays   (room_type_id NULL): one active booking
--     per (listing, date-range). Correct — a single unit can't double-book.
--   - multi-room stays (hotel/lodge/heritage/sathram, room_type_id NOT NULL):
--     EXCLUDED; concurrency = room_count + findConflictingBookingsForUpdate.
--
-- COALESCE(listing_id, provider_id) keeps protection for any legacy rows that
-- predate listing_id (both columns are uuid); new bookings always set
-- listing_id, so in practice this scopes by listing.

DROP INDEX IF EXISTS idx_bookings_active_slot_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_active_slot_unique
  ON public.bookings (COALESCE(listing_id, provider_id), scheduled_date, start_time, end_time)
  WHERE status IN ('pending', 'confirmed', 'in_progress') AND room_type_id IS NULL;
