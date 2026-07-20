/**
 * Notification Domain Service
 */

import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { Notification, ServiceResult, UUID } from "@/types/domain";

export class NotificationService {
  async getUserNotifications(_userId: UUID): Promise<ServiceResult<Notification[]>> {
    const result = await apiRequest<{ data: any[] }>("/api/notifications", {
      headers: getJsonHeaders(false),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: (result.data.data || []).map(this.mapNotification) };
  }

  async markAsRead(notificationId: UUID): Promise<ServiceResult<void>> {
    const result = await apiRequest<{ data: any }>(`/api/notifications/${notificationId}/read`, {
      method: "PATCH",
      headers: getJsonHeaders(),
    });
    if (!result.success) return { success: false, error: result.error };
    return { success: true };
  }

  async markAllAsRead(_userId: UUID): Promise<ServiceResult<void>> {
    const result = await apiRequest<{ success: true }>("/api/notifications/mark-all-read", {
      method: "POST",
      headers: getJsonHeaders(),
    });
    if (!result.success) return { success: false, error: result.error };
    return { success: true };
  }

  async deleteNotification(_notificationId: UUID): Promise<ServiceResult<void>> {
    return { success: false, error: "Delete notification endpoint is not implemented yet" };
  }

  async createNotification(_params: {
    userId: UUID;
    type: string;
    title: string;
    message: string;
    link?: string;
    metadata?: Record<string, any>;
  }): Promise<ServiceResult<Notification>> {
    return { success: false, error: "Notifications are server-owned" };
  }

  private mapNotification(row: any): Notification {
    return {
      id: row.id,
      userId: row.user_id,
      type: row.type,
      title: row.title,
      message: row.message,
      link: row.link,
      isRead: row.is_read,
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }
}

let _instance: NotificationService | null = null;
export function getNotificationService(): NotificationService {
  if (!_instance) _instance = new NotificationService();
  return _instance;
}
