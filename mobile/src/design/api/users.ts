// design/api/users.ts — the signed-in user's editable profile (user_profiles).
// Distinct from Firebase auth (name/email): this is the marketplace profile
// the backend stores and other users see. Mirrors web src/domains/users.
import { api } from "@/lib/api";

export type UserProfile = {
  displayName: string;
  avatarUrl: string;
  bio: string;
  phone: string;
  location: string;
  preferredLanguage: string;
};

function mapProfile(d: any): UserProfile {
  return {
    displayName: d?.display_name ?? "",
    avatarUrl: d?.avatar_url ?? "",
    bio: d?.bio ?? "",
    phone: d?.phone ?? "",
    location: d?.location ?? "",
    preferredLanguage: d?.preferred_language ?? "",
  };
}

export async function fetchMyProfile(): Promise<UserProfile> {
  const res = await api.get("/api/users/me/profile");
  return mapProfile(res.data?.data ?? res.data);
}

/** PATCH only the provided fields (camelCase → snake_case). Returns the row. */
export async function updateMyProfile(fields: Partial<UserProfile>): Promise<UserProfile> {
  const KEYS: Record<keyof UserProfile, string> = {
    displayName: "display_name",
    avatarUrl: "avatar_url",
    bio: "bio",
    phone: "phone",
    location: "location",
    preferredLanguage: "preferred_language",
  };
  const body: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v === null || String(v).length === 0) {
      // Explicit null clears the avatar ("Remove photo"); empty strings on
      // text fields still mean "no change".
      if (k === "avatarUrl") body[KEYS.avatarUrl] = null;
      continue;
    }
    body[KEYS[k as keyof UserProfile]] = v;
  }
  const res = await api.patch("/api/users/me/profile", body);
  return mapProfile(res.data?.data ?? res.data);
}
