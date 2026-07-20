import type pg from 'pg';

/**
 * Future implementations:
 * - PostgreSQL pool
 * - Prisma/Drizzle adapter
 * - Read replica routing
 */
export interface IDatabaseProvider {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
  transaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T>;
}
