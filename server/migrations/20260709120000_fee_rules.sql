-- Configurable platform-fee rules (admin "Fees" panel).
--
-- Replaces the hardcoded flat PLATFORM_FEE_PAISE with a rule table resolved
-- at hold time by precedence (most specific wins):
--
--   listing > city > city_tier > state > global
--
-- and, within the same scope level, a category-specific rule (stays /
-- services / transport) beats a category-NULL (all categories) rule.
--
-- Design decisions (agreed 2026-07-09):
-- - audience: 'customer' (fee added on top of the price — the only audience
--   consumed in v1) vs 'business' (payout commission — reserved for v2; the
--   resolver ignores it until payout math exists).
-- - Fee shape is percent + fixed with optional min/max caps, so fixed-only
--   (0% + ₹X) and percent-only (X% + ₹0) are both just rows.
-- - Rules are never edited in place or deleted: deactivate + create a new
--   row. `active`/`deactivated_*` + effective window give the full history.
-- - Listing-scope rules require a reason (negotiated exceptions must be
--   explained) — enforced by CHECK, not just the panel.
-- - Geography anchors on the LISTING's city/state columns (normalized by
--   ensureCityState + the 20260708 backfill). City rules carry state too,
--   because Indian city names collide across states (Aurangabad).
--
-- The seed row reproduces the legacy flat ₹3 fee, so behavior is unchanged
-- until an admin creates rules. bookings.fee_rule_id snapshots which rule
-- priced each hold (breakdown amounts were already snapshotted by
-- 20260516000000_booking_fee_breakdown.sql).

CREATE TABLE IF NOT EXISTS public.fee_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audience TEXT NOT NULL CHECK (audience IN ('customer', 'business')),
  -- NULL = applies to all categories.
  category TEXT CHECK (category IN ('stays', 'services', 'transport')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'state', 'city_tier', 'city', 'listing')),
  scope_state TEXT,
  scope_city TEXT,
  scope_tier TEXT CHECK (scope_tier IN ('tier1', 'tier2', 'tier3')),
  scope_listing_id UUID REFERENCES public.listings(id) ON DELETE CASCADE,
  -- Fee = clamp(round(discountedSubtotal × percent_bps / 10000) + fixed_paise,
  --             min_fee_paise, max_fee_paise)
  percent_bps INTEGER NOT NULL DEFAULT 0 CHECK (percent_bps >= 0 AND percent_bps <= 10000),
  fixed_paise INTEGER NOT NULL DEFAULT 0 CHECK (fixed_paise >= 0),
  min_fee_paise INTEGER CHECK (min_fee_paise IS NULL OR min_fee_paise >= 0),
  max_fee_paise INTEGER CHECK (max_fee_paise IS NULL OR max_fee_paise >= 0),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  reason TEXT,
  -- Actor ids are Firebase uids — opaque TEXT, not UUIDs (same convention as
  -- admin_actions.actor_user_id). 20260709160000 repairs DBs that ran the
  -- earlier UUID-typed version of this file.
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deactivated_at TIMESTAMPTZ,
  deactivated_by TEXT,
  -- Exactly the scope columns implied by scope_type may be set.
  CONSTRAINT fee_rules_scope_shape CHECK (
    (scope_type = 'global'    AND scope_state IS NULL     AND scope_city IS NULL     AND scope_tier IS NULL     AND scope_listing_id IS NULL) OR
    (scope_type = 'state'     AND scope_state IS NOT NULL AND scope_city IS NULL     AND scope_tier IS NULL     AND scope_listing_id IS NULL) OR
    (scope_type = 'city_tier' AND scope_state IS NULL     AND scope_city IS NULL     AND scope_tier IS NOT NULL AND scope_listing_id IS NULL) OR
    (scope_type = 'city'      AND scope_state IS NOT NULL AND scope_city IS NOT NULL AND scope_tier IS NULL     AND scope_listing_id IS NULL) OR
    (scope_type = 'listing'   AND scope_state IS NULL     AND scope_city IS NULL     AND scope_tier IS NULL     AND scope_listing_id IS NOT NULL)
  ),
  CONSTRAINT fee_rules_caps_order CHECK (
    min_fee_paise IS NULL OR max_fee_paise IS NULL OR max_fee_paise >= min_fee_paise
  ),
  CONSTRAINT fee_rules_effective_window CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),
  CONSTRAINT fee_rules_listing_needs_reason CHECK (
    scope_type <> 'listing' OR (reason IS NOT NULL AND length(btrim(reason)) > 0)
  )
);

-- Resolver hits: active rules for one audience, filtered by scope columns.
CREATE INDEX IF NOT EXISTS idx_fee_rules_lookup
  ON public.fee_rules (audience, scope_type)
  WHERE active;
CREATE INDEX IF NOT EXISTS idx_fee_rules_listing
  ON public.fee_rules (scope_listing_id)
  WHERE scope_listing_id IS NOT NULL;

-- City → tier mapping consumed by city_tier rules. City/state are stored as
-- typed by the admin; all comparisons (resolver + upsert dedupe) go through
-- lower(btrim(...)), hence the expression unique index instead of a plain PK.
CREATE TABLE IF NOT EXISTS public.fee_city_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city TEXT NOT NULL CHECK (length(btrim(city)) > 0),
  state TEXT NOT NULL CHECK (length(btrim(state)) > 0),
  tier TEXT NOT NULL CHECK (tier IN ('tier1', 'tier2', 'tier3')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_city_tiers_city_state
  ON public.fee_city_tiers (lower(btrim(city)), lower(btrim(state)));

-- Which rule priced this hold. Amount snapshots already exist
-- (subtotal_paise / platform_fee_paise / taxes_paise / discount_paise);
-- this adds the audit pointer. ON DELETE SET NULL is belt-and-braces —
-- rules are deactivated, never deleted.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS fee_rule_id UUID REFERENCES public.fee_rules(id) ON DELETE SET NULL;

-- Seed the mandatory global default: reproduces the legacy flat ₹3 customer
-- fee so nothing changes until an admin writes rules. The admin service
-- refuses to deactivate the last active global customer rule.
INSERT INTO public.fee_rules (audience, category, scope_type, percent_bps, fixed_paise, reason)
SELECT 'customer', NULL, 'global', 0, 300, 'Seed: legacy flat ₹3 platform fee'
WHERE NOT EXISTS (
  SELECT 1 FROM public.fee_rules
  WHERE audience = 'customer' AND scope_type = 'global' AND active
);
