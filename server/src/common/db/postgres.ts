import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.database.url,
  min: config.database.poolMin,
  max: config.database.poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: (() => {
    const url = config.database.url;
    // Disable SSL for local and Docker-internal connections
    if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('@postgres:')) return false;
    // Require SSL for remote databases (e.g. RDS)
    return { rejectUnauthorized: config.app.nodeEnv === 'production' };
  })(),
});

pool.on('error', (err) => {
  logger.error('Unexpected database pool error', { error: err.message });
});

pool.on('connect', (client) => {
  void client.query('SET statement_timeout = 10000');
  // OLTP queries here are short and run at high QPS; JIT compilation is pure
  // overhead (EXPLAIN ANALYZE showed ~2.4s of JIT per dated marketplace
  // availability query under load — more than half its runtime). JIT only
  // pays off for long analytical scans, which this API never runs.
  void client.query('SET jit = off');
  logger.debug('New database connection established');
});

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  logger.debug('Executed query', { text: text.substring(0, 80), duration, rows: result.rowCount });
  return result;
}

export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
