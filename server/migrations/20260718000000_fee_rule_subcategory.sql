-- Fee rules by SPECIFIC service type (admin Fees panel).
--
-- `category` on fee_rules is the VERTICAL (stays/services/transport).
-- `subcategory` narrows a rule one level further, to a specific listing
-- category within that vertical — e.g. category='services' +
-- subcategory='salon' charges salons differently from cleaners.
--
-- Values are LISTING categories (listings.category: 'hotel', 'salon',
-- 'driver-cab', …) — the same values the admin facet pickers offer — NOT the
-- differently-prefixed booking service_category snapshots ('stay:hotel',
-- 'driver-hourly'). The resolver matches subcategory against the LISTING's
-- category (case-insensitive, trimmed).
--
-- Precedence within a scope level becomes three-deep:
--   subcategory-specific > category(vertical)-specific > all-categories
-- (scope level still dominates: listing > city > tier > state > global.)
--
-- NULL subcategory = the rule applies to the whole vertical (or everything,
-- when category is also NULL) — every existing row keeps behaving exactly
-- as before. A subcategory only makes sense inside a vertical, so it
-- requires category to be set (CHECK below; the service validates the
-- subcategory actually belongs to that vertical for readable errors).

ALTER TABLE public.fee_rules
  ADD COLUMN IF NOT EXISTS subcategory TEXT
    CHECK (subcategory IS NULL OR length(btrim(subcategory)) > 0);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fee_rules_subcategory_needs_category'
      AND conrelid = 'public.fee_rules'::regclass
  ) THEN
    ALTER TABLE public.fee_rules
      ADD CONSTRAINT fee_rules_subcategory_needs_category
        CHECK (subcategory IS NULL OR category IS NOT NULL);
  END IF;
END $$;
