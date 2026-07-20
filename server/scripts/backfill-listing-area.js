/**
 * Backfill listings.area (the neighbourhood shown in the public location
 * label) for rows that don't have one yet.
 *
 * Mirrors ensureArea in src/modules/listings/services/listings.service.ts:
 * forward-geocode the host's STATED location and keep the Google
 * `sublocality_level_1` component. Scripts can't import from src/ (no TS build
 * dep — same as backfill-coordinates.js), so the extraction is duplicated here.
 * Keep the two in sync.
 *
 * IMPORTANT — "0 updated" is usually the CORRECT result, not a bug. Area is
 * only derivable when the host's stated location was specific enough to name
 * one: "Hyderabad, Telangana" returns no sublocality, so those rows are
 * skipped and their label keeps reading "Hyderabad, Telangana". We deliberately
 * never reverse-geocode the stored lat/lng to force a value — a city-only
 * listing has a city-centroid coord, and that would confidently label a
 * Whitefield stay "Majestic" with no way for the host to correct it.
 *
 * Idempotent: re-running only considers `area IS NULL` rows. Safe to re-run.
 * Requires GOOGLE_MAPS_API_KEY (without it there is nothing to derive from —
 * the script exits rather than silently no-op).
 *
 * Run as an ECS one-off task:
 *   aws ecs run-task --overrides '{"containerOverrides":[{"name":"web",
 *     "command":["node","scripts/backfill-listing-area.js"]}]}' ...
 */
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

if (!process.env.DATABASE_URL && process.env.DB_HOST) {
  const { DB_USER, DB_PASSWORD, DB_HOST, DB_PORT = '5432', DB_NAME = 'instaserve' } = process.env;
  process.env.DATABASE_URL = `postgres://${DB_USER}:${encodeURIComponent(DB_PASSWORD ?? '')}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!API_KEY) {
  throw new Error('GOOGLE_MAPS_API_KEY is required — area is derived from Google address components');
}

const GOOGLE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const DRY_RUN = process.argv.includes('--dry-run');

/** Mirrors areaFromGoogleComponents in src/common/services/geocode.service.ts.
 *  sublocality_level_1 ONLY: it is the name a person would use for the area,
 *  and it cannot carry a street (Google types roads as `route`, door numbers as
 *  `street_number`). Match the whole types array — types[0] is `political`. */
function areaFromComponents(components) {
  if (!Array.isArray(components)) return null;
  const hit = components.find((c) => Array.isArray(c?.types) && c.types.includes('sublocality_level_1'));
  const name = hit?.long_name?.trim();
  return name || null;
}

// Identical location strings are extremely common (every seeded row in a city
// shares one), so cache on the query and collapse them to a single call.
const cache = new Map();

async function areaFor(address) {
  if (cache.has(address)) return cache.get(address);
  const url = `${GOOGLE_URL}?address=${encodeURIComponent(address)}&region=in&key=${API_KEY}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== 'OK') {
    if (data.status !== 'ZERO_RESULTS') throw new Error(`${data.status}: ${data.error_message ?? ''}`);
    cache.set(address, null);
    return null;
  }
  const area = areaFromComponents(data.results?.[0]?.address_components);
  cache.set(address, area);
  return area;
}

/** Mirrors buildAddressString in src/common/services/geocode.service.ts. */
function buildAddress(row) {
  const parts = [row.address, row.location, row.city, row.state, row.country || 'India']
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());
  const seen = new Set();
  return parts.filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(', ');
}

// SSL policy mirrors scripts/migrate.js: local docker postgres rejects SSL
// outright ("The server does not support SSL connections"), production
// validates strictly, staging accepts RDS's managed cert.
const isLocalUrl = /@(localhost|127\.0\.0\.1)[:/]/i.test(process.env.DATABASE_URL);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalUrl
    ? false
    : (process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: false }),
});

async function run() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT id, address, location, city, state, country
      FROM listings
      WHERE area IS NULL
        AND (address IS NOT NULL OR location IS NOT NULL OR city IS NOT NULL)
      ORDER BY created_at DESC
    `);

    console.log(`Found ${rows.length} listings without an area${DRY_RUN ? ' (dry run — no writes)' : ''}`);

    let updated = 0;
    let none = 0;
    let failed = 0;

    for (const row of rows) {
      const address = buildAddress(row);
      if (!address) {
        console.log(`SKIP ${row.id} — no address text`);
        continue;
      }

      try {
        const area = await areaFor(address);
        if (!area) {
          // Expected for city-only locations. Not a failure.
          none++;
          continue;
        }
        if (!DRY_RUN) {
          await client.query('UPDATE listings SET area = $1, updated_at = NOW() WHERE id = $2', [area, row.id]);
        }
        console.log(`OK   ${row.id} → "${area}" — "${address}"`);
        updated++;
      } catch (err) {
        console.error(`FAIL ${row.id} — ${err.message}`);
        failed++;
      }
    }

    console.log(
      `\nDone. Updated: ${updated}, No area derivable: ${none}, Failed: ${failed}, Total: ${rows.length}` +
      `\n(${cache.size} distinct queries geocoded)`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
