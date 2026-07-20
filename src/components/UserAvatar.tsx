import type { CSSProperties, ReactNode } from "react";
import { useMyProfile } from "@/hooks/use-my-profile";

/**
 * The signed-in user's avatar: their uploaded photo (from the shared
 * `useMyProfile` cache) when set, otherwise the `initials` fallback. Reused
 * across the navbar and dashboard headers so a changed profile picture
 * reflects everywhere the moment the upload writes back to the cache.
 *
 * `className`/`style` describe the container (size, shape, background, and the
 * fallback text styling) — the image fills it with object-cover.
 */
export function UserAvatar({ initials, className, style }: {
  initials: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const { data: profile } = useMyProfile();
  return (
    <span className={`relative inline-grid place-items-center overflow-hidden ${className ?? ""}`} style={style}>
      {profile?.avatarUrl ? (
        <img src={profile.avatarUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        initials
      )}
    </span>
  );
}
