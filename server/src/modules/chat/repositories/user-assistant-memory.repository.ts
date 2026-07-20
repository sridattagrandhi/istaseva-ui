/**
 * Repository for the per-user assistant-memory row.
 *
 * Two operations:
 *   getByUserId — read-or-default. Best-effort read for prompt injection.
 *   updateInTransaction — atomic read-modify-write inside a SELECT FOR
 *     UPDATE transaction so concurrent patches serialize at the DB
 *     level instead of fighting over a timestamp-CAS.
 *
 * Why not optimistic concurrency on `updated_at`:
 *   The earlier design did `SELECT, mutate, UPDATE WHERE updated_at = $`.
 *   Postgres TIMESTAMPTZ has microsecond precision; JS Date only has
 *   millisecond. pg-node truncates on read but sends the truncated
 *   value back unchanged on write — so the WHERE clause never matches
 *   the stored value after the first INSERT, and EVERY subsequent
 *   update fails deterministically. SELECT FOR UPDATE sidesteps that.
 *
 * The DB enforces the 4KB cap via a CHECK constraint; the mutator
 * callback can throw if eviction fails to bring the blob under cap.
 */
import { dbTransaction, dbQuery } from '../../../common/repositories/database.js';

export interface UserAssistantMemoryRow {
  user_id: string;
  memory: Record<string, unknown>;
  bytes: number;
  updated_at: Date;
}

export class UserAssistantMemoryRepository {
  async getByUserId(userId: string) {
    return dbQuery<UserAssistantMemoryRow>(
      `SELECT user_id, memory, bytes, updated_at
         FROM user_assistant_memory
        WHERE user_id = $1`,
      [userId],
    );
  }

  /**
   * Atomic read-modify-write. The mutator runs INSIDE a transaction
   * holding a row-level lock (`SELECT ... FOR UPDATE`); concurrent
   * callers for the same userId queue behind it. No CAS retry needed.
   *
   * Mutator receives the current memory (or {} if no row) and returns
   * the new memory to write. If it throws, the transaction rolls back
   * and the throw bubbles up unchanged.
   */
  async updateInTransaction(
    userId: string,
    mutator: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<UserAssistantMemoryRow> {
    return dbTransaction(async (client) => {
      // Lock the row if it exists. SELECT FOR UPDATE blocks other
      // transactions until ours commits/rolls back.
      const existing = await client.query<UserAssistantMemoryRow>(
        `SELECT user_id, memory, bytes, updated_at
           FROM user_assistant_memory
          WHERE user_id = $1
          FOR UPDATE`,
        [userId],
      );

      const current = existing.rows[0]?.memory ?? {};
      const next = mutator(current);

      // Single UPSERT writes whether or not the row existed. If it did
      // not, INSERT runs. If it did, we already hold the lock from
      // SELECT FOR UPDATE and can safely UPDATE.
      const result = await client.query<UserAssistantMemoryRow>(
        `INSERT INTO user_assistant_memory (user_id, memory)
              VALUES ($1, $2::jsonb)
         ON CONFLICT (user_id) DO UPDATE
            SET memory = EXCLUDED.memory,
                updated_at = now()
         RETURNING user_id, memory, bytes, updated_at`,
        [userId, JSON.stringify(next)],
      );

      return result.rows[0];
    });
  }
}

export const userAssistantMemoryRepository = new UserAssistantMemoryRepository();
