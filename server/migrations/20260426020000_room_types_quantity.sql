-- Hotels typically have multiple physical rooms of the same type (e.g. five
-- "Deluxe King" rooms). The room TYPE row already carried name/price/photos
-- per type — quantity captures how many of that type exist, which lets the
-- booking flow accept up to N concurrent bookings on the same night for the
-- same type.
--
-- DEFAULT 1 keeps every existing row valid and behaves identically for
-- single-room hotels: the booking conflict check stays "block the date when
-- count(bookings) >= quantity", and 1 reproduces the old behaviour.
ALTER TABLE listing_room_types
  ADD COLUMN IF NOT EXISTS quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0);
