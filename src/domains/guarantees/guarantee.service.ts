/**
 * Guarantee Domain Service
 */

import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { ServiceGuarantee, ServiceResult, UUID } from "@/types/domain";

export class GuaranteeService {
  async getByBookingId(bookingId: UUID): Promise<ServiceResult<ServiceGuarantee | null>> {
    const result = await apiRequest<{ data: any }>(`/api/guarantees/booking/${bookingId}`, {
      headers: getJsonHeaders(false),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: result.data.data ? this.mapGuarantee(result.data.data) : null };
  }

  async create(params: {
    bookingId: UUID;
    providerId: UUID;
    userId: UUID;
    serviceCategory: string;
    guaranteeMonths: number;
  }): Promise<ServiceResult<ServiceGuarantee>> {
    const startsAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + params.guaranteeMonths * 30 * 24 * 60 * 60 * 1000).toISOString();

    const result = await apiRequest<{ data: any }>("/api/guarantees", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({
        booking_id: params.bookingId,
        provider_id: params.providerId,
        user_id: params.userId,
        service_category: params.serviceCategory,
        guarantee_months: params.guaranteeMonths,
        guarantee_label: `${params.guaranteeMonths}-Month Guarantee`,
        starts_at: startsAt,
        expires_at: expiresAt,
      }),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: this.mapGuarantee(result.data.data) };
  }

  async fileClaim(guaranteeId: UUID, description: string): Promise<ServiceResult<void>> {
    const result = await apiRequest<{ success: true }>(`/api/guarantees/${guaranteeId}/claim`, {
      method: "PATCH",
      headers: getJsonHeaders(),
      body: JSON.stringify({ description }),
    });
    if (!result.success) return { success: false, error: result.error };
    return { success: true };
  }

  private mapGuarantee(row: any): ServiceGuarantee {
    return {
      id: row.id,
      bookingId: row.booking_id,
      providerId: row.provider_id,
      userId: row.user_id,
      serviceCategory: row.service_category,
      guaranteeMonths: row.guarantee_months,
      guaranteeLabel: row.guarantee_label,
      startsAt: row.starts_at,
      expiresAt: row.expires_at,
      claimDescription: row.claim_description,
      claimStatus: row.claim_status || "none",
      createdAt: row.created_at,
    };
  }
}

let _instance: GuaranteeService | null = null;
export function getGuaranteeService(): GuaranteeService {
  if (!_instance) _instance = new GuaranteeService();
  return _instance;
}
