// design/api/onboarding.ts — AI listing onboarding (POST /api/onboarding-chat).
// The agent collects listing fields conversationally and returns flat
// profile_updates the client merges into the onboarding form profile.
// Response: { message, profile_updates, action, is_complete }.
import { api } from "@/lib/api";

export type OnboardMsg = { role: "system" | "user" | "assistant"; content: string };
export type OnboardEntry = "host" | "service" | "transport" | "any";

export type OnboardReply = {
  message: string;
  profileUpdates: Record<string, any>;
  action: string;
  isComplete: boolean;
};

/** Map the mobile dashboard role to the backend entryType the agent expects. */
export function entryFor(role: string): OnboardEntry {
  if (role === "stay") return "host";
  if (role === "service") return "service";
  if (role === "transport") return "transport";
  return "any";
}

export async function sendOnboardingChat(input: {
  messages: OnboardMsg[];
  profile: Record<string, any>;
  entryType: OnboardEntry;
  sessionId?: string;
}): Promise<OnboardReply> {
  const res = await api.post("/api/onboarding-chat", {
    messages: input.messages,
    profile: input.profile ?? {},
    displayLang: "en",
    entryType: input.entryType,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
  const d = res.data || {};
  return {
    message: d.message || "",
    profileUpdates: d.profile_updates ?? d.profileUpdates ?? {},
    action: d.action || "none",
    isComplete: Boolean(d.is_complete ?? d.isComplete),
  };
}

/**
 * Opt-in "enhance with AI" for a listing description (manual form). The
 * server returns the original text unchanged when it can't improve it (or
 * under the dev mock model), so the caller can always drop the result back
 * into the field safely.
 */
export async function enhanceOnboardingDescription(input: {
  description: string;
  profile: Record<string, any>;
}): Promise<string> {
  const res = await api.post("/api/onboarding-chat/enhance-description", {
    description: input.description ?? "",
    profile: input.profile ?? {},
  });
  const d = res.data || {};
  return typeof d.description === "string" ? d.description : (input.description ?? "");
}
