/**
 * In-memory session store for the Ista AI chat.
 *
 * The chat screen is a modal that unmounts constantly — every "Open" tap on
 * an inline card navigates away — so keeping the thread in screen state
 * loses the conversation mid-booking. This module keeps it alive for the
 * lifetime of the APP PROCESS, deliberately NOT on disk:
 *   - privacy: threads carry addresses, travel dates, community affirmations;
 *   - staleness: interactive cards age badly across launches (a Confirm & Pay
 *     hold dies in 5 min; availability-verified cards stop being verified);
 *   - expectation: kill the app → fresh start; switch screens → keep thread.
 * Durable cross-session memory belongs server-side (user_assistant_memory).
 *
 * The store is owner-scoped: a session saved by one signed-in user (or by
 * the signed-out state) is discarded — not returned — when a different user
 * opens the chat, so a shared device never shows someone else's thread.
 */

type Stored<M> = { ownerUid: string | null; msgs: M[]; suggestions: string[] };

// Cap what we retain so a marathon session doesn't bloat re-renders. The
// server already tail-windows what the LLM sees (MAX_HISTORY_MESSAGES=40);
// this only bounds the client-side render list.
const MAX_STORED_MSGS = 100;

let stored: Stored<unknown> | null = null;

/** The saved thread for this owner, or null (and a wiped store) when the
 *  session belongs to someone else / nothing is saved / it's the greeting-only
 *  thread. uid is the signed-in user's id, or null when signed out. */
export function loadChatSession<M>(uid: string | null): { msgs: M[]; suggestions: string[] } | null {
  if (!stored) return null;
  if (stored.ownerUid !== uid) {
    // Different account (or sign-in state) than the one that wrote it —
    // never leak a thread across users on a shared device.
    stored = null;
    return null;
  }
  return { msgs: stored.msgs as M[], suggestions: stored.suggestions };
}

export function saveChatSession<M>(uid: string | null, msgs: M[], suggestions: string[]): void {
  stored = {
    ownerUid: uid,
    msgs: msgs.length > MAX_STORED_MSGS ? msgs.slice(-MAX_STORED_MSGS) : msgs,
    suggestions,
  };
}

export function resetChatSession(): void {
  stored = null;
}
