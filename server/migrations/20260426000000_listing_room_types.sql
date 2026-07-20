-- Hotel-style listings can have multiple room types (e.g. "Deluxe King",
-- "Family Suite") with their own price, capacity, and photos. A booking on
-- such a listing is for a specific room type. Non-hotel stays (homestays)
-- keep the single-price model on `listings` itself — they just don't have
-- room rows.
--
-- Composite PK isn't necessary; we use a UUID id so the room type can be
-- referenced cleanly from `bookings.room_type_id`. Soft-delete is via
-- removing the row — bookings already keep their own snapshot of price in
-- `agreed_price_paise`, so a deleted room type doesn't break history.
CREATE TABLE IF NOT EXISTS listing_room_types (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id       UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  base_price_paise BIGINT NOT NULL CHECK (base_price_paise >= 0),
  max_guests       INT NOT NULL DEFAULT 2 CHECK (max_guests > 0),
  photos           TEXT[] NOT NULL DEFAULT '{}',
  sort_order       INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listing_room_types_listing
  ON listing_room_types(listing_id, sort_order);

-- A booking points at a specific room type when the listing has rooms.
-- Nullable so existing rows and non-room listings (services, transport,
-- non-hotel stays) stay valid. ON DELETE SET NULL because bookings are
-- preserved for history even if a room is later removed.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS room_type_id UUID REFERENCES listing_room_types(id) ON DELETE SET NULL;
