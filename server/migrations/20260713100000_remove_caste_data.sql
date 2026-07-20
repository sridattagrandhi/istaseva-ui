-- Remove all caste/community allow-list data (LEG-012).
--
-- The feature stored nothing in dedicated columns — the allow-list lived in
-- listings.metadata JSON (`allowedCastes`) and the guest affirmation rode
-- inside bookings.notes JSON (`sathramAllowedCastes` / `sathramCasteAffirmed`).
-- The application code that read these was removed; this scrubs the residual
-- data so no old row can surface a caste caption on an invoice/email, or leak
-- into the DSAR export / account-deletion features.

-- Listings: metadata is JSONB — the '-' operator drops the key cleanly.
UPDATE public.listings
SET metadata = metadata - 'allowedCastes'
WHERE metadata ? 'allowedCastes';

-- Bookings: notes is TEXT that USUALLY (not always) holds JSON. A bare
-- WHERE with `notes::jsonb` would throw on a free-text note (Postgres does
-- not guarantee predicate short-circuit), so scrub row-by-row inside a
-- PL/pgSQL loop that swallows the cast error per row. Only candidate rows
-- (JSON-looking + mentioning the sathram keys) are even considered.
DO $$
DECLARE
  r RECORD;
  parsed JSONB;
BEGIN
  FOR r IN
    SELECT id, notes FROM public.bookings
    WHERE notes IS NOT NULL
      AND left(btrim(notes), 1) = '{'
      AND notes LIKE '%sathram%'
  LOOP
    BEGIN
      parsed := r.notes::jsonb;
    EXCEPTION WHEN others THEN
      CONTINUE; -- not valid JSON after all; leave the free-text note untouched
    END;
    IF jsonb_typeof(parsed) = 'object'
       AND (parsed ? 'sathramAllowedCastes' OR parsed ? 'sathramCasteAffirmed') THEN
      UPDATE public.bookings
      SET notes = (parsed - 'sathramAllowedCastes' - 'sathramCasteAffirmed')::text
      WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
