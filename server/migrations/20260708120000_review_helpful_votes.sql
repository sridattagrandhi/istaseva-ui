-- One "helpful" vote per (review, user).
--
-- PATCH /api/reviews/:id/helpful previously required no auth and did an
-- unconditional increment, so anyone could inflate any review's helpful_count in
-- a loop. The endpoint now requires auth and records a vote here; helpful_count
-- is only bumped on the first insert for a given (review_id, user_id).

CREATE TABLE IF NOT EXISTS public.review_helpful_votes (
  review_id  uuid NOT NULL REFERENCES public.reviews(id) ON DELETE CASCADE,
  user_id    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, user_id)
);
