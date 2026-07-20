-- Per-date availability + pricing overrides on listings (and on individual
-- rooms within a hotel-style listing). Default behaviour is "available at
-- base price" — a row only exists when the host has explicitly blocked the
-- date or set a custom price for it.
--
-- The (listing_id, room_type_id, date) shape lets a hotel host override at
-- either the room level (specific rooms get a different price on a date)
-- or the listing level (whole listing blocked, e.g. closed for renovation).
-- For non-hotel stays, room_type_id is always NULL.
--
-- We store NULL room_type_id rather than a synthetic "default room" so the
-- pricing-resolution logic stays simple: room override wins, else listing
-- override, else base price.
CREATE TABLE IF NOT EXISTS listing_availability_overrides (
  listing_id    UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  room_type_id  UUID REFERENCES listing_room_types(id) ON DELETE CASCADE,
  date          DATE NOT NULL,
  blocked       BOOLEAN NOT NULL DEFAULT FALSE,
  -- NULL means "no price override" — base_price_paise from the listing/room
  -- is used. Stored as the night's full rate in paise.
  price_paise   BIGINT CHECK (price_paise IS NULL OR price_paise >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite uniqueness: one override row per (listing, room-or-null, date).
-- We use a partial unique index because PostgreSQL treats NULLs as distinct
-- in a normal UNIQUE constraint, which would let multiple "listing-level"
-- overrides exist for the same date.
CREATE UNIQUE INDEX IF NOT EXISTS idx_avail_override_room
  ON listing_availability_overrides(listing_id, room_type_id, date)
  WHERE room_type_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_avail_override_listing
  ON listing_availability_overrides(listing_id, date)
  WHERE room_type_id IS NULL;

-- Range queries by listing + date (booking flow + host calendar).
CREATE INDEX IF NOT EXISTS idx_avail_override_listing_date
  ON listing_availability_overrides(listing_id, date);
