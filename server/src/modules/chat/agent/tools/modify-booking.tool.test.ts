// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, ValidationError, ForbiddenError } from '../../../../common/errors/app-error.js';

const updateStatus = vi.fn();

vi.mock('../../../bookings/services/bookings.service.js', () => ({
  bookingsService: { updateStatus },
}));
vi.mock('../../../../common/logging/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ctx = { userId: 'u1', displayLang: 'en', requestId: 'r', abortSignal: new AbortController().signal, toolResultCache: new Map() } as any;

describe('modifyBookingTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns success when cancel succeeds', async () => {
    const { modifyBookingTool } = await import('./modify-booking.tool.js');
    updateStatus.mockResolvedValue({ data: { scheduled_date: '2026-05-15' } });
    const result = await modifyBookingTool.execute({ operation: 'cancel', bookingId: 'b1' } as any, ctx);
    expect(result).toMatchObject({ success: true, operation: 'cancel', bookingId: 'b1', status: 'cancelled' });
  });

  it('classifies NotFoundError into not_found', async () => {
    const { modifyBookingTool } = await import('./modify-booking.tool.js');
    updateStatus.mockRejectedValue(new NotFoundError('Booking', 'b1'));
    const result = await modifyBookingTool.execute({ operation: 'cancel', bookingId: 'b1' } as any, ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('not_found');
  });

  it('passes through ForbiddenError message verbatim (already user-safe)', async () => {
    const { modifyBookingTool } = await import('./modify-booking.tool.js');
    updateStatus.mockRejectedValue(new ForbiddenError('Only the booking owner can cancel.'));
    const result = await modifyBookingTool.execute({ operation: 'cancel', bookingId: 'b1' } as any, ctx);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('forbidden');
      expect(result.userMessage).toBe('Only the booking owner can cancel.');
    }
  });

  it('classifies a bad-state ValidationError into invalid_state', async () => {
    const { modifyBookingTool } = await import('./modify-booking.tool.js');
    updateStatus.mockRejectedValue(new ValidationError("Bookings in 'completed' state can't be cancelled."));
    const result = await modifyBookingTool.execute({ operation: 'cancel', bookingId: 'b1' } as any, ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('invalid_state');
  });

  it('NEVER leaks raw backend strings on unknown errors', async () => {
    const { modifyBookingTool } = await import('./modify-booking.tool.js');
    updateStatus.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5432'));
    const result = await modifyBookingTool.execute({ operation: 'cancel', bookingId: 'b1' } as any, ctx);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('unknown');
      expect(result.userMessage).not.toContain('ECONNREFUSED');
      expect(result.userMessage).not.toContain('5432');
    }
  });

  it('returns auth_required when ctx.userId is missing', async () => {
    const { modifyBookingTool } = await import('./modify-booking.tool.js');
    const result = await modifyBookingTool.execute(
      { operation: 'cancel', bookingId: 'b1' } as any,
      { ...ctx, userId: '' },
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('auth_required');
  });
});
