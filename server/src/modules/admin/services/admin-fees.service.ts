/**
 * Admin fee-panel service — CRUD over fee_rules / fee_city_tiers plus the
 * "test a booking" simulator. Rules are never edited in place: deactivate +
 * create. Every write lands in admin_actions inside the same transaction.
 *
 * Two audiences: 'customer' rules price bookings (createHold resolves them);
 * 'business' rules are the partner-payout commission — fully managed and
 * simulatable here, but payout deduction wiring is still pending, so no
 * money moves off them yet.
 */

import { transaction } from '../../../common/db/postgres.js';
import { NotFoundError, ValidationError } from '../../../common/errors/app-error.js';
import { canonicalState } from '../../../common/services/india-location.js';
import { listingsRepository } from '../../listings/repositories/listings.repository.js';
import {
  computePlatformFeePaise,
  feeVerticalFor,
  gstRateFor,
  insurancePremiumRupees,
} from '../../payments/pricing/fees.js';
import { feeRulesService, specFromRule } from '../../payments/services/fee-rules.service.js';
import { feeRulesRepository } from '../../payments/repositories/fee-rules.repository.js';
import { adminActionsService } from './admin-actions.service.js';

export interface CreateFeeRuleInput {
  audience: 'customer' | 'business';
  category: 'stays' | 'services' | 'transport' | null;
  /** Specific listing category within the vertical (facet value space,
   *  e.g. 'salon'); requires `category`. NULL = whole vertical. */
  subcategory?: string | null;
  scopeType: 'global' | 'state' | 'city_tier' | 'city' | 'listing';
  scopeState?: string | null;
  scopeCity?: string | null;
  scopeTier?: string | null;
  scopeListingId?: string | null;
  percentBps: number;
  fixedPaise: number;
  minFeePaise?: number | null;
  maxFeePaise?: number | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  reason?: string | null;
}

export const adminFeesService = {
  async listRules(filters: {
    audience?: string | null;
    category?: string | null;
    subcategory?: string | null;
    scopeType?: string | null;
    includeInactive?: boolean;
  }) {
    const result = await feeRulesRepository.list(filters);
    return result.rows;
  },

  /**
   * Normalize + validate the scope columns for the declared scope type.
   * The DB CHECK backstops this; validating here gives readable errors.
   * Shared by createRule and replaceRule so "edit" can't accept anything
   * "create" would reject.
   */
  async prepareRuleScopes(input: CreateFeeRuleInput) {
    let scopeState: string | null = null;
    let scopeCity: string | null = null;
    let scopeTier: string | null = null;
    let scopeListingId: string | null = null;

    // Subcategory (specific service type) only makes sense inside a vertical,
    // and must actually BELONG to that vertical — the resolver derives the
    // booking's vertical via feeVerticalFor, so a mismatched pair (e.g.
    // category='services' + subcategory='hotel') could never match a booking
    // and would be a silently dead rule.
    const subcategory = typeof input.subcategory === 'string' && input.subcategory.trim()
      ? input.subcategory.trim()
      : null;
    if (subcategory) {
      if (!input.category) {
        throw new ValidationError('A specific service type needs its vertical (category) set too');
      }
      const vertical = feeVerticalFor(subcategory);
      if (vertical !== input.category) {
        throw new ValidationError(
          `Service type '${subcategory}' belongs to the ${vertical} vertical, not ${input.category}`
        );
      }
    }

    if (input.scopeType === 'state' || input.scopeType === 'city') {
      scopeState = canonicalState(input.scopeState);
      if (!scopeState) {
        throw new ValidationError('scopeState must be a valid Indian state or union territory');
      }
    }
    if (input.scopeType === 'city') {
      scopeCity = typeof input.scopeCity === 'string' ? input.scopeCity.trim() : '';
      if (!scopeCity) throw new ValidationError('scopeCity is required for city rules');
    }
    if (input.scopeType === 'city_tier') {
      scopeTier = String(input.scopeTier ?? '');
      if (!['tier1', 'tier2', 'tier3'].includes(scopeTier)) {
        throw new ValidationError('scopeTier must be tier1, tier2 or tier3');
      }
    }
    if (input.scopeType === 'listing') {
      scopeListingId = String(input.scopeListingId ?? '');
      if (!scopeListingId) throw new ValidationError('scopeListingId is required for listing rules');
      if (!input.reason?.trim()) {
        throw new ValidationError('A reason is required for listing-level fee rules');
      }
      const listing = await listingsRepository.getById(scopeListingId);
      if (!listing.rows[0]) throw new NotFoundError('Listing', scopeListingId);
    }

    if (input.percentBps === 0 && input.fixedPaise === 0 && input.minFeePaise == null) {
      // Explicitly allowed — a 0-fee rule is how an admin waives the fee for
      // a scope. Nothing to validate; noted so nobody "fixes" this later.
    }
    if (
      input.minFeePaise != null && input.maxFeePaise != null &&
      input.maxFeePaise < input.minFeePaise
    ) {
      throw new ValidationError('maxFee must be greater than or equal to minFee');
    }
    if (input.effectiveFrom && input.effectiveTo) {
      if (Date.parse(input.effectiveTo) <= Date.parse(input.effectiveFrom)) {
        throw new ValidationError('effectiveTo must be after effectiveFrom');
      }
    }

    return { scopeState, scopeCity, scopeTier, scopeListingId, subcategory };
  },

  /** Insert + audit inside an existing transaction. `replacesRuleId` marks
   *  the create as half of an edit-as-replace. */
  async insertRuleInTx(
    client: Parameters<Parameters<typeof transaction>[0]>[0],
    actorUserId: string,
    input: CreateFeeRuleInput,
    scopes: { scopeState: string | null; scopeCity: string | null; scopeTier: string | null; scopeListingId: string | null; subcategory: string | null },
    replacesRuleId?: string,
  ) {
    const inserted = await feeRulesRepository.insert(
      {
        audience: input.audience,
        category: input.category,
        scopeType: input.scopeType,
        ...scopes,
        percentBps: input.percentBps,
        fixedPaise: input.fixedPaise,
        minFeePaise: input.minFeePaise ?? null,
        maxFeePaise: input.maxFeePaise ?? null,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
        reason: input.reason?.trim() || null,
        createdBy: actorUserId,
      },
      client
    );
    const rule = inserted.rows[0];
    await adminActionsService.record(
      {
        actorUserId,
        action: 'admin.fee_rule.create',
        targetType: 'fee_rule',
        targetId: rule.id,
        reason: input.reason?.trim() || null,
        // Note: `...scopes` below carries `subcategory` into the metadata.
        metadata: {
          audience: rule.audience,
          category: rule.category,
          scopeType: rule.scope_type,
          ...scopes,
          percentBps: rule.percent_bps,
          fixedPaise: rule.fixed_paise,
          minFeePaise: rule.min_fee_paise,
          maxFeePaise: rule.max_fee_paise,
          effectiveFrom: rule.effective_from,
          effectiveTo: rule.effective_to,
          ...(replacesRuleId ? { replacesRuleId } : {}),
        },
      },
      client
    );
    return rule;
  },

  async createRule(actorUserId: string, input: CreateFeeRuleInput) {
    const scopes = await this.prepareRuleScopes(input);
    return transaction((client) => this.insertRuleInTx(client, actorUserId, input, scopes));
  },

  /**
   * "Edit" a rule — really replace: insert the edited version and retire the
   * original in ONE transaction. Rules are immutable because bookings
   * snapshot the exact rule id that priced them; a true in-place edit would
   * rewrite that history. The insert happens BEFORE the deactivate so the
   * mandatory-global guard sees the replacement: editing the last global
   * default passes when its replacement is also a currently-effective global
   * rule, and correctly refuses when the edit would leave a coverage gap
   * (scope changed away from global, or effectiveFrom pushed to the future).
   */
  async replaceRule(actorUserId: string, ruleId: string, input: CreateFeeRuleInput) {
    const existing = await feeRulesRepository.getById(ruleId);
    const old = existing.rows[0];
    if (!old) throw new NotFoundError('Fee rule', ruleId);
    if (!old.active) throw new ValidationError('Only active rules can be edited — create a new rule instead');
    if (old.audience !== input.audience) {
      throw new ValidationError('An edit cannot move a rule between customer and business audiences');
    }
    const scopes = await this.prepareRuleScopes(input);

    return transaction(async (client) => {
      const rule = await this.insertRuleInTx(client, actorUserId, input, scopes, ruleId);

      if (old.scope_type === 'global') {
        const count = await feeRulesRepository.countActiveGlobal(old.audience, client);
        if (Number(count.rows[0]?.count ?? 0) <= 1) {
          throw new ValidationError(
            'This edit would leave no active global default rule (the replacement is not a currently-effective global rule).'
          );
        }
      }

      const updated = await feeRulesRepository.deactivate(ruleId, actorUserId, client);
      if (!updated.rows[0]) {
        // Someone deactivated it between our read and this write — roll the
        // whole edit back rather than leaving a surprise second rule.
        throw new ValidationError('Rule was deactivated by someone else — reload and try again');
      }
      await adminActionsService.record(
        {
          actorUserId,
          action: 'admin.fee_rule.replace',
          targetType: 'fee_rule',
          targetId: ruleId,
          reason: input.reason?.trim() || null,
          metadata: { newRuleId: rule.id, audience: old.audience, scopeType: old.scope_type },
        },
        client
      );
      return rule;
    });
  },

  async deactivateRule(actorUserId: string, ruleId: string, reason?: string) {
    return transaction(async (client) => {
      const existing = await feeRulesRepository.getById(ruleId);
      const rule = existing.rows[0];
      if (!rule) throw new NotFoundError('Fee rule', ruleId);
      if (!rule.active) throw new ValidationError('Rule is already inactive');

      // The global default is mandatory: refuse to deactivate the last
      // active, currently-effective global rule for this audience —
      // otherwise the resolver would silently fall back to the hardcoded
      // legacy fee and the panel would no longer reflect reality.
      if (rule.scope_type === 'global') {
        const count = await feeRulesRepository.countActiveGlobal(rule.audience, client);
        if (Number(count.rows[0]?.count ?? 0) <= 1) {
          throw new ValidationError(
            'Cannot deactivate the last global default rule. Create a replacement global rule first.'
          );
        }
      }

      const updated = await feeRulesRepository.deactivate(ruleId, actorUserId, client);
      const row = updated.rows[0];
      if (!row) throw new NotFoundError('Fee rule', ruleId);
      await adminActionsService.record(
        {
          actorUserId,
          action: 'admin.fee_rule.deactivate',
          targetType: 'fee_rule',
          targetId: ruleId,
          reason: reason?.trim() || null,
          metadata: { scopeType: row.scope_type, audience: row.audience },
        },
        client
      );
      return row;
    });
  },

  async listTiers() {
    const result = await feeRulesRepository.listTiers();
    return result.rows;
  },

  async upsertTier(actorUserId: string, input: { city: string; state: string; tier: string }) {
    const state = canonicalState(input.state);
    if (!state) throw new ValidationError('state must be a valid Indian state or union territory');
    const city = input.city.trim();
    if (!city) throw new ValidationError('city is required');
    if (!['tier1', 'tier2', 'tier3'].includes(input.tier)) {
      throw new ValidationError('tier must be tier1, tier2 or tier3');
    }
    const result = await feeRulesRepository.upsertTier({ city, state, tier: input.tier });
    const row = result.rows[0];
    await adminActionsService.record({
      actorUserId,
      action: 'admin.fee_tier.upsert',
      targetType: 'fee_city_tier',
      targetId: row.id,
      metadata: { city: row.city, state: row.state, tier: row.tier },
    });
    return row;
  },

  async deleteTier(actorUserId: string, id: string) {
    const result = await feeRulesRepository.deleteTier(id);
    const row = result.rows[0];
    if (!row) throw new NotFoundError('City tier', id);
    await adminActionsService.record({
      actorUserId,
      action: 'admin.fee_tier.delete',
      targetType: 'fee_city_tier',
      targetId: id,
      metadata: { city: row.city, state: row.state, tier: row.tier },
    });
    return row;
  },

  /**
   * "Test a booking" — resolves the winning rule for a hypothetical booking
   * and returns the fee/GST/total breakdown the customer would see. Pass a
   * listingId to test a real listing (its geography + category are used), or
   * category/city/state directly for a what-if.
   */
  async simulate(input: {
    audience?: 'customer' | 'business';
    listingId?: string | null;
    category?: string | null;
    city?: string | null;
    state?: string | null;
    subtotalPaise: number;
    includeInsurance?: boolean;
  }) {
    const audience = input.audience ?? 'customer';
    let category = input.category ?? null;
    let city = input.city ?? null;
    let state = input.state ?? null;
    let listingName: string | null = null;

    if (input.listingId) {
      const result = await listingsRepository.getById(input.listingId);
      const listing = result.rows[0];
      if (!listing) throw new NotFoundError('Listing', input.listingId);
      category = category ?? (listing.category as string | null);
      city = (listing.city as string | null) ?? city;
      state = (listing.state as string | null) ?? state;
      listingName = (listing.name as string | null) ?? null;
    }

    const resolved = await feeRulesService.resolvePlatformFee({
      category,
      listingId: input.listingId ?? null,
      city,
      state,
      audience,
    });

    const subtotal = Math.max(0, Math.round(input.subtotalPaise));
    const platformFeePaise = computePlatformFeePaise(subtotal, resolved.spec);

    // Business = payout commission: no GST/insurance lines, and the total is
    // what the HOST RECEIVES (subtotal − commission), not what the customer
    // pays. Customer keeps the booking-shaped breakdown.
    if (audience === 'business') {
      return {
        matched: {
          rule: resolved.rule,
          usedLegacyFallback: resolved.rule == null,
          vertical: resolved.vertical,
          spec: resolved.rule ? specFromRule(resolved.rule) : resolved.spec,
        },
        context: { category, city, state, listingId: input.listingId ?? null, listingName },
        breakdown: {
          subtotalPaise: subtotal,
          platformFeePaise,
          gstRate: 0,
          taxesPaise: 0,
          insurancePaise: 0,
          totalPaise: Math.max(0, subtotal - platformFeePaise),
        },
      };
    }

    const gstRate = gstRateFor(category, null);
    const taxesPaise = Math.round((subtotal + platformFeePaise) * gstRate);
    const insurancePaise = input.includeInsurance
      ? Math.round(insurancePremiumRupees(subtotal / 100) * 100)
      : 0;

    return {
      matched: {
        rule: resolved.rule,
        usedLegacyFallback: resolved.rule == null,
        vertical: resolved.vertical,
        spec: resolved.rule ? specFromRule(resolved.rule) : resolved.spec,
      },
      context: { category, city, state, listingId: input.listingId ?? null, listingName },
      breakdown: {
        subtotalPaise: subtotal,
        platformFeePaise,
        gstRate,
        taxesPaise,
        insurancePaise,
        totalPaise: subtotal + platformFeePaise + taxesPaise + insurancePaise,
      },
    };
  },
};
