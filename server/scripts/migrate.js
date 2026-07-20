import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../migrations');
const rootEnvPath = path.resolve(__dirname, '../../.env');

dotenv.config({ path: rootEnvPath });

// Support individual DB_* env vars (ECS / Secrets Manager) as fallback
if (!process.env.DATABASE_URL && process.env.DB_HOST) {
  const { DB_USER, DB_PASSWORD, DB_HOST, DB_PORT = '5432', DB_NAME = 'instaserve' } = process.env;
  process.env.DATABASE_URL = `postgres://${DB_USER}:${encodeURIComponent(DB_PASSWORD ?? '')}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
}

// Local-dev default — matches docker-compose.yml's postgres credentials so
// `npm run dev:setup` works without anyone pre-configuring DATABASE_URL.
// Production / staging always come through Secrets Manager (DB_HOST path
// above) or an explicit DATABASE_URL, so this default never triggers there.
if (!process.env.DATABASE_URL && process.env.NODE_ENV !== 'production') {
  process.env.DATABASE_URL = 'postgres://instaserve:instaserve_dev@localhost:5432/instaserve';
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run migrations');
}

// SSL policy:
//   - localhost / 127.0.0.1 → no SSL at all. Local docker postgres
//     ("The server does not support SSL connections" otherwise).
//   - production           → SSL with strict cert validation.
//   - other (staging, etc) → SSL but accept self-signed (RDS managed certs
//     work either way; this preserves the previous lenient behavior).
const isLocalUrl = /@(localhost|127\.0\.0\.1)[:/]/i.test(process.env.DATABASE_URL);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalUrl
    ? false
    : (process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: false }),
});

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getMigrationFiles() {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

async function run() {
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);

    const migrationFiles = await getMigrationFiles();
    const applied = await client.query('SELECT filename FROM public.schema_migrations');
    const appliedSet = new Set(applied.rows.map((row) => row.filename));

    for (const filename of migrationFiles) {
      if (appliedSet.has(filename)) {
        console.log(`SKIP ${filename}`);
        continue;
      }

      const filePath = path.join(migrationsDir, filename);
      const sql = await fs.readFile(filePath, 'utf8');

      console.log(`APPLY ${filename}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO public.schema_migrations (filename) VALUES ($1)',
          [filename]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration failed for ${filename}: ${error.message}`);
      }
    }

    console.log('MIGRATIONS_COMPLETE');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
