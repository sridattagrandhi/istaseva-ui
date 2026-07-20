/**
 * Tool-calling agent types.
 *
 * Phase 1 of the assistant overhaul: replace the single-shot intent
 * classifier with a bounded loop where the model can call typed tools and
 * see results before composing its final reply. See AI_AGENT_PLAN.md.
 *
 * Naming: tool names are snake_case to match Gemini's preferred style for
 * functionDeclarations. JS-side identifiers (camelCase) are used in code.
 */
import { z } from 'zod';

/**
 * Per-turn execution context handed to every tool's `execute`. Lets tools
 * access auth, locale, and emit progress events without each one taking a
 * grab-bag of parameters.
 */
export interface AgentTurnContext {
  /** Authenticated user id from `requireAuth`. Tools that read user-scoped
   *  data MUST use this — never trust an id from tool args. */
  userId: string;
  /** Optional user role for tools that need to gate by host/guest/etc. */
  userRole?: string;
  /** UI-selected display language (header dropdown). Tools may include this
   *  in result formatting, but the AGENT does its own language detection
   *  from the user's most recent message — this is only a hint. */
  displayLang: string;
  /** Frontend-supplied path for grounding (e.g. /explore vs /services). */
  path?: string;
  /** UUID minted client-side; used to correlate tool events on the realtime
   *  channel in Phase 5. Phase 1 just logs it. */
  requestId: string;
  /** Cancels in-flight tool calls if the agent loop is aborted (max-turns,
   *  upstream client disconnect, etc.). */
  abortSignal: AbortSignal;
  /** Stores tool results keyed by `${name}:${stableArgsHash}` so the
   *  grounding check (Phase 4) and the agent itself can avoid duplicate
   *  calls within one turn. */
  toolResultCache: Map<string, unknown>;
}

/**
 * Definition of one tool the agent can call.
 *
 * The dual schema (zod + JSON Schema) is intentional: the JSON Schema is
 * what we hand to the model (Gemini accepts a JSON-Schema subset), the zod
 * schema is what we use to validate model-emitted args before execution.
 * Keeping both in sync is a small price for type safety on `execute`.
 */
export interface ToolDefinition<TArgs = Record<string, unknown>, TResult = unknown> {
  /** snake_case, matches Gemini convention. */
  name: string;
  /** Shown to the model — be specific about WHEN to call it, not just what
   *  it does. The model picks tools based on this text. */
  description: string;
  /** JSON Schema fed to functionDeclarations. */
  parametersJsonSchema: Record<string, unknown>;
  /** Server-side validation. Fails fast if the model hallucinates args.
   *  Uses `ZodType<TArgs, ZodTypeDef, unknown>` so schemas with `.default(...)`
   *  (which have an optional input but a required output) typecheck. */
  argsSchema: z.ZodType<TArgs, z.ZodTypeDef, unknown>;
  /** 'read' tools may execute freely; 'write' tools (Phase 2+) require an
   *  explicit UI confirmation event before firing. Phase 1 ships read-only. */
  sideEffect: 'read' | 'write';
  /** The actual implementation. Should throw on auth/validation failure;
   *  the loop wraps the throw into a `tool_error` response so the model
   *  can recover instead of dying. */
  execute(args: TArgs, ctx: AgentTurnContext): Promise<TResult>;
  /** Human-readable summary used for logs and (Phase 5) UI chips. Keep
   *  short — appears as `✓ Found 12 stays`. */
  summarize(args: TArgs, result: TResult): string;
}

/**
 * What a tool's `execute` returns to the loop. We always wrap so the model
 * sees a consistent shape — `ok:false` is recoverable; throwing is not.
 */
export type ToolExecutionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };
