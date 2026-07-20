-- Hotel-style listings have multi-room properties (hotel, lodge, heritage)
-- where the property-level bedrooms/bathrooms/max_guests numbers don't make
-- physical sense — those describe an individual room, not the whole hotel.
-- Move those into the room-type row so each "Deluxe King" / "Family Suite"
-- row carries its own physical layout.
--
-- unit_identifiers captures the actual room numbers / labels for each
-- physical room of this type. Examples:
--   ["101","102","103","104","105","106","107","108"]   -- a small hotel
--   ["8a","8b","8c"]                                     -- floor-letter scheme
--   []                                                   -- host doesn't number rooms; quantity alone is enough
--
-- The array is purely informational here; future booking logic can use it
-- to auto-assign a room number on confirm. Keep it nullable-equivalent
-- (default '{}') so existing rows and quantity-only listings stay valid.

ALTER TABLE listing_room_types
  ADD COLUMN IF NOT EXISTS bedrooms INT NOT NULL DEFAULT 1 CHECK (bedrooms >= 0),
  ADD COLUMN IF NOT EXISTS bathrooms INT NOT NULL DEFAULT 1 CHECK (bathrooms >= 0),
  ADD COLUMN IF NOT EXISTS unit_identifiers TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN listing_room_types.bedrooms IS 'Bedrooms WITHIN one room of this type (e.g. 1 for "Deluxe King", 2 for "Family Suite").';
COMMENT ON COLUMN listing_room_types.bathrooms IS 'Bathrooms WITHIN one room of this type.';
COMMENT ON COLUMN listing_room_types.unit_identifiers IS 'Optional room numbers/labels for each physical room of this type. If non-empty, length should equal quantity.';
