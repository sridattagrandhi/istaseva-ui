-- Conversations denormalization
--
-- Problem: the existing listConversations query does DISTINCT ON over a
-- UNION of messages filtered by user, then joins user_profiles and
-- provider_profiles. At 10k messages/user and 100k+ users this gets slow
-- fast — the DISTINCT ON can't use the index effectively, and every list
-- call re-computes last-message + unread-count from scratch.
--
-- Fix: maintain a denormalized `conversations` row keyed by
-- (user_id, other_user_id), updated on every message insert. Listing a
-- user's conversations becomes a single indexed range scan.
--
-- We store TWO rows per logical thread (one per participant) so we can
-- track per-user unread counts cheaply. This is the standard chat-app
-- pattern (Signal, Matrix, WhatsApp internal schemas all look like this).
--
-- Maintained at application level (chat repository) rather than by
-- trigger, so logic lives alongside the code that emits realtime events.

CREATE TABLE IF NOT EXISTS public.conversations (
  user_id           TEXT        NOT NULL,
  other_user_id     TEXT        NOT NULL,
  last_message_id   UUID,
  last_message      TEXT,
  last_message_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sender_id    TEXT,
  unread_count      INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, other_user_id)
);

-- List-conversations is "WHERE user_id = $1 ORDER BY last_message_at DESC"
CREATE INDEX IF NOT EXISTS idx_conversations_user_recent
  ON public.conversations (user_id, last_message_at DESC);

-- Backfill: seed one row per (user, counterpart) pair from existing messages.
-- Uses DISTINCT ON so each pair gets the latest message.
INSERT INTO public.conversations (
  user_id, other_user_id,
  last_message_id, last_message, last_message_at, last_sender_id,
  unread_count,
  created_at, updated_at
)
SELECT
  pair.user_id,
  pair.other_user_id,
  pair.id,
  pair.content,
  pair.created_at,
  pair.sender_id,
  COALESCE(unread.cnt, 0),
  pair.created_at,
  pair.created_at
FROM (
  SELECT DISTINCT ON (user_id, other_user_id)
         user_id, other_user_id, id, content, created_at, sender_id
  FROM (
    SELECT sender_id   AS user_id, receiver_id AS other_user_id,
           id, content, created_at, sender_id
      FROM public.messages
    UNION ALL
    SELECT receiver_id AS user_id, sender_id   AS other_user_id,
           id, content, created_at, sender_id
      FROM public.messages
  ) expanded
  ORDER BY user_id, other_user_id, created_at DESC
) pair
LEFT JOIN (
  SELECT receiver_id AS user_id, sender_id AS other_user_id, COUNT(*)::int AS cnt
    FROM public.messages
   WHERE is_read = false
   GROUP BY receiver_id, sender_id
) unread
  ON unread.user_id = pair.user_id AND unread.other_user_id = pair.other_user_id
ON CONFLICT (user_id, other_user_id) DO NOTHING;
