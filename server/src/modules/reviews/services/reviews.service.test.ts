// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../common/errors/app-error.js';

const reviewsRepo = {
  listByStay: vi.fn(),
  listPromptCandidates: vi.fn(),
  create: vi.fn(),
  incrementHelpful: vi.fn(),
};
const bookingsRepo = {
  findEligibleBookingForReview: vi.fn(),
};

vi.mock('../repositories/reviews.repository.js', () => ({
  reviewsRepository: reviewsRepo,
}));
vi.mock('../../bookings/repositories/bookings.repository.js', () => ({
  bookingsRepository: bookingsRepo,
}));

describe('ReviewsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a review with neither stay_id nor provider_id', async () => {
    const { reviewsService } = await import('./reviews.service.js');
    await expect(reviewsService.create('u1', {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects when no eligible (completed) booking exists', async () => {
    const { reviewsService } = await import('./reviews.service.js');
    bookingsRepo.findEligibleBookingForReview.mockResolvedValue({ rows: [] });
    await expect(
      reviewsService.create('u1', { stay_id: 'stay-1' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('pins the review to the qualifying booking', async () => {
    const { reviewsService } = await import('./reviews.service.js');
    bookingsRepo.findEligibleBookingForReview.mockResolvedValue({ rows: [{ id: 'bk-1' }] });
    reviewsRepo.create.mockResolvedValue({ rows: [{ id: 'rv-1', booking_id: 'bk-1' }] });

    // Caller tries to spoof a booking_id — service must override.
    await reviewsService.create('u1', { stay_id: 'stay-1', booking_id: 'spoofed' });

    expect(reviewsRepo.create).toHaveBeenCalledWith('u1', expect.objectContaining({
      stay_id: 'stay-1',
      booking_id: 'bk-1',
    }));
  });

  it('passes a client-named booking_id through as the preferred pin (UUID only)', async () => {
    const { reviewsService } = await import('./reviews.service.js');
    bookingsRepo.findEligibleBookingForReview.mockResolvedValue({ rows: [{ id: 'bk-2' }] });
    reviewsRepo.create.mockResolvedValue({ rows: [{ id: 'rv-1', booking_id: 'bk-2' }] });

    const uuid = '3b5aacb4-8ac3-4231-b5cd-cdbb9e7b2917';
    await reviewsService.create('u1', { stay_id: 'stay-1', booking_id: uuid });
    expect(bookingsRepo.findEligibleBookingForReview).toHaveBeenCalledWith('u1', 'stay-1', null, uuid);

    // Non-UUID (spoof/garbage) never reaches the ::uuid cast — nulled out.
    await reviewsService.create('u1', { stay_id: 'stay-1', booking_id: 'spoofed' });
    expect(bookingsRepo.findEligibleBookingForReview).toHaveBeenLastCalledWith('u1', 'stay-1', null, null);
  });

  it('pendingPrompts maps repository rows to camelCase', async () => {
    const { reviewsService } = await import('./reviews.service.js');
    reviewsRepo.listPromptCandidates.mockResolvedValue({
      rows: [{
        booking_id: 'bk-1', listing_id: 'l-1', provider_id: 'p-1',
        listing_name: 'Lakeview Homestay', listing_category: 'stay:homestay',
        service_category: 'stay:homestay', scheduled_date: '2026-07-01', end_date: '2026-07-03',
      }],
    });
    const out = await reviewsService.pendingPrompts('u1');
    expect(out.data).toEqual([{
      bookingId: 'bk-1', listingId: 'l-1', providerId: 'p-1',
      listingName: 'Lakeview Homestay', listingCategory: 'stay:homestay',
      serviceCategory: 'stay:homestay', scheduledDate: '2026-07-01', endDate: '2026-07-03',
    }]);
  });

  it('incrementHelpful throws NotFound when review is missing', async () => {
    const { reviewsService } = await import('./reviews.service.js');
    reviewsRepo.incrementHelpful.mockResolvedValue({ rows: [] });
    await expect(reviewsService.incrementHelpful('rv-x')).rejects.toBeInstanceOf(NotFoundError);
  });
});
