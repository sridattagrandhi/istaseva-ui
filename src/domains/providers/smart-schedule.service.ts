import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { ServiceResult } from "@/types/domain";

export interface SmartScheduleSlot {
  provider_id: string;
  provider_name: string;
  start_time: string;
  end_time: string;
  estimated_travel_minutes: number;
  distance_km: number;
  is_zone_optimized: boolean;
  score: number;
}

export class SmartScheduleDomainService {
  async findSlots(params: {
    serviceCategory: string;
    lat?: number;
    lng?: number;
    preferredDate: string;
    durationMinutes: number;
  }): Promise<ServiceResult<{ slots: SmartScheduleSlot[]; totalProviders: number }>> {
    // Only forward coords when both are real numbers — otherwise the backend
    // Zod parse would fail on `lat: undefined` (and we'd rather skip the
    // distance filter than reject the lookup outright).
    const body: Record<string, unknown> = {
      service_category: params.serviceCategory,
      preferred_date: params.preferredDate,
      duration_minutes: params.durationMinutes,
    };
    if (typeof params.lat === "number" && typeof params.lng === "number") {
      body.lat = params.lat;
      body.lng = params.lng;
    }
    const result = await apiRequest<{ slots?: any[]; total_providers?: number; totalProviders?: number }>(
      "/api/smart-schedule",
      {
        method: "POST",
        headers: getJsonHeaders(),
        body: JSON.stringify(body),
      }
    );

    if (!result.success || !result.data) {
      return { success: false, error: result.error };
    }

    const rawSlots = result.data.slots || [];
    const slots = rawSlots.map((slot) => ({
      provider_id: slot.provider_id || slot.providerId,
      provider_name: slot.provider_name || slot.providerName,
      start_time: slot.start_time || slot.startTime,
      end_time: slot.end_time || slot.endTime,
      estimated_travel_minutes: slot.estimated_travel_minutes || slot.travelMinutes || 0,
      distance_km: slot.distance_km || slot.distanceKm || 0,
      is_zone_optimized: slot.is_zone_optimized ?? slot.zoneOptimized ?? false,
      score: slot.score || 0,
    }));

    return {
      success: true,
      data: {
        slots,
        totalProviders: result.data.totalProviders || result.data.total_providers || new Set(slots.map((slot) => slot.provider_id)).size,
      },
    };
  }
}

let _instance: SmartScheduleDomainService | null = null;

export function getSmartScheduleService() {
  if (!_instance) _instance = new SmartScheduleDomainService();
  return _instance;
}
