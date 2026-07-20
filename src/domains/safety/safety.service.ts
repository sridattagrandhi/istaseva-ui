/**
 * Safety Domain Service
 */

import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { SafetyAlert, ServiceResult, UUID } from "@/types/domain";

// Row shape returned by the safety_alerts endpoints (snake_case DB columns).
interface SafetyAlertRow {
  id: string;
  user_id: string;
  booking_id: string | null;
  alert_type: string;
  description: string | null;
  location_lat: number | null;
  location_lng: number | null;
  status: string;
  emergency_contacts_notified: boolean;
  resolved_at?: string | null;
  created_at: string;
}

export class SafetyService {
  async createAlert(params: {
    userId: UUID;
    bookingId?: UUID;
    alertType?: string;
    description?: string;
    locationLat?: number;
    locationLng?: number;
  }): Promise<ServiceResult<SafetyAlert>> {
    const result = await apiRequest<{ data: SafetyAlertRow }>("/api/safety/alerts", {
      method: "POST",
      headers: getJsonHeaders(),
      // status / emergency_contacts_notified are server-owned (SEC-006) —
      // the API ignores them, so don't send them.
      body: JSON.stringify({
        booking_id: params.bookingId,
        alert_type: params.alertType || "sos",
        description: params.description,
        location_lat: params.locationLat,
        location_lng: params.locationLng,
      }),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: this.mapAlert(result.data.data) };
  }

  async getUserAlerts(_userId: UUID): Promise<ServiceResult<SafetyAlert[]>> {
    const result = await apiRequest<{ data: SafetyAlertRow[] }>("/api/safety/alerts", {
      headers: getJsonHeaders(false),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: (result.data.data || []).map(this.mapAlert) };
  }

  async resolveAlert(_alertId: UUID): Promise<ServiceResult<void>> {
    return { success: false, error: "Resolve alert endpoint is not implemented yet" };
  }

  async createCheck(params: {
    bookingId: UUID;
    checkType: string;
    response: string;
    severity: string;
  }): Promise<ServiceResult<void>> {
    // initiated_by is derived server-side from the authenticated user
    // (SEC-006 actor forgery) — the API ignores any client-sent value.
    const result = await apiRequest<{ data: unknown }>("/api/safety/checks", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({
        booking_id: params.bookingId,
        check_type: params.checkType,
        response: params.response,
        severity: params.severity,
        is_resolved: true,
      }),
    });
    if (!result.success) return { success: false, error: result.error };
    return { success: true };
  }

  private mapAlert(row: SafetyAlertRow): SafetyAlert {
    return {
      id: row.id,
      userId: row.user_id,
      bookingId: row.booking_id,
      alertType: row.alert_type,
      description: row.description,
      locationLat: row.location_lat,
      locationLng: row.location_lng,
      status: row.status,
      emergencyContactsNotified: row.emergency_contacts_notified,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
    };
  }
}

let _instance: SafetyService | null = null;
export function getSafetyService(): SafetyService {
  if (!_instance) _instance = new SafetyService();
  return _instance;
}
