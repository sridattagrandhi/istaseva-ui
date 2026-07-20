// localStorage-backed draft persistence for the onboarding form.
//
// Drafts are keyed by (userId, listingType) so a half-finished property
// listing never appears when the user opens transport onboarding —
// each entry doorway has its own resumable draft. Type is one of
// "stay" | "service" | "transport" | "any".

const STORAGE_PREFIX = "onboarding-draft:v2:";
const LEGACY_PREFIX = "onboarding-draft:v1:";

export type OnboardingDraftType = "stay" | "service" | "transport" | "any";

interface DraftEnvelope {
  savedAt: string;
  type: OnboardingDraftType;
  profile: unknown;
  pendingRooms?: unknown;
}

function keyFor(userId: string | undefined | null, type: OnboardingDraftType): string {
  return `${STORAGE_PREFIX}${userId || "anon"}:${type}`;
}

export interface OnboardingDraftLoadResult<TProfile> {
  profile: TProfile | null;
  savedAt: Date | null;
  pendingRooms: unknown | null;
}

export interface OnboardingDraftSummary {
  type: OnboardingDraftType;
  savedAt: Date;
  category: string;
  name: string;
  location: string;
  photoCount: number;
}

export function loadOnboardingDraft<TProfile>(
  userId: string | undefined | null,
  type: OnboardingDraftType,
): OnboardingDraftLoadResult<TProfile> {
  try {
    if (typeof window === "undefined") return { profile: null, savedAt: null, pendingRooms: null };
    const raw = window.localStorage.getItem(keyFor(userId, type));
    if (!raw) return { profile: null, savedAt: null, pendingRooms: null };
    const env = JSON.parse(raw) as Partial<DraftEnvelope>;
    if (!env || typeof env !== "object" || !env.profile) {
      return { profile: null, savedAt: null, pendingRooms: null };
    }
    const savedAt = env.savedAt ? new Date(env.savedAt) : null;
    return {
      profile: env.profile as TProfile,
      savedAt: savedAt && !isNaN(savedAt.getTime()) ? savedAt : null,
      pendingRooms: env.pendingRooms ?? null,
    };
  } catch {
    return { profile: null, savedAt: null, pendingRooms: null };
  }
}

export function saveOnboardingDraft(
  userId: string | undefined | null,
  type: OnboardingDraftType,
  profile: unknown,
  pendingRooms?: unknown,
): boolean {
  try {
    if (typeof window === "undefined") return false;
    const env: DraftEnvelope = {
      savedAt: new Date().toISOString(),
      type,
      profile,
      pendingRooms,
    };
    window.localStorage.setItem(keyFor(userId, type), JSON.stringify(env));
    return true;
  } catch {
    return false;
  }
}

export function clearOnboardingDraft(
  userId: string | undefined | null,
  type: OnboardingDraftType,
): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(keyFor(userId, type));
  } catch {
    /* ignore */
  }
}

/** List every draft saved for this user (across types) plus any anonymous
 *  drafts created before sign-in. Used by MyListings to surface "continue
 *  where you left off" rows. */
export function listOnboardingDrafts(
  userId: string | undefined | null,
): OnboardingDraftSummary[] {
  if (typeof window === "undefined") return [];
  const ids = [userId || "anon"];
  if (userId) ids.push("anon");
  const out: OnboardingDraftSummary[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
    const suffix = key.slice(STORAGE_PREFIX.length);
    const [storedId, type] = suffix.split(":");
    if (!ids.includes(storedId)) continue;
    if (!type || seen.has(type)) continue;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const env = JSON.parse(raw) as Partial<DraftEnvelope>;
      const profile = (env.profile || {}) as {
        category?: string; name?: string; location?: string; photos?: unknown[];
      };
      const savedAt = env.savedAt ? new Date(env.savedAt) : null;
      if (!savedAt || isNaN(savedAt.getTime())) continue;
      out.push({
        type: (env.type as OnboardingDraftType) || (type as OnboardingDraftType),
        savedAt,
        category: profile.category || "",
        name: profile.name || "",
        location: profile.location || "",
        photoCount: Array.isArray(profile.photos) ? profile.photos.length : 0,
      });
      seen.add(type);
    } catch {
      /* ignore one bad entry */
    }
  }
  return out.sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime());
}

/** One-time migration: drop any v1 draft for this user. The v1 key was
 *  not type-scoped so resuming it in the wrong portal would show the
 *  wrong listing type. We silently discard rather than try to guess. */
export function migrateLegacyOnboardingDraft(userId: string | undefined | null): void {
  try {
    if (typeof window === "undefined") return;
    const legacyKey = `${LEGACY_PREFIX}${userId || "anon"}`;
    window.localStorage.removeItem(legacyKey);
  } catch {
    /* ignore */
  }
}

export function describeAge(savedAt: Date): string {
  const diff = Date.now() - savedAt.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
