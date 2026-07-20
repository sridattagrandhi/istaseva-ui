-- Dynamic pricing config — used by dynamic-pricing.service.ts to compute
-- city-tier and demand-adjusted prices. Schema + seed data were originally
-- in the Supabase migration 20260406050606 but weren't carried over to the
-- AWS Postgres portable schema, so the service silently fell back to the
-- hardcoded DEFAULT_TIER_MULTIPLIERS constants (from_db: false always).
--
-- Keys are (service_category, city_tier). tier_multiplier discounts non-metro
-- cities; is_premium locks multiplier to ≥ 0.85 for high-skill trades.

CREATE TABLE IF NOT EXISTS public.dynamic_pricing_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_category TEXT NOT NULL,
  city_tier INTEGER NOT NULL CHECK (city_tier IN (1, 2, 3)),
  tier_multiplier NUMERIC NOT NULL,
  min_price NUMERIC NOT NULL,
  is_premium BOOLEAN NOT NULL DEFAULT false,
  demand_low_multiplier    NUMERIC,
  demand_normal_multiplier NUMERIC,
  demand_high_multiplier   NUMERIC,
  demand_surge_multiplier  NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_category, city_tier)
);

CREATE INDEX IF NOT EXISTS idx_dpc_category_tier
  ON public.dynamic_pricing_config (service_category, city_tier);

-- Idempotent seed. ON CONFLICT preserves any tuning done in place (e.g.
-- a category was overridden for a city tier in the running system).
INSERT INTO public.dynamic_pricing_config (service_category, city_tier, tier_multiplier, min_price, is_premium) VALUES
  ('Electrical',        1, 1.00, 200, false),
  ('Electrical',        2, 0.82, 150, false),
  ('Electrical',        3, 0.68, 100, false),
  ('Plumbing',          1, 1.00, 200, false),
  ('Plumbing',          2, 0.82, 150, false),
  ('Plumbing',          3, 0.68, 100, false),
  ('Home Cleaning',     1, 1.00, 300, false),
  ('Home Cleaning',     2, 0.82, 200, false),
  ('Home Cleaning',     3, 0.68, 150, false),
  ('AC Service',        1, 1.00, 400, true),
  ('AC Service',        2, 0.85, 300, true),
  ('AC Service',        3, 0.85, 250, true),
  ('Appliance Repair',  1, 1.00, 300, true),
  ('Appliance Repair',  2, 0.85, 250, true),
  ('Appliance Repair',  3, 0.85, 200, true),
  ('Painting',          1, 1.00, 500, false),
  ('Painting',          2, 0.82, 350, false),
  ('Painting',          3, 0.68, 250, false),
  ('Carpentry',         1, 1.00, 400, false),
  ('Carpentry',         2, 0.82, 300, false),
  ('Carpentry',         3, 0.68, 200, false),
  ('Pest Control',      1, 1.00, 500, false),
  ('Pest Control',      2, 0.82, 350, false),
  ('Pest Control',      3, 0.68, 250, false)
ON CONFLICT (service_category, city_tier) DO NOTHING;
