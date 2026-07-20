-- Translation cache for dynamic (user-generated) content.
--
-- Static UI strings live in /src/locales/*.json and ship with the bundle;
-- this table holds *runtime* translations of listing descriptions, review
-- bodies, amenity labels, and similar free-text fields fetched from Bhashini
-- (or whichever provider is wired in translation.schema.ts).
--
-- Key design:
--  - PK is (source_lang, target_lang, text_hash). text_hash = SHA-256 of the
--    normalized source text, so identical English strings hit one cache row
--    regardless of which listing/review they came from.
--  - No FK on any business object. The cache is addressable by *content*,
--    not by row id, which means translations are reusable across features
--    and survive listing deletions.
--  - original_text stored for debuggability / cache rebuilds; SHA-256 alone
--    is enough to look up by but not enough to re-translate on a miss.
CREATE TABLE IF NOT EXISTS translation_cache (
  source_lang     TEXT        NOT NULL,
  target_lang     TEXT        NOT NULL,
  text_hash       TEXT        NOT NULL,
  original_text   TEXT        NOT NULL,
  translated_text TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_lang, target_lang, text_hash)
);

CREATE INDEX IF NOT EXISTS idx_translation_cache_created_at
  ON translation_cache(created_at DESC);
