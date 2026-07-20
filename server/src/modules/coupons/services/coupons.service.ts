/**
 * Host-issued coupon codes.
 *
 * Validation flow (called from both the frontend preview endpoint and the
 * booking-hold path on the server):
 *   1. Look up by case-insensitive code.
 *   2. Reject if disabled, expired, scoped to a different listing, or fully used.
 *   3. Compute the discount and return a "quote" — NEVER mutate here.
 *
 * `consume` atomically bumps uses_count under a transaction, enforcing
 * max_uses at the DB level so two concurrent bookings can't both grab
 * the last redemption.
 */
import type pg from 'pg';
import { NotFoundError, ValidationError, ForbiddenError, ConflictError } from '../../../common/errors/app-error.js';
import { couponsRepository, type CouponRow } from '../repositories/coupons.repository.js';
import { listingsRepository } from '../../listings/repositories/listings.repository.js';
import { usersRepository } from '../../users/repositories/users.repository.js';
import type { CreateCouponInput } from '../schemas/coupon.schema.js';

export interface CouponQuote {
  couponId: string;
  code: string;
  discountType: 'percent' | 'fixed';
  discountValue: number;
  discountAmount: number;   // rupees off
  discountedPrice: number;  // rupees after discount (floored at 1)
}

function round2(n: number) { return Math.round(n * 100) / 100; }

export class CouponsService {
  private mapRow(row: CouponRow) {
    return {
      id: row.id,
      hostUserId: row.host_user_id,
      listingId: row.listing_id,
      category: row.category,
      code: row.code,
      discountType: row.discount_type,
      discountValue: Number(row.discount_value),
      maxUses: row.max_uses,
      maxUsesPerUser: row.max_uses_per_user,
      usesCount: row.uses_count,
      // Present only on the list query (redemption-ledger join); other
      // lookups (getById/findByCode) don't pay for the aggregate.
      redeemedPaise: row.redeemed_paise != null ? Number(row.redeemed_paise) : 0,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listForHost(hostUserId: string, category?: 'stay' | 'service' | 'transport') {
    const result = await couponsRepository.listForHost(hostUserId, category);
    return result.rows.map((r) => this.mapRow(r));
  }

  async create(hostUserId: string, input: CreateCouponInput) {
    // Gate: only KYC-verified hosts who own at least one listing may mint
    // coupons. Coupon creation is otherwise open to any authenticated account
    // (the app is self-service host), which lets a guest with no listing and no
    // verification create discount codes — so require both here.
    const profile = await usersRepository.getByUserId(hostUserId);
    if ((profile.rows[0] as { verification_status?: string } | undefined)?.verification_status !== 'verified') {
      throw new ForbiddenError('Complete identity verification before creating coupons.');
    }
    const owned = await listingsRepository.listForUser(hostUserId);
    if (!owned.rows.length) {
      throw new ForbiddenError('You need at least one listing before creating coupons.');
    }

    // If the coupon is scoped to a listing, verify the host owns it. When
    // listingId is provided we also derive the category from the listing so
    // the consume-time gate works regardless of whether the dashboard sent
    // an explicit `category` (it won't for the single-listing path).
    let derivedCategory: 'stay' | 'service' | 'transport' | null = input.category ?? null;
    if (input.listingId) {
      const listingResult = await listingsRepository.getById(input.listingId);
      const listing = listingResult.rows[0];
      if (!listing) throw new NotFoundError('Listing', input.listingId);
      if (listing.user_id !== hostUserId) {
        throw new ForbiddenError('You can only create coupons for your own listings');
      }
      // Prefer the listing's own kind so a stale `category` from the client
      // can't widen the scope. The DB check constraint accepts the same
      // three values stored on listings.listing_type.
      const inferred = String(listing.listing_type || '').toLowerCase();
      if (inferred === 'stay' || inferred === 'service' || inferred === 'transport') {
        derivedCategory = inferred;
      }
    }

    try {
      const result = await couponsRepository.insert({
        hostUserId,
        listingId: input.listingId ?? null,
        category: derivedCategory,
        code: input.code.trim(),
        discountType: input.discountType,
        discountValue: input.discountValue,
        maxUses: input.maxUses ?? null,
        // Omitted → 1 (once per customer). Explicit null → unlimited per user.
        maxUsesPerUser: input.maxUsesPerUser === undefined ? 1 : input.maxUsesPerUser,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
      });
      return this.mapRow(result.rows[0]);
    } catch (err: unknown) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505') {
        throw new ConflictError('That coupon code is already in use — please pick another.');
      }
      throw err;
    }
  }

  async delete(id: string, hostUserId: string) {
    const result = await couponsRepository.deleteForHost(id, hostUserId);
    if (!result.rows[0]) throw new NotFoundError('Coupon', id);
    return this.mapRow(result.rows[0]);
  }

  async setActive(id: string, hostUserId: string, isActive: boolean) {
    const result = await couponsRepository.setActive(id, hostUserId, isActive);
    if (!result.rows[0]) throw new NotFoundError('Coupon', id);
    return this.mapRow(result.rows[0]);
  }

  private validateRow(row: CouponRow, listingId: string, listingCategory: string | null) {
    if (!row.is_active) throw new ValidationError('This coupon is no longer active');

    const now = new Date();
    if (row.valid_from && new Date(row.valid_from) > now) {
      throw new ValidationError('This coupon is not yet valid');
    }
    if (row.valid_until && new Date(row.valid_until) < now) {
      throw new ValidationError('This coupon has expired');
    }

    if (row.max_uses !== null && row.uses_count >= row.max_uses) {
      throw new ValidationError('This coupon has reached its usage limit');
    }

    if (row.listing_id && row.listing_id !== listingId) {
      throw new ValidationError('This coupon does not apply to this listing');
    }

    // Category scope (post-migration). A transport coupon stamped with
    // category='transport' must reject a stay or service booking — even if
    // the same host owns the listing — so a "FALL20" coupon from the
    // Transport dashboard can't quietly knock the price off a hotel
    // booking from the same user.
    if (row.category && listingCategory && row.category !== listingCategory) {
      throw new ValidationError('This coupon does not apply to this kind of booking');
    }
  }

  private quoteFromRow(row: CouponRow, basePrice: number): CouponQuote {
    const discountValue = Number(row.discount_value);
    let discountAmount =
      row.discount_type === 'percent'
        ? (basePrice * discountValue) / 100
        : Math.min(discountValue, basePrice);

    discountAmount = Math.max(0, round2(discountAmount));
    // Never let price drop below ₹1 — keeps Razorpay happy and avoids free rides.
    const discountedPrice = Math.max(1, round2(basePrice - discountAmount));

    return {
      couponId: row.id,
      code: row.code,
      discountType: row.discount_type,
      discountValue,
      discountAmount,
      discountedPrice,
    };
  }

  /**
   * User targeting ("certain people", platform coupons): when a coupon has
   * coupon_users rows, only those users may see/redeem it. Coupons without
   * target rows are open to everyone in their listing/category scope.
   */
  private async assertUserTargeted(couponId: string, userId: string | undefined, client?: pg.PoolClient) {
    const res = await couponsRepository.checkUserTargeting(couponId, userId ?? '', client);
    const check = res.rows[0];
    if (check?.has_targets && !check.is_target) {
      throw new ValidationError('This coupon is not available on your account');
    }
  }

  /** Preview a coupon for a specific listing + base price. Used by the frontend. */
  async quote(params: { code: string; listingId: string; basePrice: number; userId?: string }): Promise<CouponQuote> {
    const res = await couponsRepository.findByCode(params.code);
    const row = res.rows[0];
    if (!row) throw new NotFoundError('Coupon', params.code);

    // Verify the coupon applies to this listing's host. Platform coupons
    // (admin-created, host_user_id NULL) skip the host match — their scope is
    // listing/category/user targeting only.
    const listingRes = await listingsRepository.getById(params.listingId);
    const listing = listingRes.rows[0];
    if (!listing) throw new NotFoundError('Listing', params.listingId);
    if (!row.is_platform && row.host_user_id !== listing.user_id) {
      throw new ValidationError('This coupon is not valid for this listing');
    }

    this.validateRow(row, params.listingId, this.normalizeCategory(listing.listing_type));
    await this.assertUserTargeted(row.id, params.userId);
    return this.quoteFromRow(row, params.basePrice);
  }

  /** Coerce raw `listings.listing_type` to the same vocabulary the coupon
   *  category column uses, or null when the column carries something
   *  unexpected (legacy rows). */
  private normalizeCategory(rawType: unknown): 'stay' | 'service' | 'transport' | null {
    const t = String(rawType ?? '').toLowerCase();
    if (t === 'stay' || t === 'service' || t === 'transport') return t;
    return null;
  }

  /**
   * Transactional consume — called from booking hold creation. Locks the row,
   * re-validates, increments uses_count if within limit, and returns the quote.
   * Throws on any violation (caller should refuse the booking).
   */
  async consume(
    client: pg.PoolClient,
    params: {
      code: string;
      listingId: string;
      listingCategory?: string | null;
      hostUserId: string;
      basePrice: number;
      /** The guest redeeming the coupon — enforces coupon_users targeting. */
      bookingUserId?: string;
    },
  ): Promise<CouponQuote> {
    const res = await couponsRepository.findByCode(params.code, client);
    const row = res.rows[0];
    if (!row) throw new NotFoundError('Coupon', params.code);

    // Platform coupons skip the host match (see quote()).
    if (!row.is_platform && row.host_user_id !== params.hostUserId) {
      throw new ValidationError('This coupon is not valid for this listing');
    }
    this.validateRow(row, params.listingId, this.normalizeCategory(params.listingCategory));
    await this.assertUserTargeted(row.id, params.bookingUserId, client);

    const bump = await couponsRepository.incrementUsesIfAllowed(row.id, client);
    if (!bump.rows[0]) {
      throw new ValidationError('This coupon has reached its usage limit');
    }

    // Per-user cap. The uses_count UPDATE above took the coupon-row lock, so two
    // concurrent holds by the same guest serialize here — the second only reads
    // the count once the first has committed its redemption row. On violation we
    // throw, which rolls back this transaction (including the uses_count bump),
    // so no phantom global usage is left behind. NULL = unlimited per user.
    if (row.max_uses_per_user !== null && params.bookingUserId) {
      const prior = await couponsRepository.countUserRedemptions(row.id, params.bookingUserId, client);
      if (prior >= row.max_uses_per_user) {
        throw new ValidationError('You have already used this coupon.');
      }
    }

    return this.quoteFromRow(bump.rows[0], params.basePrice);
  }

  /**
   * Redemption ledger — called by createHold right after the booking row
   * exists, on the SAME client as consume() so a rolled-back hold never
   * leaves a phantom redemption.
   */
  async recordRedemption(
    client: pg.PoolClient,
    params: { couponId: string; bookingId: string | null; userId: string; discountPaise: number },
  ) {
    await couponsRepository.insertRedemption(client, params);
  }
}

export const couponsService = new CouponsService();
