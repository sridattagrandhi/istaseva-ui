import type pg from 'pg';
import { getDatabaseProvider } from '../providers/registry.js';

export type DbTransactionClient = pg.PoolClient;

export async function dbQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const databaseProvider = await getDatabaseProvider();
  return databaseProvider.query<T>(sql, params);
}

export async function dbTransaction<T>(
  callback: (client: DbTransactionClient) => Promise<T>
): Promise<T> {
  const databaseProvider = await getDatabaseProvider();
  return databaseProvider.transaction(callback);
}

export function runDbQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  client: DbTransactionClient | null,
  sql: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return client ? client.query<T>(sql, params) : dbQuery<T>(sql, params);
}
