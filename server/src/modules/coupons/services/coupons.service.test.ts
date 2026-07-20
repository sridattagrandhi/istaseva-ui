// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, ValidationError, ForbiddenError, ConflictError } from '../../../common/errors/app-error.js';

const couponsRepoMock = {
  listForHost: vi.fn(),
  insert: vi.fn(),
  deleteForHost: vi.fn(),
  setActive: vi.fn(),
  findByCode: vi.fn(),
  incrementUsesIfAllowed: vi.fn(),
  countUserRedemptions: vi.fn(),
  checkUserTargeting: vi.fn(),
  insertRedemption: vi.fn(),
};
const listingsRepoMock = {
  getById: vi.fn(),
  listForUser: vi.fn(),
};
const usersRepoMock = {
  getByUserId: vi.fn(),
};

vi.mock('../repositories/coupons.repository.js', () => ({
  couponsRepository: couponsRepoMock,
}));
vi.mock('../../listings/repositories/listings.repository.js', () => ({
  listingsRepository: listingsRepoMock,
}));
vi.mock('../../users/repositories/users.repository.js', () => ({
  usersRepository: usersRepoMock,
}));

const baseRow = {
  id: 'cpn-1',
  host_user_id: 'host-1',
  listing_id: null,
  code: 'SAVE10',
  discount_type: 'percent' as const,
  discount_value: 10,
  max_uses: 100,
  uses_count: 0,
  valid_from: null,
  valid_until: null,
  is_active: true,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};

const baseListing = { id: 'lst-1', user_id: 'host-1' };

describe('CouponsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listingsRepoMock.getById.mockResolvedValue({ rows: [baseListing] });
    // Default: creator passes the create gate (KYC-verified + owns a listing).
    usersRepoMock.getByUserId.mockResolvedValue({ rows: [{ verification_status: 'verified' }] });
    listingsRepoMock.listForUser.mockResolvedValue({ rows: [{ id: 'lst-own' }] });
    // Default: coupon targets no specific users (open to everyone in scope).
    couponsRepoMock.checkUserTargeting.mockResolvedValue({
      rows: [{ has_targets: false, is_target: false }],
    });
  });

  describe('quote', () => {
    it('returns a percentage discount quote', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.findByCode.mockResolvedValue({ rows: [baseRow] });

      const q = await couponsService.quote({ code: 'SAVE10', listingId: 'lst-1', basePrice: 1000 });
      expect(q.discountAmount).toBe(100);
      expect(q.discountedPrice).toBe(900);
      expect(q.discountType).toBe('percent');
    });

    it('caps a fixed discount at the base price', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.findByCode.mockResolvedValue({
        rows: [{ ...baseRow, discount_type: 'fixed', discount_value: 5000 }],
      });

      const q = await couponsService.quote({ code: 'BIG', listingId: 'lst-1', basePrice: 1000 });
      // Never drops below ₹1
      expect(q.discountedPrice).toBe(1);
    });

    it('rejects an inactive coupon', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.findByCode.mockResolvedValue({ rows: [{ ...baseRow, is_active: false }] });
      await expect(
        couponsService.quote({ code: 'SAVE10', listingId: 'lst-1', basePrice: 1000 }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects an expired coupon', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.findByCode.mockResolvedValue({
        rows: [{ ...baseRow, valid_until: '2020-01-01' }],
      });
      await expect(
        couponsService.quote({ code: 'SAVE10', listingId: 'lst-1', basePrice: 1000 }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects when the coupon belongs to another host', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.findByCode.mockResolvedValue({ rows: [{ ...baseRow, host_user_id: 'other-host' }] });
      await expect(
        couponsService.quote({ code: 'SAVE10', listingId: 'lst-1', basePrice: 1000 }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('platform coupon skips the host-ownership check (any listing)', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.findByCode.mockResolvedValue({
        rows: [{ ...baseRow, host_user_id: null, is_platform: true }],
      });

      const q = await couponsService.quote({ code: 'SAVE10', listingId: 'lst-1', basePrice: 1000, userId: 'guest-1' });
      expect(q.discountAmount).toBe(100);
    });

    it('user-targeted coupon rejects a non-targeted user but allows a targeted one', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.findByCode.mockResolvedValue({
        rows: [{ ...baseRow, host_user_id: null, is_platform: true }],
      });

      couponsRepoMock.checkUserTargeting.mockResolvedValue({
        rows: [{ has_targets: true, is_target: false }],
      });
      await expect(
        couponsService.quote({ code: 'SAVE10', listingId: 'lst-1', basePrice: 1000, userId: 'stranger' }),
      ).rejects.toBeInstanceOf(ValidationError);

      couponsRepoMock.checkUserTargeting.mockResolvedValue({
        rows: [{ has_targets: true, is_target: true }],
      });
      const q = await couponsService.quote({ code: 'SAVE10', listingId: 'lst-1', basePrice: 1000, userId: 'vip' });
      expect(q.discountAmount).toBe(100);
    });

    it('throws NotFound when coupon is missing', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.findByCode.mockResolvedValue({ rows: [] });
      await expect(
        couponsService.quote({ code: 'NOPE', listingId: 'lst-1', basePrice: 1000 }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('rejects when the coupon is listing-scoped to a different listing', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.findByCode.mockResolvedValue({
        rows: [{ ...baseRow, listing_id: 'lst-OTHER' }],
      });
      await expect(
        couponsService.quote({ code: 'SAVE10', listingId: 'lst-1', basePrice: 1000 }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('create', () => {
    it('rejects when the creator is not KYC-verified', async () => {
      const { couponsService } = await import('./coupons.service.js');
      usersRepoMock.getByUserId.mockResolvedValueOnce({ rows: [{ verification_status: 'pending' }] });
      await expect(
        couponsService.create('host-1', { code: 'SAVE', discountType: 'percent', discountValue: 10 } as any),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(couponsRepoMock.insert).not.toHaveBeenCalled();
    });

    it('rejects when the creator owns no listings', async () => {
      const { couponsService } = await import('./coupons.service.js');
      listingsRepoMock.listForUser.mockResolvedValueOnce({ rows: [] });
      await expect(
        couponsService.create('host-1', { code: 'SAVE', discountType: 'percent', discountValue: 10 } as any),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(couponsRepoMock.insert).not.toHaveBeenCalled();
    });

    it('rejects when listing is owned by another host', async () => {
      const { couponsService } = await import('./coupons.service.js');
      listingsRepoMock.getById.mockResolvedValueOnce({ rows: [{ id: 'lst-1', user_id: 'someone-else' }] });
      await expect(
        couponsService.create('host-1', {
          listingId: 'lst-1',
          code: 'SAVE',
          discountType: 'percent',
          discountValue: 10,
        } as any),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('translates duplicate-code DB errors into ConflictError', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.insert.mockRejectedValueOnce({ code: '23505' });
      await expect(
        couponsService.create('host-1', {
          code: 'DUP',
          discountType: 'percent',
          discountValue: 10,
        } as any),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('consume', () => {
    const client = {} as any;
    it('rejects when uses_count would exceed max_uses', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.findByCode.mockResolvedValue({ rows: [baseRow] });
      couponsRepoMock.incrementUsesIfAllowed.mockResolvedValue({ rows: [] });
      await expect(
        couponsService.consume(client, {
          code: 'SAVE10', listingId: 'lst-1', hostUserId: 'host-1', basePrice: 1000,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('returns the discounted quote on success', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.findByCode.mockResolvedValue({ rows: [baseRow] });
      couponsRepoMock.incrementUsesIfAllowed.mockResolvedValue({ rows: [{ ...baseRow, uses_count: 1 }] });
      const q = await couponsService.consume(client, {
        code: 'SAVE10', listingId: 'lst-1', hostUserId: 'host-1', basePrice: 1000,
      });
      expect(q.discountedPrice).toBe(900);
    });

    it('rejects when the user has already hit the per-user cap', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.findByCode.mockResolvedValue({ rows: [{ ...baseRow, max_uses_per_user: 1 }] });
      couponsRepoMock.incrementUsesIfAllowed.mockResolvedValue({ rows: [{ ...baseRow, max_uses_per_user: 1, uses_count: 1 }] });
      // This guest already redeemed once.
      couponsRepoMock.countUserRedemptions.mockResolvedValue(1);
      await expect(
        couponsService.consume(client, {
          code: 'SAVE10', listingId: 'lst-1', hostUserId: 'host-1', basePrice: 1000, bookingUserId: 'guest-1',
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(couponsRepoMock.countUserRedemptions).toHaveBeenCalledWith('cpn-1', 'guest-1', client);
    });

    it('allows a first-time redemption under the per-user cap', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.findByCode.mockResolvedValue({ rows: [{ ...baseRow, max_uses_per_user: 1 }] });
      couponsRepoMock.incrementUsesIfAllowed.mockResolvedValue({ rows: [{ ...baseRow, max_uses_per_user: 1, uses_count: 1 }] });
      couponsRepoMock.countUserRedemptions.mockResolvedValue(0);
      const q = await couponsService.consume(client, {
        code: 'SAVE10', listingId: 'lst-1', hostUserId: 'host-1', basePrice: 1000, bookingUserId: 'guest-1',
      });
      expect(q.discountedPrice).toBe(900);
    });

    it('skips the per-user check when max_uses_per_user is null (unlimited per user)', async () => {
      const { couponsService } = await import('./coupons.service.js');
      couponsRepoMock.findByCode.mockResolvedValue({ rows: [{ ...baseRow, max_uses_per_user: null }] });
      couponsRepoMock.incrementUsesIfAllowed.mockResolvedValue({ rows: [{ ...baseRow, max_uses_per_user: null, uses_count: 5 }] });
      const q = await couponsService.consume(client, {
        code: 'SAVE10', listingId: 'lst-1', hostUserId: 'host-1', basePrice: 1000, bookingUserId: 'guest-1',
      });
      expect(q.discountedPrice).toBe(900);
      expect(couponsRepoMock.countUserRedemptions).not.toHaveBeenCalled();
    });
  });
});
