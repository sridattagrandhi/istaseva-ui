// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../../common/errors/app-error.js';

const create = vi.fn();
const fileClaim = vi.fn();
const getByBookingId = vi.fn();

vi.mock('../repositories/guarantees.repository.js', () => ({
  guaranteesRepository: {
    create,
    fileClaim,
    getByBookingId,
  },
}));

describe('GuaranteesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a guarantee for a booking', async () => {
    create.mockResolvedValueOnce({
      rows: [{ id: 'guarantee-1', booking_id: 'booking-1', claim_status: 'none' }],
    });
    const { guaranteesService } = await import('./guarantees.service.js');

    const result = await guaranteesService.create('user-1', {
      booking_id: 'booking-1',
      provider_id: 'provider-1',
      service_category: 'Electrical',
      guarantee_months: 3,
      guarantee_label: '3-month service guarantee',
    });

    expect(result.data.id).toBe('guarantee-1');
  });

  it('updates claim status when a guarantee claim is filed', async () => {
    fileClaim.mockResolvedValueOnce({
      rows: [{ id: 'guarantee-1', claim_status: 'pending' }],
    });
    const { guaranteesService } = await import('./guarantees.service.js');

    const result = await guaranteesService.fileClaim('guarantee-1', 'user-1', 'Service issue');

    expect(result.success).toBe(true);
  });

  it('throws when filing a claim for a missing guarantee', async () => {
    fileClaim.mockResolvedValueOnce({ rows: [] });
    const { guaranteesService } = await import('./guarantees.service.js');

    await expect(guaranteesService.fileClaim('missing', 'user-1', 'Issue')).rejects.toBeInstanceOf(NotFoundError);
  });
});
