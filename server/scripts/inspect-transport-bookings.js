// One-off DB inspection for the transport-bookings empty-result bug.
// Reads recent driver/transport bookings + their parent listings so we can
// see exactly why the display query at listTransportBookingsForProvider
// returns [] for a listing that visibly has bookings in the trips list.
//
// Run via:
//   aws ecs run-task ... --overrides
//     '{"containerOverrides":[{"name":"web","command":["node","scripts/inspect-transport-bookings.js"]}]}'
// Then read CloudWatch log stream api/web/<task-id>.

import pg from 'pg';

if (!process.env.DATABASE_URL && process.env.DB_HOST) {
  const { DB_USER, DB_PASSWORD, DB_HOST, DB_PORT = '5432', DB_NAME = 'instaserve' } = process.env;
  process.env.DATABASE_URL = `postgres://${DB_USER}:${encodeURIComponent(DB_PASSWORD ?? '')}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

console.log('=== recent transport-ish bookings (last 30, any status) ===');
const bookings = await client.query(
  `SELECT id, user_id, provider_id, listing_id, service_category,
          scheduled_date, start_time, end_time, status, hold_expires_at,
          created_at
   FROM bookings
   WHERE scheduled_date >= CURRENT_DATE - INTERVAL '7 days'
   ORDER BY created_at DESC
   LIMIT 30`,
);
console.log(JSON.stringify(bookings.rows, null, 2));

console.log('\n=== listings whose name contains "Driver" or category contains transport-ish ===');
const listings = await client.query(
  `SELECT id, provider_profile_id, name, category, status, created_at
   FROM listings
   WHERE name ILIKE '%driver%'
      OR category ILIKE '%transport%'
      OR category ILIKE '%driver%'
      OR category ILIKE '%cab%'
      OR category ILIKE '%taxi%'
   ORDER BY created_at DESC
   LIMIT 20`,
);
console.log(JSON.stringify(listings.rows, null, 2));

console.log('\n=== for each booking above, simulate the display query ===');
for (const b of bookings.rows) {
  if (!b.listing_id) {
    console.log(`booking ${b.id}: listing_id is NULL`);
    continue;
  }
  const listing = await client.query(
    `SELECT id, provider_profile_id, name, category FROM listings WHERE id = $1`,
    [b.listing_id],
  );
  const l = listing.rows[0];
  console.log(`booking ${b.id} (scheduled ${b.scheduled_date} ${b.start_time}-${b.end_time}, cat=${b.service_category})`);
  console.log(`  listing: ${l ? `${l.id} provider=${l.provider_profile_id} name="${l.name}" cat=${l.category}` : 'NOT FOUND'}`);
  console.log(`  booking.provider_id = ${b.provider_id}`);
  console.log(`  match condition (provider_id = listing.provider_profile_id): ${l && b.provider_id === l.provider_profile_id}`);
  console.log(`  display query would match: ${l && (b.provider_id === l.provider_profile_id || b.listing_id === l.id)}`);
}

await client.end();
