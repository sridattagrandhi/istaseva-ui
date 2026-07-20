-- Add a strongly-typed `listing_type` discriminator on `listings` so
-- transport / stay / service can never silently merge. Until now, the
-- distinction lived in `metadata->>'listingType'` (JSONB string match) plus
-- ad-hoc category heuristics in the app layer. That worked, but a single
-- mistyped category at onboarding could leak a service into the transport
-- tab — which is exactly what this enforces against.
--
-- Strategy:
--   1. Add the column nullable so backfill can run.
--   2. Backfill from existing data using the same priority the app already
--      uses (metadata first, then category mapping).
--   3. Tighten to NOT NULL + CHECK after backfill.
--   4. Index it so the public listings query can filter cheaply.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS listing_type TEXT;

-- Backfill in priority order: metadata wins (set explicitly during onboarding),
-- then category-based inference, then a safe default of 'service'.
UPDATE public.listings
SET listing_type = CASE
    WHEN metadata->>'listingType' IN ('stay', 'service', 'transport')
      THEN metadata->>'listingType'
    WHEN vehicle_name IS NOT NULL
      OR category IN ('auto', 'cab', 'van', 'bike', 'tempo', 'driver-auto', 'driver-cab')
      THEN 'transport'
    WHEN property_type IS NOT NULL
      OR price_per_night IS NOT NULL
      OR category IN ('hotel', 'homestay', 'lodge', 'village-stay', 'farm-stay', 'heritage', 'stay')
      OR category LIKE 'stay:%'
      THEN 'stay'
    ELSE 'service'
  END
WHERE listing_type IS NULL;

-- Lock it down: must be present, must be one of the three known kinds.
ALTER TABLE public.listings
  ALTER COLUMN listing_type SET NOT NULL,
  ADD CONSTRAINT listings_listing_type_check
    CHECK (listing_type IN ('stay', 'service', 'transport'));

-- Public/dashboard queries filter on this column on every load — keep it
-- indexed alongside is_active so the planner can use it for the marketplace
-- list endpoint.
CREATE INDEX IF NOT EXISTS idx_listings_type_active
  ON public.listings (listing_type, is_active);
