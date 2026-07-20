import type pg from 'pg';
import { dbQuery, runDbQuery } from '../../../common/repositories/database.js';

export interface FeeRuleRow {
  id: string;
  audience: 'customer' | 'business';
  category: 'stays' | 'services' | 'transport' | null;
  /** Specific listing category within the vertical ('salon', 'hotel', …);
   *  NULL = whole vertical. Requires `category` (DB CHECK). */
  subcategory: string | null;
  scope_type: 'global' | 'state' | 'city_tier' | 'city' | 'listing';
  scope_state: string | null;
  scope_city: string | null;
  scope_tier: string | null;
  scope_listing_id: string | null;
  percent_bps: number;
  fixed_paise: number;
  min_fee_paise: number | null;
  max_fee_paise: number | null;
  effective_from: string;
  effective_to: string | null;
  active: boolean;
  reason: string | null;
  created_by: string | null;
  created_at: string;
  deactivated_at: string | null;
  deactivated_by: string | null;
}

export interface FeeCityTierRow {
  id: string;
  city: string;
  state: string;
  tier: string;
  created_at: string;
}

export class FeeRulesRepository {
  /**
   * Every active rule that COULD price this booking right now: correct
   * audience, effective window covers NOW(), category matches or is NULL,
   * and the scope matches the listing's geography (tier resolved via
   * fee_city_tiers inline). Precedence is decided in the service — this
   * just narrows the table to the handful of matching rows.
   */
  findCandidates(input: {
    audience: string;
    vertical: string;
    state: string | null;
    city: string | null;
    listingId: string | null;
    /** The LISTING's raw category ('salon', 'hotel', 'driver-cab' — the facet
     *  value space). Subcategory rules match against this, never against the
     *  differently-prefixed booking service_category ('stay:hotel'). */
    listingCategory: string | null;
  }) {
    return dbQuery<FeeRuleRow>(
      `SELECT r.* FROM fee_rules r
       WHERE r.audience = $1
         AND r.active
         AND r.effective_from <= NOW()
         AND (r.effective_to IS NULL OR r.effective_to > NOW())
         AND (r.category IS NULL OR r.category = $2)
         AND (r.subcategory IS NULL
              OR ($6::text IS NOT NULL AND lower(btrim(r.subcategory)) = lower(btrim($6))))
         AND (
           r.scope_type = 'global'
           OR (r.scope_type = 'state' AND $3::text IS NOT NULL
               AND lower(btrim(r.scope_state)) = lower(btrim($3)))
           OR (r.scope_type = 'city' AND $3::text IS NOT NULL AND $4::text IS NOT NULL
               AND lower(btrim(r.scope_city)) = lower(btrim($4))
               AND lower(btrim(r.scope_state)) = lower(btrim($3)))
           OR (r.scope_type = 'city_tier' AND $3::text IS NOT NULL AND $4::text IS NOT NULL
               AND r.scope_tier IN (
                 SELECT t.tier FROM fee_city_tiers t
                 WHERE lower(btrim(t.city)) = lower(btrim($4))
                   AND lower(btrim(t.state)) = lower(btrim($3))
               ))
           OR (r.scope_type = 'listing' AND $5::uuid IS NOT NULL AND r.scope_listing_id = $5)
         )`,
      [input.audience, input.vertical, input.state, input.city, input.listingId, input.listingCategory]
    );
  }

  list(filters: {
    audience?: string | null;
    category?: string | null;
    subcategory?: string | null;
    scopeType?: string | null;
    includeInactive?: boolean;
  }) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.audience) {
      params.push(filters.audience);
      where.push(`r.audience = $${params.length}`);
    }
    if (filters.category) {
      params.push(filters.category);
      where.push(`r.category = $${params.length}`);
    }
    if (filters.subcategory) {
      params.push(filters.subcategory);
      where.push(`lower(btrim(r.subcategory)) = lower(btrim($${params.length}))`);
    }
    if (filters.scopeType) {
      params.push(filters.scopeType);
      where.push(`r.scope_type = $${params.length}`);
    }
    if (!filters.includeInactive) {
      where.push('r.active');
    }
    return dbQuery<FeeRuleRow & { listing_name: string | null }>(
      `SELECT r.*, l.name AS listing_name
       FROM fee_rules r
       LEFT JOIN listings l ON l.id = r.scope_listing_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.active DESC,
         CASE r.scope_type
           WHEN 'listing' THEN 0 WHEN 'city' THEN 1 WHEN 'city_tier' THEN 2
           WHEN 'state' THEN 3 ELSE 4
         END,
         r.created_at DESC
       LIMIT 500`,
      params
    );
  }

  getById(id: string) {
    return dbQuery<FeeRuleRow>('SELECT * FROM fee_rules WHERE id = $1', [id]);
  }

  insert(
    input: {
      audience: string;
      category: string | null;
      subcategory: string | null;
      scopeType: string;
      scopeState: string | null;
      scopeCity: string | null;
      scopeTier: string | null;
      scopeListingId: string | null;
      percentBps: number;
      fixedPaise: number;
      minFeePaise: number | null;
      maxFeePaise: number | null;
      effectiveFrom: string | null;
      effectiveTo: string | null;
      reason: string | null;
      createdBy: string;
    },
    client?: pg.PoolClient
  ) {
    return runDbQuery<FeeRuleRow>(
      client ?? null,
      `INSERT INTO fee_rules (
         audience, category, subcategory, scope_type, scope_state, scope_city, scope_tier,
         scope_listing_id, percent_bps, fixed_paise, min_fee_paise, max_fee_paise,
         effective_from, effective_to, reason, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 COALESCE($13::timestamptz, NOW()), $14, $15, $16)
       RETURNING *`,
      [
        input.audience,
        input.category,
        input.subcategory,
        input.scopeType,
        input.scopeState,
        input.scopeCity,
        input.scopeTier,
        input.scopeListingId,
        input.percentBps,
        input.fixedPaise,
        input.minFeePaise,
        input.maxFeePaise,
        input.effectiveFrom,
        input.effectiveTo,
        input.reason,
        input.createdBy,
      ]
    );
  }

  deactivate(id: string, byUserId: string, client?: pg.PoolClient) {
    return runDbQuery<FeeRuleRow>(
      client ?? null,
      `UPDATE fee_rules
       SET active = FALSE, deactivated_at = NOW(), deactivated_by = $2
       WHERE id = $1 AND active
       RETURNING *`,
      [id, byUserId]
    );
  }

  countActiveGlobal(audience: string, client?: pg.PoolClient) {
    return runDbQuery<{ count: string }>(
      client ?? null,
      `SELECT COUNT(*)::text AS count FROM fee_rules
       WHERE audience = $1 AND scope_type = 'global' AND active
         AND effective_from <= NOW()
         AND (effective_to IS NULL OR effective_to > NOW())`,
      [audience]
    );
  }

  listTiers() {
    return dbQuery<FeeCityTierRow>(
      'SELECT * FROM fee_city_tiers ORDER BY tier, lower(state), lower(city)'
    );
  }

  upsertTier(input: { city: string; state: string; tier: string }) {
    return dbQuery<FeeCityTierRow>(
      `INSERT INTO fee_city_tiers (city, state, tier)
       VALUES (btrim($1), btrim($2), $3)
       ON CONFLICT (lower(btrim(city)), lower(btrim(state)))
       DO UPDATE SET tier = EXCLUDED.tier
       RETURNING *`,
      [input.city, input.state, input.tier]
    );
  }

  deleteTier(id: string) {
    return dbQuery<FeeCityTierRow>(
      'DELETE FROM fee_city_tiers WHERE id = $1 RETURNING *',
      [id]
    );
  }
}

export const feeRulesRepository = new FeeRulesRepository();
