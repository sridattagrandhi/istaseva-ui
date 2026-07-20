/**
 * Platform-fee rule resolution — decides WHICH admin fee rule prices a
 * booking. The fee math itself stays in pricing/fees.ts
 * (computePlatformFeePaise) so applyFees remains pure.
 *
 * Precedence (most specific wins):
 *   listing > city > city_tier > state > global
 * and within the same scope level a category-specific rule beats a
 * category-NULL (all categories) rule. Remaining ties go to the most
 * recently effective, then most recently created rule.
 *
 * Failure policy: resolution is BEST-EFFORT. Any error (DB down, bad row)
 * falls back to the legacy flat ₹3 spec and logs a warning — a fee-panel
 * problem must never block a booking. The seeded global default means a
 * healthy DB always matches at least one rule.
 */

import { NotFoundError } from '../../../common/errors/app-error.js';
import { logger } from '../../../common/logging/logger.js';
import { listingsRepository } from '../../listings/repositories/listings.repository.js';
import {
  computePlatformFeePaise,
  feeVerticalFor,
  LEGACY_PLATFORM_FEE_SPEC,
  type PlatformFeeSpec,
} from '../pricing/fees.js';
import {
  feeRulesRepository,
  type FeeRuleRow,
} from '../repositories/fee-rules.repository.js';

const SCOPE_RANK: Record<FeeRuleRow['scope_type'], number> = {
  listing: 0,
  city: 1,
  city_tier: 2,
  state: 3,
  global: 4,
};

/** Pure precedence pick over candidate rows the repository already scoped
 *  to this booking. Exported for unit tests. Within a scope level the
 *  category axis is three-deep: subcategory-specific ('salon') beats
 *  vertical-specific ('services') beats all-categories. */
export function pickWinningRule(candidates: FeeRuleRow[]): FeeRuleRow | null {
  if (!candidates.length) return null;
  const specificity = (r: FeeRuleRow) => (r.subcategory ? 0 : r.category ? 1 : 2);
  const sorted = [...candidates].sort((a, b) => {
    const scope = SCOPE_RANK[a.scope_type] - SCOPE_RANK[b.scope_type];
    if (scope !== 0) return scope;
    const cat = specificity(a) - specificity(b);
    if (cat !== 0) return cat;
    const effective = Date.parse(b.effective_from) - Date.parse(a.effective_from);
    if (effective !== 0 && Number.isFinite(effective)) return effective;
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });
  return sorted[0];
}

export function specFromRule(rule: FeeRuleRow): PlatformFeeSpec {
  return {
    percentBps: Number(rule.percent_bps) || 0,
    fixedPaise: Number(rule.fixed_paise) || 0,
    minFeePaise: rule.min_fee_paise == null ? null : Number(rule.min_fee_paise),
    maxFeePaise: rule.max_fee_paise == null ? null : Number(rule.max_fee_paise),
    ruleId: rule.id,
  };
}

export interface ResolveFeeInput {
  /** Raw booking/listing category (e.g. 'hotel', 'salon', 'driver-cab'). */
  category: string | null | undefined;
  /** The LISTING's own category — what subcategory-scoped rules match on.
   *  Distinct from `category` because bookings pass their service_category
   *  snapshot ('stay:hotel', 'driver-hourly'), which lives in a different
   *  value space than the listing categories the admin picker offers. */
  listingCategory?: string | null;
  /** Listing geography — pass the listing row's columns when available. */
  listingId?: string | null;
  city?: string | null;
  state?: string | null;
  audience?: 'customer' | 'business';
}

export interface ResolvedPlatformFee {
  spec: PlatformFeeSpec;
  rule: FeeRuleRow | null;
  vertical: ReturnType<typeof feeVerticalFor>;
}

export class FeeRulesService {
  async resolvePlatformFee(input: ResolveFeeInput): Promise<ResolvedPlatformFee> {
    const vertical = feeVerticalFor(input.category);
    try {
      const result = await feeRulesRepository.findCandidates({
        audience: input.audience ?? 'customer',
        vertical,
        state: input.state?.trim() || null,
        city: input.city?.trim() || null,
        listingId: input.listingId || null,
        // Fall back to `category` when no listing category was passed — the
        // simulator's what-if path sends listing-space values there.
        listingCategory: input.listingCategory?.trim() || input.category?.trim() || null,
      });
      const rule = pickWinningRule(result.rows);
      if (rule) {
        return { spec: specFromRule(rule), rule, vertical };
      }
      // No active rule at all (seed row deactivated?) — legacy fallback.
      logger.warn('No fee rule matched; using legacy flat platform fee', {
        vertical,
        listingId: input.listingId ?? null,
      });
      return { spec: LEGACY_PLATFORM_FEE_SPEC, rule: null, vertical };
    } catch (error) {
      logger.warn('Fee rule resolution failed; using legacy flat platform fee', {
        error: error instanceof Error ? error.message : String(error),
        vertical,
        listingId: input.listingId ?? null,
      });
      return { spec: LEGACY_PLATFORM_FEE_SPEC, rule: null, vertical };
    }
  }

  /**
   * Public fee quote for the booking modals (web + mobile): given a listing
   * and the client's discounted subtotal, return the platform fee that
   * createHold will charge. Clients render this instead of a hardcoded flat
   * fee, and fall back to the legacy constant if the request fails — which
   * matches this method's own failure fallback, so both sides degrade to
   * the same number.
   */
  async quoteForListing(listingId: string, subtotalPaise: number) {
    const result = await listingsRepository.getById(listingId);
    const listing = result.rows[0];
    if (!listing) throw new NotFoundError('Listing', listingId);
    const resolved = await this.resolveForListingRow(
      listing,
      (listing.category as string | null) ?? null,
    );
    const subtotal = Math.max(0, Math.round(Number(subtotalPaise) || 0));
    return {
      platformFeePaise: computePlatformFeePaise(subtotal, resolved.spec),
      subtotalPaise: subtotal,
      spec: resolved.spec,
      vertical: resolved.vertical,
    };
  }

  /** Convenience for call sites holding a raw listing row. */
  async resolveForListingRow(
    listing: Record<string, unknown> | null,
    category: string | null | undefined,
    audience: 'customer' | 'business' = 'customer',
  ): Promise<ResolvedPlatformFee> {
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return this.resolvePlatformFee({
      category: category ?? str(listing?.category),
      // Subcategory rules match the LISTING's category, not the booking's
      // service_category snapshot (different value space — 'stay:hotel').
      listingCategory: str(listing?.category),
      listingId: str(listing?.id),
      city: str(listing?.city),
      state: str(listing?.state),
      audience,
    });
  }
}

export const feeRulesService = new FeeRulesService();
