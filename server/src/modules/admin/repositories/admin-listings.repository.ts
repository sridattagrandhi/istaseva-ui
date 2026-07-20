import type pg from 'pg';
import { query } from '../../../common/db/postgres.js';
import { lowerList } from './admin-bookings.repository.js';

export interface AdminListingRow {
  id: string;
  user_id: string;
  name: string | null;
  title: string | null;
  listing_type: string;
  category: string | null;
  city: string | null;
  state: string | null;
  is_active: boolean;
  is_published: boolean;
  banned_at: string | null;
  banned_reason: string | null;
  banned_by: string | null;
  archived_at: string | null;
  archived_reason: string | null;
  archived_by: string | null;
  created_at: string;
  updated_at: string;
  host_name: string | null;
  host_email: string | null;
  host_suspended: boolean | null;
  total_count?: string;
}

export interface AdminListingFilters {
  q?: string;
  type?: string;               // stay | service | transport
  state?: 'live' | 'inactive' | 'banned' | 'archived';
  userId?: string;
  from?: string;               // created_at >= from (YYYY-MM-DD, inclusive)
  to?: string;                 // created_at <= end of `to` day (inclusive)
  /** Multi-selects over the listing's free-text location/category columns
   *  (case-insensitive). Distinct from `state`, which is moderation status;
   *  `types` is the multi-select counterpart of the single `type`. */
  states?: string[];
  cities?: string[];
  types?: string[];
  categories?: string[];
  limit: number;
  offset: number;
}

export const adminListingsRepository = {
  async search(filters: AdminListingFilters): Promise<{ rows: AdminListingRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replaceAll('?', `$${params.length}`));
    };

    if (filters.q) {
      add(`(l.name ILIKE '%' || ? || '%' OR l.title ILIKE '%' || ? || '%'
            OR l.city ILIKE '%' || ? || '%' OR l.id::text = ?)`, filters.q);
    }
    if (filters.type === 'stay' || filters.type === 'service' || filters.type === 'transport') {
      add('l.listing_type = ?', filters.type);
    }
    if (filters.userId) add('l.user_id = ?', filters.userId);
    if (filters.from) add('l.created_at >= ?::date', filters.from);
    // Inclusive end day: `<= '2026-07-06'` on a timestamptz means midnight
    // and silently drops the whole final day the admin picked.
    if (filters.to) add(`l.created_at < (?::date + INTERVAL '1 day')`, filters.to);
    if (filters.states?.length) add('lower(btrim(l.state)) = ANY(?)', lowerList(filters.states));
    if (filters.cities?.length) add('lower(btrim(l.city)) = ANY(?)', lowerList(filters.cities));
    if (filters.types?.length) add('lower(l.listing_type) = ANY(?)', lowerList(filters.types));
    if (filters.categories?.length) add('lower(btrim(l.category)) = ANY(?)', lowerList(filters.categories));
    if (filters.state === 'banned') where.push('l.banned_at IS NOT NULL');
    else if (filters.state === 'archived') where.push('l.archived_at IS NOT NULL');
    else if (filters.state === 'live') where.push('l.banned_at IS NULL AND l.archived_at IS NULL AND l.is_active = true');
    else if (filters.state === 'inactive') where.push('l.banned_at IS NULL AND l.archived_at IS NULL AND l.is_active = false');

    params.push(filters.limit, filters.offset);
    const result = await query<AdminListingRow>(
      `
      SELECT l.id, l.user_id, l.name, l.title, l.listing_type, l.category, l.city, l.state,
             l.is_active, l.is_published, l.banned_at, l.banned_reason, l.banned_by,
             l.archived_at, l.archived_reason, l.archived_by,
             l.created_at, l.updated_at,
             u.display_name AS host_name, u.email AS host_email, u.is_suspended AS host_suspended,
             COUNT(*) OVER() AS total_count
      FROM listings l
      LEFT JOIN user_profiles u ON u.user_id = l.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.updated_at DESC, l.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );
    return {
      rows: result.rows.map(({ total_count: _t, ...row }) => row as AdminListingRow),
      total: result.rows.length ? Number(result.rows[0].total_count) : 0,
    };
  },

  async ban(listingId: string, adminUserId: string, reason: string, client: pg.PoolClient) {
    const result = await client.query(
      `UPDATE listings
       SET banned_at = now(), banned_reason = $2, banned_by = $3, updated_at = now()
       WHERE id = $1
       RETURNING id, user_id, name, title, listing_type, banned_at, banned_reason, banned_by`,
      [listingId, reason, adminUserId]
    );
    return result.rows[0] ?? null;
  },

  async unban(listingId: string, client: pg.PoolClient) {
    const result = await client.query(
      `UPDATE listings
       SET banned_at = NULL, banned_reason = NULL, banned_by = NULL, updated_at = now()
       WHERE id = $1
       RETURNING id, user_id, name, title, listing_type, banned_at`,
      [listingId]
    );
    return result.rows[0] ?? null;
  },
  /** Soft archive ("delete") — takedown that keeps the row for booking/invoice
   *  history. Also deactivates so nothing keys off is_active alone. */
  async archive(listingId: string, adminUserId: string, reason: string, client: pg.PoolClient) {
    const result = await client.query(
      `UPDATE listings
       SET archived_at = now(), archived_reason = $2, archived_by = $3, is_active = false, updated_at = now()
       WHERE id = $1
       RETURNING id, user_id, name, title, listing_type, archived_at, archived_reason, archived_by`,
      [listingId, reason, adminUserId]
    );
    return result.rows[0] ?? null;
  },
  async unarchive(listingId: string, client: pg.PoolClient) {
    const result = await client.query(
      `UPDATE listings
       SET archived_at = NULL, archived_reason = NULL, archived_by = NULL, updated_at = now()
       WHERE id = $1
       RETURNING id, user_id, name, title, listing_type, archived_at`,
      [listingId]
    );
    return result.rows[0] ?? null;
  },
};
