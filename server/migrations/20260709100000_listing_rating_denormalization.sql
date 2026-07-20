-- Denormalize review ratings onto listings + keyset-pagination index.
--
-- The public marketplace query (listings.repository listPublic) aggregated
-- AVG(rating)/COUNT(*) over reviews with a GROUP BY on every page fetch.
-- Because the aggregate ran before ORDER BY/LIMIT, Postgres computed it for
-- EVERY matching listing per request; a measured 1000-user load run saturated
-- ~9 DB cores at 75 req/s with p95 7.9s and statement-timeout 500s on this
-- query alone. Ratings change only when a review is written, so we maintain
-- them by trigger instead of recomputing per read.
--
-- listings.avg_rating / review_count are the read path now. Reviews attach to
-- listings via reviews.stay_id (TEXT holding the listing uuid; provider-only
-- reviews leave it NULL) — the trigger compares text-to-text and never casts
-- stay_id, so junk values can't abort a write.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS avg_rating   numeric(2,1),
  ADD COLUMN IF NOT EXISTS review_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.refresh_listing_rating() RETURNS trigger AS $$
DECLARE
  v_ids text[];
  v_stay_id text;
BEGIN
  -- On UPDATE a review could in theory be repointed; refresh both sides.
  IF TG_OP = 'INSERT' THEN
    v_ids := ARRAY[NEW.stay_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_ids := ARRAY[OLD.stay_id];
  ELSIF NEW.stay_id IS DISTINCT FROM OLD.stay_id THEN
    v_ids := ARRAY[NEW.stay_id, OLD.stay_id];
  ELSE
    v_ids := ARRAY[NEW.stay_id];
  END IF;

  FOREACH v_stay_id IN ARRAY v_ids LOOP
    CONTINUE WHEN v_stay_id IS NULL;
    UPDATE public.listings l
       SET avg_rating   = sub.avg_rating,
           review_count = sub.review_count
      FROM (
        SELECT ROUND(AVG(r.rating)::numeric, 1) AS avg_rating,
               COUNT(r.id)::int                 AS review_count
          FROM public.reviews r
         WHERE r.stay_id = v_stay_id
      ) sub
     WHERE l.id::text = v_stay_id;
  END LOOP;
  RETURN NULL; -- AFTER trigger
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_refresh_listing_rating ON public.reviews;
CREATE TRIGGER trg_refresh_listing_rating
  AFTER INSERT OR UPDATE OF stay_id, rating OR DELETE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.refresh_listing_rating();

-- Backfill from existing reviews.
UPDATE public.listings l
   SET avg_rating   = sub.avg_rating,
       review_count = sub.review_count
  FROM (
    SELECT r.stay_id,
           ROUND(AVG(r.rating)::numeric, 1) AS avg_rating,
           COUNT(r.id)::int                 AS review_count
      FROM public.reviews r
     WHERE r.stay_id IS NOT NULL
     GROUP BY r.stay_id
  ) sub
 WHERE l.id::text = sub.stay_id;

-- Keyset pagination order is (updated_at DESC, id DESC); without the GROUP BY
-- the planner can now walk this index and stop at LIMIT instead of scanning
-- and sorting every matching row.
CREATE INDEX IF NOT EXISTS idx_listings_updated_at_id
  ON public.listings (updated_at DESC, id DESC);
