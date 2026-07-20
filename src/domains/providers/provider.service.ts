/**
 * Provider Domain Service
 */

import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { ProviderAvailability, ProviderProfile, ServiceResult, UUID } from "@/types/domain";

export class ProviderService {
  async getProfile(_providerId: UUID): Promise<ServiceResult<ProviderProfile>> {
    return this.getProfileByUserId("");
  }

  async getProfileByUserId(_userId: UUID): Promise<ServiceResult<ProviderProfile>> {
    const result = await apiRequest<{ data: any }>("/api/providers/me/profile", {
      headers: getJsonHeaders(false),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    if (!result.data.data) return { success: false, error: "Provider not found" };
    return { success: true, data: this.mapProfile(result.data.data) };
  }

  async createProfile(profile: Partial<ProviderProfile> & { userId: string; displayName: string }): Promise<ServiceResult<ProviderProfile>> {
    const result = await apiRequest<{ data: any }>("/api/providers", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({
        user_id: profile.userId,
        display_name: profile.displayName,
        service_categories: profile.serviceCategories || [],
        lat: profile.lat,
        lng: profile.lng,
        bio: profile.bio,
      }),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: this.mapProfile(result.data.data) };
  }

  async updateProfile(_providerId: UUID, _updates: Record<string, any>): Promise<ServiceResult<ProviderProfile>> {
    return { success: false, error: "Provider profile update endpoint is not implemented yet" };
  }

  async getAvailability(_providerId: UUID): Promise<ServiceResult<ProviderAvailability[]>> {
    return { success: true, data: [] };
  }

  private mapProfile(row: any): ProviderProfile {
    return {
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name,
      serviceCategories: row.service_categories || [],
      lat: row.lat,
      lng: row.lng,
      serviceRadiusKm: row.service_radius_km,
      bufferMinutes: row.buffer_minutes,
      isAvailable: row.is_available,
      bio: row.bio,
      bookingMode: row.booking_mode,
      bookingRules: row.booking_rules || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

let _instance: ProviderService | null = null;
export function getProviderService(): ProviderService {
  if (!_instance) _instance = new ProviderService();
  return _instance;
}
