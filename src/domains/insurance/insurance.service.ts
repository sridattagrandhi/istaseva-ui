/**
 * Insurance Domain Service
 */

import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { InsuranceClaim, InsurancePolicy, ServiceResult, UUID } from "@/types/domain";

export class InsuranceService {
  async createPolicy(params: {
    bookingId: UUID;
    userId: UUID;
    premiumAmount?: number;
    coverageAmount?: number;
    coverageType?: string;
  }): Promise<ServiceResult<InsurancePolicy>> {
    const result = await apiRequest<{ data: any }>("/api/payments/insurance-policies", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({
        booking_id: params.bookingId,
        coverage_amount: params.coverageAmount || 500,
        coverage_type: params.coverageType || "standard",
      }),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: this.mapPolicy(result.data.data) };
  }

  async getUserPolicies(_userId: UUID): Promise<ServiceResult<InsurancePolicy[]>> {
    return { success: true, data: [] };
  }

  async fileClaim(_params: {
    policyId: UUID;
    userId: UUID;
    claimAmount: number;
    description: string;
    evidenceUrl?: string;
  }): Promise<ServiceResult<InsuranceClaim>> {
    return { success: false, error: "Insurance claim endpoint is not implemented yet" };
  }

  private mapPolicy(row: any): InsurancePolicy {
    return {
      id: row.id || `policy-${row.booking_id}`,
      bookingId: row.booking_id,
      userId: row.user_id,
      premiumAmount: row.premium_amount,
      coverageAmount: row.coverage_amount,
      coverageType: row.coverage_type,
      status: row.status,
      createdAt: row.created_at || new Date().toISOString(),
    };
  }

  private mapClaim(row: any): InsuranceClaim {
    return {
      id: row.id,
      policyId: row.policy_id,
      userId: row.user_id,
      claimAmount: row.claim_amount,
      description: row.description,
      evidenceUrl: row.evidence_url,
      status: row.status,
      resolution: row.resolution,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
    };
  }
}

let _instance: InsuranceService | null = null;
export function getInsuranceService(): InsuranceService {
  if (!_instance) _instance = new InsuranceService();
  return _instance;
}
