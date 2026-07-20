-- Per-room-type amenities. Multi-room stays (hotel/lodge/heritage/sathram)
-- often have different amenities per room class — a "Deluxe King" might have
-- AC + minibar + balcony, while a "Standard Twin" only has AC. The old
-- listing-level `listings.amenities` column was the only amenity surface,
-- which forced every room to share the same set. This column moves the
-- amenity story to per-room, with the listing-level array becoming an
-- optional "common areas" fallback used by single-unit homestays / legacy
-- rows. The stay filter on the consumer side reads the UNION of both, so
-- a chip query like "AC" matches a listing if ANY room (or the property
-- itself) advertises it.
--
-- Free-text string array, matching the listings.amenities convention so
-- adapters can swap between the two without coercion. Default '{}' keeps
-- every existing room row valid.

ALTER TABLE listing_room_types
  ADD COLUMN IF NOT EXISTS amenities TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN listing_room_types.amenities IS 'Amenities for this room class (AC, WiFi, balcony, …). UNION-ed with listings.amenities by the consumer-side filter.';
