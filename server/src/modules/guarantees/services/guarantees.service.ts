import { NotFoundError } from '../../../common/errors/app-error.js';
import { guaranteesRepository } from '../repositories/guarantees.repository.js';

export class GuaranteesService {
  async create(userId: string, payload: {
    booking_id: string;
    provider_id: string;
    service_category: string;
    guarantee_months: number;
    guarantee_label: string;
    expires_at?: string;
  }) {
    const result = await guaranteesRepository.create(userId, payload);
    return { data: result.rows[0] };
  }

  async getByBookingId(bookingId: string, userId: string) {
    const result = await guaranteesRepository.getByBookingId(bookingId, userId);
    return { data: result.rows[0] || null };
  }

  async fileClaim(guaranteeId: string, userId: string, description: string) {
    const result = await guaranteesRepository.fileClaim(guaranteeId, userId, description);
    if (!result.rows[0]) throw new NotFoundError('Guarantee', guaranteeId);
    return { success: true };
  }
}

export const guaranteesService = new GuaranteesService();
