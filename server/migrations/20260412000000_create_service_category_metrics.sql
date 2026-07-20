CREATE TABLE IF NOT EXISTS service_category_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_name TEXT NOT NULL UNIQUE,
  supply_count INTEGER NOT NULL DEFAULT 0,
  demand_score INTEGER NOT NULL DEFAULT 0,
  search_boost_factor NUMERIC NOT NULL DEFAULT 1.0,
  promotion_priority INTEGER NOT NULL DEFAULT 0,
  is_featured BOOLEAN DEFAULT false,
  is_homepage_visible BOOLEAN DEFAULT false,
  high_demand_vertical BOOLEAN DEFAULT false,
  tags TEXT[] DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scm_priority
  ON service_category_metrics(promotion_priority DESC);

CREATE INDEX IF NOT EXISTS idx_scm_name
  ON service_category_metrics(category_name);
