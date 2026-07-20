-- Backfill listings.city / listings.state from the free-text address columns.
--
-- Why: city/state feed the admin console's filter facets, but several
-- onboarding paths wrote rows with the full address only in `location`
-- (city/state NULL) or with a city name in the state column ("Hyderabad"
-- as a state). The write path now derives both via
-- server/src/common/services/india-location.ts (ensureCityState); this
-- migration applies the same rules to rows created before that fix.
--
-- Rules (mirroring india-location.ts):
--   1. state: when missing or not a real Indian state/UT, take the state/UT
--      mentioned in `location`/`address` (longest name wins, whole-word,
--      case-insensitive), stored with canonical spelling.
--   2. city: when missing or actually a state name, take the comma-separated
--      segment immediately before the state mention, PIN digits stripped.
-- Rows whose text mentions no state are left untouched.

-- Canonical India states + union territories (reference data for parsing,
-- NOT the source of the admin filter options — those stay SELECT DISTINCT).
CREATE TEMP TABLE _india_states(name TEXT PRIMARY KEY);
INSERT INTO _india_states(name) VALUES
  ('Andhra Pradesh'), ('Arunachal Pradesh'), ('Assam'), ('Bihar'),
  ('Chhattisgarh'), ('Goa'), ('Gujarat'), ('Haryana'), ('Himachal Pradesh'),
  ('Jharkhand'), ('Karnataka'), ('Kerala'), ('Madhya Pradesh'),
  ('Maharashtra'), ('Manipur'), ('Meghalaya'), ('Mizoram'), ('Nagaland'),
  ('Odisha'), ('Punjab'), ('Rajasthan'), ('Sikkim'), ('Tamil Nadu'),
  ('Telangana'), ('Tripura'), ('Uttar Pradesh'), ('Uttarakhand'),
  ('West Bengal'),
  ('Andaman and Nicobar Islands'), ('Chandigarh'),
  ('Dadra and Nagar Haveli and Daman and Diu'), ('Delhi'),
  ('Jammu and Kashmir'), ('Ladakh'), ('Lakshadweep'), ('Puducherry');

-- 1) Fix/fill state.
WITH candidates AS (
  SELECT DISTINCT ON (l.id) l.id, s.name AS state
  FROM listings l
  JOIN _india_states s
    ON concat_ws(', ', l.location, l.address) ~* ('\m' || s.name || '\M')
  WHERE l.state IS NULL
     OR btrim(l.state) = ''
     OR lower(btrim(l.state)) NOT IN (SELECT lower(name) FROM _india_states)
  -- Longest state name wins ("Arunachal Pradesh" over any shorter mention).
  ORDER BY l.id, length(s.name) DESC
)
UPDATE listings l
SET state = c.state, updated_at = now()
FROM candidates c
WHERE l.id = c.id;

-- 2) Fill city (or replace a city that is actually a state name) from the
--    segment immediately before the state mention in the address text.
WITH guesses AS (
  SELECT l.id,
         btrim(regexp_replace(
           (regexp_match(
              concat_ws(', ', l.location, l.address),
              '([^,]+),\s*' || l.state || '\M',
              'i'
            ))[1],
           '\d{5,6}', '', 'g'
         )) AS city
  FROM listings l
  WHERE l.state IS NOT NULL AND btrim(l.state) <> ''
    AND (l.city IS NULL
         OR btrim(l.city) = ''
         OR lower(btrim(l.city)) IN (SELECT lower(name) FROM _india_states))
)
UPDATE listings l
SET city = g.city, updated_at = now()
FROM guesses g
WHERE l.id = g.id
  AND g.city IS NOT NULL
  AND g.city <> ''
  AND lower(g.city) NOT IN (SELECT lower(name) FROM _india_states);

DROP TABLE _india_states;
