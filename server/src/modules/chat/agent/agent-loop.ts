/**
 * Bounded tool-calling loop.
 *
 * Phase 1 of the assistant overhaul. Drives one full user→assistant turn:
 *   1. Send the conversation + declared tools to the LLM.
 *   2. If the LLM emits tool calls, validate args, execute in parallel,
 *      append a tool-response turn, repeat.
 *   3. If the LLM emits text (or no tools were called), expect that text
 *      to be JSON in the legacy `{message, action, suggestions}` shape so
 *      the existing UI keeps working unchanged.
 *
 * The hard cap on tool turns prevents a confused model from looping on
 * itself indefinitely. When the cap trips we return a generic graceful
 * fallback instead of pretending the model finished cleanly.
 */
import { logger } from '../../../common/logging/logger.js';
import { config } from '../../../common/config/index.js';
import type {
  ILlmProvider,
  LlmTurn,
  LlmToolDeclaration,
  LlmToolCall,
} from '../../../common/providers/interfaces/llm-provider.interface.js';
import type { AgentTurnContext, ToolDefinition } from './types.js';
import { TOOLS_BY_NAME } from './tools/index.js';
import {
  checkGrounding,
  emptyGroundingCache,
  ingestToolResult,
  looksLikeListingRecommendation,
  namesGroundedInHits,
  type GroundingCache,
} from './grounding-check.js';
import { readRecentHits } from './recent-hits.js';
import { intentFromToolCalls, updateBookingIntent } from './booking-intent.js';
import { emitToolStart, emitToolDone, emitToolError } from './chip-emitter.js';
import {
  predictSearchArgs,
  startSpeculativeSearch,
  argsMatch,
  type SpeculativeHandle,
} from './speculative.js';

export interface AgentLoopInput {
  /** Provider must implement `generateWithTools`. Phase 1 mandates Gemini. */
  llm: ILlmProvider;
  /** System prompt — should describe the tools and the JSON output contract. */
  systemPrompt: string;
  /** Prior chat history mapped into our neutral turn shape. */
  initialTurns: LlmTurn[];
  /** Read/write tools available this turn. Phase 1 = read-only set. */
  tools: ToolDefinition[];
  ctx: AgentTurnContext;
  /** Optional override for the dispatch lookup. Phase 2b's onboarding
   *  agent passes its own toolsByName so onboarding tools don't have to
   *  pollute the assistant's TOOLS_BY_NAME. Defaults to assistant tools. */
  toolsByName?: Record<string, ToolDefinition>;
}

export interface AgentLoopOutput {
  /** Parsed final reply in the legacy contract — passed through to the UI. */
  reply: { message: string; action?: { type: string; params?: Record<string, unknown> }; suggestions?: string[] };
  /** Telemetry for logging + future Phase 5 chips. */
  toolCalls: Array<{ name: string; args: Record<string, unknown>; durationMs: number; ok: boolean; summary?: string; result?: Record<string, unknown> }>;
  /** True when the loop hit the max-turns cap rather than finishing cleanly. */
  truncated: boolean;
}

/** Convert our `ToolDefinition[]` into the provider-neutral declaration shape. */
function toLlmDeclarations(tools: ToolDefinition[]): LlmToolDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parametersJsonSchema,
  }));
}

/**
 * Validate args + execute one tool call. Catches everything so a single
 * tool failure feeds back into the model as a recoverable error rather
 * than tanking the whole turn.
 */
async function runOne(
  call: LlmToolCall,
  ctx: AgentTurnContext,
  toolsByName: Record<string, ToolDefinition>,
  options?: {
    /** Phase 5: a speculative result for this tool, if the
     *  pre-classifier guessed correctly. When set, runOne reuses it
     *  instead of executing again. */
    reusableData?: unknown;
    reusableDurationMs?: number;
  },
): Promise<{ name: string; result: Record<string, unknown>; durationMs: number; ok: boolean; summary?: string; args: Record<string, unknown> }> {
  const def = toolsByName[call.name] as ToolDefinition | undefined;
  const start = Date.now();
  if (!def) {
    return {
      name: call.name,
      args: call.args,
      durationMs: 0,
      ok: false,
      result: { ok: false, error: `Unknown tool: ${call.name}` },
    };
  }

  // Validate model-emitted args against the tool's zod schema before we
  // hand them to `execute`. If the model hallucinated a parameter, this is
  // where we catch it and tell the model to retry rather than passing
  // garbage into our services.
  const parsed = def.argsSchema.safeParse(call.args);
  if (!parsed.success) {
    return {
      name: call.name,
      args: call.args,
      durationMs: Date.now() - start,
      ok: false,
      result: {
        ok: false,
        error: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      },
    };
  }

  // Fire tool_start for the chip stream — best-effort, not awaited so
  // it can't add latency to the actual tool execution.
  void emitToolStart(ctx.userId, ctx.requestId, call.name, summariseArgs(call.args));

  try {
    // Phase 5: reuse speculative result if we have one. The chip-stream
    // still gets tool_start above + tool_done below so the UI shows the
    // work even though we didn't pay for the execution.
    const data = options?.reusableData !== undefined
      ? options.reusableData
      : await def.execute(parsed.data as never, ctx);
    const durationMs = options?.reusableData !== undefined
      ? (options.reusableDurationMs ?? 0)
      : (Date.now() - start);
    const summary = def.summarize(parsed.data as never, data as never);
    void emitToolDone(ctx.userId, ctx.requestId, call.name, durationMs, summary);
    return {
      name: call.name,
      args: call.args,
      durationMs,
      ok: true,
      summary,
      result: { ok: true, data: data as Record<string, unknown> },
    };
  } catch (err) {
    const message = (err as Error).message ?? 'Tool execution failed';
    logger.warn('agent-loop: tool execution failed', { tool: call.name, error: message });
    void emitToolError(ctx.userId, ctx.requestId, call.name, message);
    return {
      name: call.name,
      args: call.args,
      durationMs: Date.now() - start,
      ok: false,
      result: { ok: false, error: message },
    };
  }
}

/** One-line summary of a tool's args for the chip's pending state.
 *  E.g. {category:'stay',location:'Coorg'} → "stay in Coorg". */
function summariseArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  // Lead with the pricing-mode adjective so "hourly transport in hyderabad"
  // makes the active filter visible. Mode chips are the user's main signal
  // that the agent actually honoured "by the hour" / "tour package" — the
  // chip used to read "transport in hyderabad" regardless of mode and the
  // user couldn't tell whether the filter applied.
  if (typeof args.transportPricingMode === 'string') parts.push(args.transportPricingMode);
  if (typeof args.category === 'string') parts.push(args.category);
  if (typeof args.location === 'string') parts.push(`in ${args.location}`);
  if (typeof args.query === 'string' && !parts.length) parts.push(`"${args.query}"`);
  if (typeof args.bookingId === 'string') parts.push(args.bookingId.slice(0, 8));
  if (typeof args.listingId === 'string' && !parts.length) parts.push(args.listingId.slice(0, 8));
  return parts.join(' ');
}

/**
 * Try to parse a model text reply as the legacy `{message, action, suggestions}`
 * JSON. If parsing fails (model returned plain text), wrap it into the
 * minimal valid shape so the UI keeps rendering instead of erroring.
 */
function parseReply(text: string): AgentLoopOutput['reply'] {
  const trimmed = text.trim();
  // Strip markdown fences the same way generateStructuredJson does.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fence ? fence[1].trim() : trimmed;
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    return { message: trimmed || "Hmm, didn't catch that — say it again?" };
  }
  try {
    const obj = JSON.parse(candidate.slice(first, last + 1));
    return {
      message: typeof obj.message === 'string' ? obj.message : trimmed,
      action: obj.action,
      suggestions: Array.isArray(obj.suggestions) ? obj.suggestions.slice(0, 3) : undefined,
    };
  } catch {
    return { message: trimmed };
  }
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopOutput> {
  if (!input.llm.generateWithTools) {
    throw new Error(
      'Configured LLM provider does not implement generateWithTools — agent loop requires Gemini in Phase 1.',
    );
  }

  // Speculative cleanup — `currentHandle` is the in-flight (or
  // most-recently aborted) speculation. We abort it on any exit
  // path (max turns, abort, final reply, throw) so we never leak a
  // fetch on a prediction the model didn't take.
  let currentHandle: SpeculativeHandle | null = null;
  const registerSpeculative = (h: SpeculativeHandle | null) => { currentHandle = h; };
  try {
    return await runAgentLoopInner(input, registerSpeculative);
  } finally {
    try { (currentHandle as SpeculativeHandle | null)?.abort.abort(); } catch { /* noop */ }
  }
}

async function runAgentLoopInner(
  input: AgentLoopInput,
  registerSpeculative: (h: SpeculativeHandle | null) => void,
): Promise<AgentLoopOutput> {
  // Public runAgentLoop guards `generateWithTools` is defined; the
  // inner copy needs a local handle for the type narrower.
  // Bind to the provider so `this` is preserved — `generateWithTools`
  // calls `this.getClient()` internally, and a bare method reference
  // loses its receiver when invoked as a plain function.
  const generateWithTools = input.llm.generateWithTools!.bind(input.llm);
  const declarations = toLlmDeclarations(input.tools);
  const turns: LlmTurn[] = [...input.initialTurns];
  const toolCalls: AgentLoopOutput['toolCalls'] = [];
  const maxTurns = config.llm.assistantMaxToolTurns;
  const toolsByName = input.toolsByName ?? TOOLS_BY_NAME;
  // Phase 4: collect what tools surfaced this turn so the grounding
  // check can verify the model's reply only cites real entities. We
  // populate this every time a tool returns ok:true.
  const groundingCache: GroundingCache = emptyGroundingCache();
  // One-shot guard so we force a search-first regen at most once per turn
  // (a model that ignores the correction shouldn't loop the budget away).
  let forcedSearchRegen = false;

  // Phase 5: speculative search. Fire-and-forget so the LLM call below
  // and this run in parallel; we harvest if/when the model emits a
  // matching tool call. A mismatched prediction is silently aborted.
  let speculative: SpeculativeHandle | null = null;
  if (config.llm.assistantSpeculativeEnabled && toolsByName['search_listings']) {
    // Only the most recent USER turn can carry a search signal — assistant
    // turns are model output, tool turns are responses, neither help.
    const lastUser = [...input.initialTurns].reverse().find((t) => t.role === 'user' && 'content' in t);
    const text = lastUser && 'content' in lastUser ? lastUser.content : '';
    const prediction = predictSearchArgs(text);
    if (prediction) {
      logger.debug('agent-loop: speculative search kicked off', {
        requestId: input.ctx.requestId,
        prediction,
      });
      speculative = startSpeculativeSearch(prediction, input.ctx);
      registerSpeculative(speculative);
    }
  }

  for (let i = 0; i < maxTurns; i++) {
    if (input.ctx.abortSignal.aborted) {
      return {
        reply: { message: 'Got it, holding off — let me know what you need.' },
        toolCalls,
        truncated: true,
      };
    }

    const llmResult = await generateWithTools({
      turns,
      systemPrompt: input.systemPrompt,
      tools: declarations,
      // Slightly lower than generateStructuredJson's 0.85 — when there are
      // tools available, creativity in word choice still matters but we
      // want the model to be a bit more deterministic about when to call
      // them. Final-reply turn uses the same temperature; we may split
      // this in Phase 5.
      temperature: 0.7,
      maxTokens: 1024,
    });

    if (llmResult.toolCalls.length === 0) {
      // Model decided it's done. Parse the legacy JSON reply shape.
      let reply = parseReply(llmResult.text ?? '');

      // Hallucination tripwire for the "recommended listings WITHOUT searching"
      // case. The standard grounding check below only runs when a tool surfaced
      // data (non-empty cache); a model that names listings with ZERO tool
      // calls would otherwise ship pure invention. If the reply lists named
      // listings, no listing tool ran this turn (cache has no names), and those
      // names aren't listings the user already saw (recent hits), force ONE
      // search-first regen instead of shipping fabricated options.
      if (
        config.llm.assistantGroundingEnabled
        && !forcedSearchRegen
        && groundingCache.names.size === 0
        && looksLikeListingRecommendation(reply.message)
      ) {
        let recentNames = new Set<string>();
        try {
          const recent = await readRecentHits(input.ctx.userId);
          recentNames = new Set(recent.map((h) => h.title.toLowerCase()));
        } catch { /* best-effort — treat as no recent hits */ }
        if (!namesGroundedInHits(reply.message, recentNames)) {
          forcedSearchRegen = true;
          logger.warn('agent-loop: listings named without a tool call — forcing search-first regen', {
            requestId: input.ctx.requestId,
            userId: input.ctx.userId,
          });
          turns.push({ role: 'assistant', content: llmResult.text ?? '' });
          turns.push({
            role: 'user',
            content:
              'You named or recommended listings that did NOT come from any tool this turn. You MUST call search_listings and recommend ONLY listings it returns. If the search comes back empty, say so plainly — never invent listing names, locations, or prices. The user never saw your previous draft — do NOT apologize for or mention this correction ("my bad", "I got ahead of myself"); reply as if this were your first answer.',
          });
          continue; // re-enter the loop so the model actually searches
        }
      }

      // Phase 4: grounding check + one-shot regen. We only run this when
      // the flag's on AND we actually have tool data to check against —
      // a casual chat turn with no tool calls has no risk surface.
      if (
        config.llm.assistantGroundingEnabled
        && (groundingCache.ids.size > 0 || groundingCache.names.size > 0)
        && generateWithTools
      ) {
        const check = checkGrounding(reply.message, groundingCache);
        if (!check.ok) {
          logger.warn('agent-loop: grounding violation, regenerating once', {
            requestId: input.ctx.requestId,
            userId: input.ctx.userId,
            violations: check.violations,
          });

          // Append a system note + the model's previous (bad) reply so
          // the regen sees both. We do NOT replay tool calls — those
          // already happened; the model just needs to compose its
          // reply more carefully.
          const note = `Your previous reply contained ungrounded claims: ${check.violations.join('; ')}. Reply again using ONLY listings, ids, and prices that came from the tool results in this conversation. If you don't have a specific listing/price to recommend, say so plainly instead of inventing one.`;

          turns.push({ role: 'assistant', content: llmResult.text ?? '' });
          turns.push({ role: 'user', content: note });

          try {
            const regen = await generateWithTools({
              turns,
              systemPrompt: input.systemPrompt,
              tools: declarations,
              temperature: 0.5, // tighten for the corrective pass
              maxTokens: 1024,
            });
            // The regen may itself emit tool calls (e.g. "I need to
            // search again"). Honour those by falling through into the
            // outer loop's tool-execution branch — easier than handling
            // a special case here. We simulate that by overriding
            // llmResult and continuing.
            if (regen.toolCalls.length > 0) {
              turns.push({ role: 'assistant', toolCalls: regen.toolCalls });
              const calls2 = regen.toolCalls;
              const executed2 = await Promise.all(
                calls2.map((call) => runOne(call, input.ctx, toolsByName)),
              );
              for (const e of executed2) {
                toolCalls.push({ name: e.name, args: e.args, durationMs: e.durationMs, ok: e.ok, summary: e.summary, result: e.result });
                if (e.ok) ingestToolResult(groundingCache, e.result);
              }
              // Same slot harvest as the main execution site below.
              const regenIntentPatch = intentFromToolCalls(executed2.map((e) => ({ name: e.name, args: e.args })));
              if (Object.keys(regenIntentPatch).length > 0) {
                void updateBookingIntent(input.ctx.userId, regenIntentPatch);
              }
              turns.push({
                role: 'tool',
                responses: calls2.map((call, idx) => ({ id: call.id, name: call.name, response: executed2[idx].result })),
              });
              // Loop back into the outer `for` to ask the model again.
              continue;
            }
            const regenReply = parseReply(regen.text ?? '');
            const regenCheck = checkGrounding(regenReply.message, groundingCache);
            if (!regenCheck.ok) {
              // Two strikes — ship the regen anyway and log for Phase 6
              // telemetry. Loop-forever is worse than one questionable
              // reply that's at least fewer fabrications than the first.
              logger.error('agent-loop: grounding_failed (regen also violated)', {
                requestId: input.ctx.requestId,
                userId: input.ctx.userId,
                first: check.violations,
                regen: regenCheck.violations,
              });
            }
            reply = regenReply;
          } catch (err) {
            // Regen call itself failed — keep the original reply rather
            // than 500ing the user. Log for visibility.
            logger.warn('agent-loop: grounding regen failed', {
              requestId: input.ctx.requestId,
              error: (err as Error).message,
            });
          }
        }
      }

      return {
        reply,
        toolCalls,
        truncated: false,
      };
    }

    // Append the assistant's tool-call turn to history.
    turns.push({ role: 'assistant', toolCalls: llmResult.toolCalls });

    // Execution policy:
    //   - Reads (search, details, availability, bookings, *_preview) run in
    //     parallel — no ordering dependency, faster wall-clock.
    //   - Writes (prepare_booking, escalate, remember_preference) run
    //     sequentially in declaration order. Two writes in one model turn
    //     is rare and usually a sign the model is confused; sequential
    //     execution keeps them auditable and avoids racing on the same
    //     resource (e.g. two prepare_bookings on the same slot).
    const calls = llmResult.toolCalls;
    const isWrite = calls.map((c) => {
      const def = toolsByName[c.name];
      return def?.sideEffect === 'write';
    });
    const hasWrite = isWrite.some(Boolean);

    // Phase 5: try to harvest the speculative result. We only do this
    // for the FIRST `search_listings` call this turn — once we've reused
    // it, we drop the handle so no later call accidentally reuses stale
    // data. On a mismatch we abort the speculation outright.
    const speculativeReuses = new Map<string, { data: unknown; durationMs: number }>();
    if (speculative) {
      const matchingIdx = calls.findIndex((c) => c.name === 'search_listings' && argsMatch(speculative!.prediction, c.args));
      if (matchingIdx !== -1) {
        // Wait for the speculative search (it may already be done — the
        // promise resolves immediately in that case). If it threw we
        // fall back to normal execution by leaving the map empty.
        const start = Date.now();
        const data = await speculative.promise;
        if (data) {
          speculativeReuses.set(calls[matchingIdx].id, {
            data,
            durationMs: Date.now() - start,
          });
          logger.debug('agent-loop: speculative search harvested', {
            requestId: input.ctx.requestId,
            callId: calls[matchingIdx].id,
          });
        }
        speculative = null; // one-shot
        registerSpeculative(null);
      } else {
        // Model went a different direction — speculation wasted, abort.
        speculative.abort.abort();
        speculative = null;
        registerSpeculative(null);
      }
    }

    let executed: Awaited<ReturnType<typeof runOne>>[];
    if (hasWrite) {
      executed = [];
      for (const call of calls) {
        const reuse = speculativeReuses.get(call.id);
        executed.push(await runOne(call, input.ctx, toolsByName, reuse ? { reusableData: reuse.data, reusableDurationMs: reuse.durationMs } : undefined));
      }
    } else {
      executed = await Promise.all(calls.map((call) => {
        const reuse = speculativeReuses.get(call.id);
        return runOne(call, input.ctx, toolsByName, reuse ? { reusableData: reuse.data, reusableDurationMs: reuse.durationMs } : undefined);
      }));
    }

    for (const e of executed) {
      toolCalls.push({
        name: e.name,
        args: e.args,
        durationMs: e.durationMs,
        ok: e.ok,
        summary: e.summary,
        // Pass the full tool result through so callers can act on it
        // (e.g. user-assistant.service.ts promotes a successful
        // open_listing call into the final navigation action).
        result: e.result,
      });
      // Feed ok-results into the grounding cache. The check itself
      // runs once at the end, against the model's final reply.
      if (e.ok) {
        ingestToolResult(groundingCache, e.result);
      }
    }

    // Slot memory: booking-relevant args the model just threaded into tool
    // calls are user-established facts (date, mode, passengers, pickup) —
    // persist them so the NEXT turn's context can mark them "already
    // answered, don't re-ask". Failed calls harvest too: a prepare_booking
    // that bounced on "which package?" still carried a correct date/pickup.
    const intentPatch = intentFromToolCalls(executed.map((e) => ({ name: e.name, args: e.args })));
    if (Object.keys(intentPatch).length > 0) {
      void updateBookingIntent(input.ctx.userId, intentPatch);
    }

    // Feed every tool result back in one tool-turn, paired by name+order.
    turns.push({
      role: 'tool',
      responses: llmResult.toolCalls.map((call, idx) => ({
        id: call.id,
        name: call.name,
        response: executed[idx].result,
      })),
    });
  }

  // Hit the cap. Return a graceful fallback instead of pretending we have
  // a real reply — and log so we can tune `maxTurns` from real data.
  logger.warn('agent-loop: hit max tool turns', {
    requestId: input.ctx.requestId,
    userId: input.ctx.userId,
    toolCalls: toolCalls.map((t) => ({ name: t.name, ok: t.ok })),
  });
  return {
    reply: {
      message:
        "Lemme try that a different way — could you say what you're after in one line?",
    },
    toolCalls,
    truncated: true,
  };
}
