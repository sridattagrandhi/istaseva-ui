-- Identity stitching + durable acquisition attribution.
--
-- analytics_device_links maps the client-generated analytics deviceId to the
-- authenticated user, written fire-and-forget by the analytics ingest path on
-- signup/login events. It lets customer reports attribute pre-signup anonymous
-- behavior (first-touch channel, browse-before-book) to the customer without
-- any new client endpoints.
--
-- user_profiles.acquisition_channel is the first-touch channel captured at
-- signup, persisted here because raw analytics events expire after 1 year and
-- acquisition cohorts need to outlive that. Set once, never overwritten.

CREATE TABLE IF NOT EXISTS public.analytics_device_links (
  device_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, user_id)
);

CREATE INDEX IF NOT EXISTS analytics_device_links_user_idx
  ON public.analytics_device_links (user_id);

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS acquisition_channel TEXT,
  ADD COLUMN IF NOT EXISTS acquired_at TIMESTAMPTZ;
