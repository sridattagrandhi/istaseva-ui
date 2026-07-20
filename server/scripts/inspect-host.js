// One-off inspection — prints user_profiles + provider_profiles rows
// related to the staging host UUID so we can pick the right backfill strategy.
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

if (!process.env.DATABASE_URL && process.env.DB_HOST) {
  const { DB_USER, DB_PASSWORD, DB_HOST, DB_PORT = '5432', DB_NAME = 'instaserve' } = process.env;
  process.env.DATABASE_URL = `postgres://${DB_USER}:${encodeURIComponent(DB_PASSWORD ?? '')}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
const UUID = '7d02134f-4070-4437-800f-373d0b356aaa';

console.log('=== provider_profiles matches ===');
const pp = await client.query(
  `SELECT id, user_id, display_name FROM provider_profiles WHERE id::text = $1 OR user_id::text = $1`,
  [UUID]
);
console.log(JSON.stringify(pp.rows, null, 2));

console.log('=== user_profiles by id or user_id ===');
const up = await client.query(
  `SELECT id, user_id, display_name, email, phone FROM user_profiles WHERE id::text = $1 OR user_id::text = $1`,
  [UUID]
);
console.log(JSON.stringify(up.rows, null, 2));

console.log('=== all user_profiles rows (limit 20) ===');
const all = await client.query(`SELECT id, user_id, display_name, email FROM user_profiles ORDER BY created_at DESC LIMIT 20`);
console.log(JSON.stringify(all.rows, null, 2));

await client.end();
