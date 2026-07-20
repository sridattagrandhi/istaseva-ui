-- Admin ops console: durable, queryable log of every admin mutation.
--
-- DynamoDB audit_events is partitioned by target user with a 2-year TTL —
-- right for per-entity timelines, unusable for "what did admin X do last
-- week" (no actor axis, no cross-user filtering). Admin actions are
-- low-volume and need multi-axis filtering (actor / action / target / date),
-- so Postgres is the source of truth. Each write is also mirrored into
-- audit_events fire-and-forget so per-entity timelines stay complete.
--
-- user ids are Firebase UIDs (TEXT), not UUIDs — same as bookings.user_id.

CREATE TABLE IF NOT EXISTS public.admin_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id text NOT NULL,                       -- admin who did it
  action        text NOT NULL,                       -- e.g. 'admin.listing.ban'
  target_type   text NOT NULL,                       -- 'user' | 'listing' | 'booking' | 'coupon' | ...
  target_id     text NOT NULL,                       -- id of the affected row (text: uuid or firebase uid)
  reason        text,                                -- mandatory for destructive actions (service-enforced)
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_actor
  ON public.admin_actions (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_target
  ON public.admin_actions (target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_action
  ON public.admin_actions (action, created_at DESC);
