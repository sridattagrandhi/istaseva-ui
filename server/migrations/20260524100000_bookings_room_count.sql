-- Multi-room booking support for stays. A guest booking N rooms of one
-- room type (e.g. 3 "Non-AC" rooms in a sathram) is still ONE booking row
-- — `room_count` captures how many physical rooms it occupies.
--
-- DEFAULT 1 leaves every existing booking unchanged. The conflict check in
-- bookings.repository.ts now sums `room_count` against
-- `listing_room_types.quantity` instead of counting rows, so a single
-- multi-room booking consumes its full share of the inventory.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS room_count INT NOT NULL DEFAULT 1 CHECK (room_count > 0);
