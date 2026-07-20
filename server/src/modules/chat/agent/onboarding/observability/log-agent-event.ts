/**
 * Persist onboarding-agent tool calls + final replies so we can
 * actually see what the agent did in prod.
 *
 * Background — the audit ahead of this PR found:
 *   - Winston logs tool NAMES + duration only. No args, no results.
 *   - The HTTP response carries a toolCalls[] array that's discarded.
 *   - Conversation history is client-held; nothing is stored server-side.
 *
 * That means every staging regression turns into "ask the user what
 * they typed and re-derive what the model probably did." Phase 0.5
 * closes the gap with one append-only stream that survives the request.
 *
 * Storage: reuse the existing `audit_events` table from the events
 * provider. The provider abstraction already routes DynamoDB in prod
 * and the mock store in dev — no new table to provision. Rows are
 * tagged with `metadata.kind = ONBOARDING_AGENT_EVENT_KIND` for
 * filtering. Args and results are truncated to TRUNCATION_LIMIT bytes
 * each so a giant `transportationTypes` payload doesn't bloat the
 * row; the full payload still appears in the Winston INFO line for
 * forensic recovery if needed.
 *
 * Failure handling: logging MUST NEVER fail the agent turn. Every
 * write is wrapped — on error we log a warning and move on. The user-
 * visible response is unaffected.
 */
import { getEventProvider } from '../../../../../common/providers/registry.js';
import { logger } from '../../../../../common/logging/logger.js';
import { RETENTION_DAYS, ttlEpochSeconds } from '../../../../../common/config/retention.js';

export const ONBOARDING_AGENT_EVENT_KIND = 'onboarding_agent_tool_call';
const TRUNCATION_LIMIT = 4096;

export type AgentEventKind =
  | 'tool_call'
  | 'tool_error'
  | 'final_reply';

export interface AgentEventInput {
  /** Stable per-conversation id. The onboarding controller passes
   *  through whatever the client sent (or generates one); same id on
   *  every turn of the same conversation lets us reconstruct sessions. */
  sessionId: string;
  /** Authenticated user id from the request. */
  userId: string;
  /** UUID minted per agent invocation (matches AgentTurnContext.requestId). */
  requestId: string;
  /** Monotonic counter within the agent loop — every tool call in one
   *  turn gets a different turnIndex so they sort stably on replay. */
  turnIndex: number;
  kind: AgentEventKind;
  /** Tool name, for 'tool_call' and 'tool_error'. Omitted on 'final_reply'. */
  tool?: string;
  /** Args the model passed in. Truncated to TRUNCATION_LIMIT bytes. */
  args?: unknown;
  /** Tool result (for 'tool_call') or final reply payload (for 'final_reply'). */
  result?: unknown;
  errorMessage?: string;
  durationMs?: number;
}

function truncate(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const json = JSON.stringify(value);
  if (json.length <= TRUNCATION_LIMIT) return value;
  return { __truncated: true, bytes: json.length, preview: json.slice(0, TRUNCATION_LIMIT) };
}

/**
 * Persist one agent event. Returns void — failures are swallowed and
 * logged at WARN. The agent loop must never await this and have it
 * affect the user-visible turn outcome.
 */
export async function logAgentEvent(input: AgentEventInput): Promise<void> {
  try {
    const events = await getEventProvider();
    await events.putEvent('audit_events', {
      // EventResourceQuery uses (resource, resourceId) as the primary
      // partition shape — bucket onboarding-agent events under a
      // synthetic resource so queryByResource('onboarding_agent_session', sessionId)
      // returns the full turn history for one conversation.
      resource: 'onboarding_agent_session',
      resourceId: input.sessionId,
      userId: input.userId,
      timestamp: new Date().toISOString(),
      // Short TTL — onboarding sessions don't need long retention, and
      // forensic value drops off fast (centralized in config/retention.ts).
      expiresAt: ttlEpochSeconds(RETENTION_DAYS.agentEvents),
      metadata: {
        kind: ONBOARDING_AGENT_EVENT_KIND,
        eventKind: input.kind,
        requestId: input.requestId,
        turnIndex: input.turnIndex,
        tool: input.tool,
        durationMs: input.durationMs,
        errorMessage: input.errorMessage,
        args: truncate(input.args),
        result: truncate(input.result),
      },
    });
  } catch (err) {
    logger.warn('onboarding-agent: event log failed', {
      sessionId: input.sessionId,
      requestId: input.requestId,
      kind: input.kind,
      tool: input.tool,
      error: (err as Error).message,
    });
  }
}
