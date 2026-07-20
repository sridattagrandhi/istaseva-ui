-- Fix: user_wishlists.user_id was created as UUID, but user IDs are
-- Firebase UIDs (TEXT) across the rest of the system — see 20260411100000
-- which converted user_id columns elsewhere from UUID to TEXT. The
-- wishlist migration missed that change, so every INSERT failed with
-- "invalid input syntax for type uuid".
--
-- ALTER TYPE TEXT is a no-op when the column is already TEXT, so this is
-- safe on fresh installs that picked up the corrected base migration too.
ALTER TABLE user_wishlists ALTER COLUMN user_id TYPE TEXT;
