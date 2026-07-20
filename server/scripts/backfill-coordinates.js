/**
 * Backfill lat/lng coordinates for listings that are missing them.
 *
 * Queries all active listings with NULL / 0 coordinates, geocodes their
 * address via Nominatim (OpenStreetMap — free, rate-limited to 1 req/sec),
 * and updates the row.
 *
 * Run as an ECS one-off task:
 *   aws ecs run-task --overrides '{"containerOverrides":[{"name":"web",
 *     "command":["node","scripts/backfill-coordinates.js"]}]}' ...
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

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'InstaServe/1.0 (https://instaserve.in; support@instaserve.in)';

async function geocode(address) {
  const url = `${NOMINATIM_URL}?format=json&limit=1&countrycodes=in&q=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const lat = parseFloat(data[0].lat);
  const lng = parseFloat(data[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

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

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT id, title, address, location, city, state, country
      FROM listings
      WHERE (lat IS NULL OR lng IS NULL OR lat = 0 OR lng = 0)
        AND (address IS NOT NULL OR location IS NOT NULL OR city IS NOT NULL)
      ORDER BY created_at DESC
    `);

    console.log(`Found ${rows.length} listings missing coordinates`);

    let updated = 0;
    let failed = 0;

    for (const row of rows) {
      const address = buildAddress(row);
      if (!address) {
        console.log(`SKIP ${row.id} — no address`);
        continue;
      }

      try {
        const result = await geocode(address);
        if (!result) {
          console.log(`MISS ${row.id} — "${address}"`);
          failed++;
        } else {
          await client.query('UPDATE listings SET lat = $1, lng = $2, updated_at = NOW() WHERE id = $3', [result.lat, result.lng, row.id]);
          // Also update provider_profile coordinates if linked
          await client.query(`
            UPDATE provider_profiles SET lat = $1, lng = $2, updated_at = NOW()
            WHERE user_id = (SELECT user_id FROM listings WHERE id = $3)
              AND (lat IS NULL OR lng IS NULL OR lat = 0 OR lng = 0)
          `, [result.lat, result.lng, row.id]);
          console.log(`OK   ${row.id} → (${result.lat}, ${result.lng}) — "${address}"`);
          updated++;
        }
      } catch (err) {
        console.error(`FAIL ${row.id} — ${err.message}`);
        failed++;
      }

      // Nominatim rate limit: 1 req/sec
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    console.log(`\nDone. Updated: ${updated}, Failed: ${failed}, Total: ${rows.length}`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
