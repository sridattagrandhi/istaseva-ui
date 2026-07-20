-- User wishlists (the "Saved" tab in the Guest Dashboard).
--
-- One row = "user X has saved listing Y of kind Z". Composite primary key
-- enforces idempotent toggles (INSERT ... ON CONFLICT DO NOTHING) and lets
-- us partition by listing_type cheaply for the tabbed UI.
--
-- No FK on user_id — user identities live outside this schema (see the
-- existing user_id columns on other tables, which also carry no FK). No FK
-- on listing_id either: the column accepts any listing id across stay /
-- service / transport, and stale saves are rendered conditionally on the
-- client based on the live listings fetch.
CREATE TABLE IF NOT EXISTS user_wishlists (
  user_id      TEXT NOT NULL,
  listing_id   UUID NOT NULL,
  listing_type TEXT NOT NULL CHECK (listing_type IN ('stay', 'service', 'transport')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, listing_id, listing_type)
);

CREATE INDEX IF NOT EXISTS idx_user_wishlists_user ON user_wishlists(user_id);
