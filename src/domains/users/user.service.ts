/**
 * User Domain Service
 */

import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { ServiceResult, UserProfile, UUID } from "@/types/domain";

export class UserService {
  async getProfile(_userId: UUID): Promise<ServiceResult<UserProfile>> {
    const result = await apiRequest<{ data: any }>("/api/users/me/profile", {
      headers: getJsonHeaders(false),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: this.mapProfile(result.data.data) };
  }

  async updateProfile(_userId: UUID, updates: Partial<UserProfile>): Promise<ServiceResult<UserProfile>> {
    const dbUpdates: any = {};
    if (updates.displayName !== undefined) dbUpdates.display_name = updates.displayName;
    if (updates.avatarUrl !== undefined) dbUpdates.avatar_url = updates.avatarUrl;
    if (updates.bio !== undefined) dbUpdates.bio = updates.bio;
    if (updates.phone !== undefined) dbUpdates.phone = updates.phone;
    if (updates.location !== undefined) dbUpdates.location = updates.location;
    if (updates.preferredLanguage !== undefined) dbUpdates.preferred_language = updates.preferredLanguage;

    const result = await apiRequest<{ data: any }>("/api/users/me/profile", {
      method: "PATCH",
      headers: getJsonHeaders(),
      body: JSON.stringify(dbUpdates),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: this.mapProfile(result.data.data) };
  }

  private mapProfile(row: any): UserProfile {
    return {
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      bio: row.bio,
      phone: row.phone,
      location: row.location,
      preferredLanguage: row.preferred_language || "en",
      verificationStatus: row.verification_status,
      verifiedAt: row.verified_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

let _instance: UserService | null = null;
export function getUserService(): UserService {
  if (!_instance) _instance = new UserService();
  return _instance;
}
