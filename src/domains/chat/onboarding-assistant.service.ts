import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { ServiceResult } from "@/types/domain";

export type OnboardingActionType =
  | "category_select"
  | "location_picker"
  | "photo_upload"
  | "price_input"
  | "availability_select"
  | "none";

export interface OnboardingAssistantResult {
  message: string;
  profile_updates: Record<string, string>;
  action: OnboardingActionType;
  is_complete: boolean;
}

export class OnboardingAssistantService {
  async respond(params: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    profile: Record<string, any>;
    displayLang: string;
    /** Which portal the user walked in through. The agent uses this to
     *  frame its questions and to redirect across portals when needed. */
    entryType?: "host" | "service" | "transport" | "any";
    /** Stable per-conversation id minted by the caller (useConversationEngine).
     *  Lets the backend's observability events thread across turns of the
     *  same chat instead of treating each turn as an isolated request.
     *  Optional — backend falls back to its per-request requestId. */
    sessionId?: string;
  }): Promise<ServiceResult<OnboardingAssistantResult>> {
    return apiRequest<OnboardingAssistantResult>("/api/onboarding-chat", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({
        messages: params.messages,
        profile: params.profile,
        displayLang: params.displayLang,
        entryType: params.entryType ?? "any",
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      }),
    });
  }
}

let _instance: OnboardingAssistantService | null = null;

export function getOnboardingAssistantService() {
  if (!_instance) _instance = new OnboardingAssistantService();
  return _instance;
}
