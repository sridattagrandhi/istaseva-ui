import { transaction } from '../../../common/db/postgres.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../common/errors/app-error.js';
import { listingsRepository } from '../../listings/repositories/listings.repository.js';
import {
  adminCouponsRepository,
  type AdminCouponFilters,
} from '../repositories/admin-coupons.repository.js';
import { adminActionsService } from './admin-actions.service.js';

export interface CreatePlatformCouponInput {
  code: string;
  discountType: 'percent' | 'fixed';
  discountValue: number;
  maxUses?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
  /** Scope to one listing (any host's). NULL + no category = everyone. */
  listingId?: string | null;
  /** Scope to a listing kind. Derived from the listing when listingId set. */
  category?: 'stay' | 'service' | 'transport' | null;
  /** "Certain people" — only these users may redeem. Empty = everyone in scope. */
  userIds?: string[];
}

export const adminCouponsService = {
  async list(filters: AdminCouponFilters) {
    return adminCouponsRepository.list(filters);
  },

  async detail(couponId: string) {
    const coupon = await adminCouponsRepository.getById(couponId);
    if (!coupon) throw new NotFoundError('Coupon', couponId);
    const [targetUsers, redemptions] = await Promise.all([
      adminCouponsRepository.listTargetUsers(couponId),
      adminCouponsRepository.listRedemptions(couponId),
    ]);
    return { coupon, targetUsers, redemptions };
  },

  async create(actorUserId: string, input: CreatePlatformCouponInput) {
    if (!input.code?.trim()) throw new ValidationError('A coupon code is required');
    if (input.discountType === 'percent' && (input.discountValue <= 0 || input.discountValue > 100)) {
      throw new ValidationError('Percent discount must be between 1 and 100');
    }
    if (input.discountType === 'fixed' && input.discountValue <= 0) {
      throw new ValidationError('Fixed discount must be positive');
    }

    // Listing scope: any listing on the platform (that's the point of a
    // platform coupon) — derive category from it so the consume-time
    // category gate stays consistent with host coupons.
    let category = input.category ?? null;
    if (input.listingId) {
      const listingResult = await listingsRepository.getById(input.listingId);
      const listing = listingResult.rows[0];
      if (!listing) throw new NotFoundError('Listing', input.listingId);
      const inferred = String(listing.listing_type || '').toLowerCase();
      if (inferred === 'stay' || inferred === 'service' || inferred === 'transport') {
        category = inferred;
      }
    }

    const userIds = [...new Set((input.userIds ?? []).map((u) => u.trim()).filter(Boolean))];

    try {
      return await transaction(async (client) => {
        const inserted = await adminCouponsRepository.insertPlatformCoupon(client, {
          createdBy: actorUserId,
          listingId: input.listingId ?? null,
          category,
          code: input.code.trim(),
          discountType: input.discountType,
          discountValue: input.discountValue,
          maxUses: input.maxUses ?? null,
          validFrom: input.validFrom ?? null,
          validUntil: input.validUntil ?? null,
        });
        const coupon = inserted.rows[0];
        await adminCouponsRepository.insertTargetUsers(client, coupon.id, userIds);
        await adminActionsService.record(
          {
            actorUserId,
            action: 'admin.coupon.create',
            targetType: 'coupon',
            targetId: coupon.id,
            metadata: {
              code: coupon.code,
              discountType: input.discountType,
              discountValue: input.discountValue,
              listingId: input.listingId ?? null,
              category,
              targetUserCount: userIds.length,
            },
          },
          client
        );
        return coupon;
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('That coupon code is already in use — please pick another.');
      }
      throw err;
    }
  },

  /** Moderation switch — works on host coupons too (recorded either way). */
  async setActive(actorUserId: string, couponId: string, isActive: boolean, reason?: string) {
    return transaction(async (client) => {
      const result = await adminCouponsRepository.setActive(client, couponId, isActive);
      const coupon = result.rows[0];
      if (!coupon) throw new NotFoundError('Coupon', couponId);
      await adminActionsService.record(
        {
          actorUserId,
          action: isActive ? 'admin.coupon.activate' : 'admin.coupon.deactivate',
          targetType: 'coupon',
          targetId: couponId,
          reason: reason?.trim() || null,
          targetUserId: coupon.host_user_id ?? undefined,
          metadata: { code: coupon.code, isPlatform: coupon.is_platform },
        },
        client
      );
      return coupon;
    });
  },
};
