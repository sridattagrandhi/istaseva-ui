// AsyncStorage-backed draft persistence for the listing-onboarding flow.
// Mobile mirror of web `src/lib/onboarding-draft.ts`.
//
// Drafts are keyed by (userId, entryType) so a half-finished property
// listing never appears when the host opens transport onboarding — each
// dashboard's "Add" doorway has its own resumable draft. Unlike the web
// (profile only), the envelope also carries the AI conversation and the
// view the user left from, so resuming drops them exactly where they were.
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { OnboardMsg } from "./onboarding";

const STORAGE_PREFIX = "onboarding-draft:v1:";

export type OnboardingDraftView = "ai" | "form";

export interface OnboardingDraftEnvelope {
  savedAt: string;
  /** The full ListingOnboarding form state `p` (profile + rooms + photos…). */
  form: Record<string, any>;
  /** AI conversation so resuming continues the chat instead of restarting. */
  aiMessages: OnboardMsg[];
  /** Where the user left off — resume reopens the same view. */
  view: OnboardingDraftView;
}

const keyFor = (userId: string | undefined | null, entryType: string) =>
  `${STORAGE_PREFIX}${userId || "anon"}:${entryType}`;

export async function loadOnboardingDraft(
  userId: string | undefined | null,
  entryType: string,
): Promise<{ draft: OnboardingDraftEnvelope | null; savedAt: Date | null }> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId, entryType));
    if (!raw) return { draft: null, savedAt: null };
    const env = JSON.parse(raw) as Partial<OnboardingDraftEnvelope>;
    if (!env || typeof env !== "object" || !env.form) return { draft: null, savedAt: null };
    const savedAt = env.savedAt ? new Date(env.savedAt) : null;
    return {
      draft: {
        savedAt: env.savedAt || "",
        form: env.form as Record<string, any>,
        aiMessages: Array.isArray(env.aiMessages) ? env.aiMessages : [],
        view: env.view === "ai" ? "ai" : "form",
      },
      savedAt: savedAt && !isNaN(savedAt.getTime()) ? savedAt : null,
    };
  } catch {
    return { draft: null, savedAt: null };
  }
}

export async function saveOnboardingDraft(
  userId: string | undefined | null,
  entryType: string,
  form: Record<string, any>,
  aiMessages: OnboardMsg[],
  view: OnboardingDraftView,
): Promise<void> {
  try {
    const env: OnboardingDraftEnvelope = {
      savedAt: new Date().toISOString(),
      form,
      aiMessages,
      view,
    };
    await AsyncStorage.setItem(keyFor(userId, entryType), JSON.stringify(env));
  } catch {
    /* best-effort — a failed autosave never blocks onboarding */
  }
}

export async function clearOnboardingDraft(
  userId: string | undefined | null,
  entryType: string,
): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(userId, entryType));
  } catch {
    /* ignore */
  }
}

/** "just now" / "n minutes ago" / "n hours ago" / "n days ago" — same
 *  wording as the web's describeAge so resume copy reads identically. */
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
