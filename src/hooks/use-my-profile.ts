import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { getUserService } from "@/domains/users/user.service";
import type { UserProfile } from "@/types/domain";

/** Stable query key for the signed-in user's profile row (user_profiles). */
export const MY_PROFILE_KEY = "my-profile" as const;

/**
 * Shared cache for the signed-in user's profile row. Every surface that shows
 * the user's avatar (navbar, dashboard headers, profile pages) reads through
 * this one query, so an avatar/profile change made anywhere reflects
 * everywhere once the mutating surface writes it back with
 * `queryClient.setQueryData([MY_PROFILE_KEY, userId], updated)`.
 */
export function useMyProfile() {
  const { user } = useAuth();
  return useQuery<UserProfile>({
    queryKey: [MY_PROFILE_KEY, user?.id],
    enabled: Boolean(user?.id),
    staleTime: 30_000,
    queryFn: async () => {
      const result = await getUserService().getProfile(String(user!.id));
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load profile");
      return result.data;
    },
  });
}
