-- Where customers search: place demand per (day, category, region) from
-- `search_performed` events that carry a picked place's city/state (stay
-- searches are mostly place-picked and contribute no term to
-- analytics_search_terms — this table is their demand signal). Same pipeline
-- as the other rollups: the job reads one day of events and replaces the
-- day's rows wholesale (idempotent re-runs). Regions are stored lowercased;
-- city and state are separate rows so partner dashboards can match either.
-- Forward-only: events before this ships carried no place props.
CREATE TABLE IF NOT EXISTS public.analytics_search_places (
  day         DATE NOT NULL,
  category    TEXT NOT NULL,
  region_type TEXT NOT NULL CHECK (region_type IN ('city', 'state')),
  region      TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, category, region_type, region)
);

CREATE INDEX IF NOT EXISTS analytics_search_places_day_count_idx
  ON public.analytics_search_places (day, count DESC);
