/**
 * Tool-call chip event emitter — Phase 5.
 *
 * The agent loop fires lifecycle events as tools start/finish so the
 * frontend can render `🔍 Searching stays in Coorg…` / `✓ Found 12 stays`
 * inline with the assistant's reply. Events go through the websocket
 * realtime provider on a per-request channel; the client subscribes
 * keyed by the requestId returned in the response.
 *
 * Filtering rules baked in here (rather than in the client):
 *   - `remember_preference` and other internal/utility tools are
 *     hidden from chips. The user shouldn't see "Saved diet" — that's
 *     supposed to feel invisible (per the tool's own prompt).
 *   - Chips with durationMs < 300 are dropped to avoid flicker. We
 *     send tool_start always but suppress tool_done for fast reads;
 *     the chip never appears in the UI.
 *
 * No-op if the chips flag is off — call sites can fire events
 * unconditionally without paying any cost.
 */
import { logger } from '../../../common/logging/logger.js';
import { config } from '../../../common/config/index.js';
import { wsRealtimeProvider } from '../../../common/providers/implementations/realtime/ws-realtime.provider.js';

/** Tools the user shouldn't see chips for (housekeeping / memory). */
const HIDDEN_TOOLS = new Set<string>([
  'remember_preference',
  // Onboarding internals — set_picker_action and extract_fields are
  // mechanical UI plumbing, not user-facing work.
  'set_picker_action',
  'extract_fields',
]);

const FAST_TOOL_THRESHOLD_MS = 300;

export type ChipEvent =
  | { type: 'tool_start'; name: string; argsSummary: string; ts: number }
  | { type: 'tool_done'; name: string; durationMs: number; summary: string; ts: number }
  | { type: 'tool_error'; name: string; message: string; ts: number };

function channel(userId: string, requestId: string): string {
  // User-scoped (SEC-005): the ws provider only lets a client subscribe to
  // its own `user:<uid>:...` channels, so prefixing with the userId is what
  // stops another user from watching this request's tool stream via a
  // guessed/leaked requestId. Keep the namespace explicit so a future
  // per-request stream of tokens (Phase 5b) can use a sibling channel
  // without collision.
  return `user:${userId}:assistant:${requestId}:tools`;
}

/** Should this tool surface as a chip at all? */
export function isUserVisibleTool(name: string): boolean {
  return !HIDDEN_TOOLS.has(name);
}

/** Best-effort publish; failures are logged at debug and never throw. */
async function publish(userId: string, requestId: string, event: ChipEvent): Promise<void> {
  if (!config.llm.assistantChipsEnabled) return;
  try {
    await wsRealtimeProvider.publish(channel(userId, requestId), event.type, event);
  } catch (err) {
    logger.debug('chip-emitter: publish failed', {
      requestId,
      type: event.type,
      error: (err as Error).message,
    });
  }
}

export async function emitToolStart(
  userId: string,
  requestId: string,
  name: string,
  argsSummary: string,
): Promise<void> {
  if (!isUserVisibleTool(name)) return;
  await publish(userId, requestId, { type: 'tool_start', name, argsSummary, ts: Date.now() });
}

export async function emitToolDone(
  userId: string,
  requestId: string,
  name: string,
  durationMs: number,
  summary: string,
): Promise<void> {
  if (!isUserVisibleTool(name)) return;
  // Drop chips for sub-300ms tool calls — they'd flicker in and out
  // before the user can read them.
  if (durationMs < FAST_TOOL_THRESHOLD_MS) return;
  await publish(userId, requestId, { type: 'tool_done', name, durationMs, summary, ts: Date.now() });
}

export async function emitToolError(
  userId: string,
  requestId: string,
  name: string,
  message: string,
): Promise<void> {
  if (!isUserVisibleTool(name)) return;
  await publish(userId, requestId, { type: 'tool_error', name, message, ts: Date.now() });
}
