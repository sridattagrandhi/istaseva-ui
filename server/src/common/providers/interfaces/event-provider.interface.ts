/**
 * Future implementations:
 * - DynamoDB document store
 * - Kinesis-backed append log
 * - Mock in-memory event store for local tests
 */

export interface EventTimeRange {
  from?: string;
  to?: string;
}

export type EventTableName =
  | 'audit_events'
  | 'fraud_signals'
  | 'api_request_logs'
  | 'search_events'
  | 'analytics_events'
  | 'communication_logs'
  | 'recommendation_signals';

export interface EventResourceQuery {
  resource: string;
  resourceId: string;
  timeRange?: EventTimeRange;
}

export interface BaseEventRecord {
  userId: string;
  timestamp: string;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

export interface IEventProvider {
  putEvent(table: EventTableName, item: Record<string, unknown>): Promise<void>;
  queryByUser<T extends BaseEventRecord = BaseEventRecord>(
    table: EventTableName,
    userId: string,
    timeRange?: EventTimeRange
  ): Promise<T[]>;
  queryByResource<T extends BaseEventRecord = BaseEventRecord>(
    table: EventTableName,
    resource: string,
    resourceId: string,
    timeRange?: EventTimeRange
  ): Promise<T[]>;
  /**
   * All rows for a single UTC calendar day (YYYY-MM-DD). Backed by the
   * `analytics_events` table's `date-index` GSI; the nightly rollup reads one
   * day at a time. Returns [] for tables without a date index.
   */
  queryByDate<T extends BaseEventRecord = BaseEventRecord>(
    table: EventTableName,
    date: string
  ): Promise<T[]>;
  /**
   * Erase every event a user owns in a table (account deletion, PRIV-002).
   * Returns the number of items deleted. Implementations must be idempotent —
   * re-running after a partial failure deletes the remainder. Tables that
   * cannot be queried by user (api_request_logs) return 0 and rely on TTL.
   */
  deleteByUser(table: EventTableName, userId: string): Promise<number>;
}
