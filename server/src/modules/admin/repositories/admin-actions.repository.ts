import type pg from 'pg';
import { query } from '../../../common/db/postgres.js';
import { lowerList } from './admin-bookings.repository.js';

export interface AdminActionRow {
  id: string;
  actor_user_id: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  total_count?: string;
}

export interface AdminActionInsert {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AdminActionFilters {
  actorUserId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  /** Listing vertical/category facets. Only rows whose target IS a listing
   *  can match — user/coupon/payout/fee actions drop out while these are
   *  active (documented behavior; the target row carries no listing). */
  types?: string[];
  categories?: string[];
  from?: string; // inclusive ISO date/timestamp
  to?: string;   // inclusive ISO date/timestamp
  limit: number;
  offset: number;
}

export const adminActionsRepository = {
  /**
   * Accepts an optional client so callers can record the action inside the
   * same transaction as the mutation it describes.
   */
  async insert(input: AdminActionInsert, client?: pg.PoolClient): Promise<AdminActionRow> {
    const sql = `
      INSERT INTO admin_actions (actor_user_id, action, target_type, target_id, reason, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const params = [
      input.actorUserId,
      input.action,
      input.targetType,
      input.targetId,
      input.reason ?? null,
      JSON.stringify(input.metadata ?? {}),
    ];
    const result = client ? await client.query<AdminActionRow>(sql, params) : await query<AdminActionRow>(sql, params);
    return result.rows[0];
  },

  async list(filters: AdminActionFilters): Promise<{ rows: AdminActionRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };

    if (filters.actorUserId) add('a.actor_user_id = ?', filters.actorUserId);
    if (filters.action) add('a.action = ?', filters.action);
    if (filters.targetType) add('a.target_type = ?', filters.targetType);
    if (filters.targetId) add('a.target_id = ?', filters.targetId);
    // Listing facets: joinable only when the action targeted a listing, so
    // these clauses implicitly restrict to target_type='listing' rows (the
    // join condition below leaves `al` NULL for everything else).
    if (filters.types?.length) add('lower(al.listing_type) = ANY(?)', lowerList(filters.types));
    if (filters.categories?.length) add('lower(btrim(al.category)) = ANY(?)', lowerList(filters.categories));
    if (filters.from) add('a.created_at >= ?::date', filters.from);
    // Inclusive end day — `<= '2026-07-06'` on timestamptz means midnight.
    if (filters.to) add(`a.created_at < (?::date + INTERVAL '1 day')`, filters.to);

    // Join the acted-on listing (target_id is TEXT; listing ids are uuids —
    // compare as text and gate on target_type so non-uuid ids never cast).
    const needsListingJoin = !!(filters.types?.length || filters.categories?.length);
    const listingJoin = needsListingJoin
      ? `LEFT JOIN listings al ON a.target_type = 'listing' AND al.id::text = a.target_id`
      : '';

    params.push(filters.limit, filters.offset);
    const result = await query<AdminActionRow>(
      `
      SELECT a.*, COUNT(*) OVER() AS total_count
      FROM admin_actions a
      ${listingJoin}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );
    return {
      rows: result.rows,
      total: result.rows.length ? Number(result.rows[0].total_count) : 0,
    };
  },
};
