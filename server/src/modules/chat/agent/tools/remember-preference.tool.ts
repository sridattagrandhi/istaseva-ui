import { z } from 'zod';
import { logger } from '../../../../common/logging/logger.js';
import { config } from '../../../../common/config/index.js';
import { userAssistantMemoryService } from '../../services/user-assistant-memory.service.js';
import type { ToolDefinition } from '../types.js';

/**
 * Persistent memory write. STUB for Phase 2 — logs the intent and acks.
 * Phase 4 wires this to a real `user_assistant_memory` Postgres table
 * with optimistic locking, 4KB cap, and the conversation-memory shape
 * defined in AI_AGENT_PLAN.md §4.2.
 *
 * Stubbing it now lets the agent prompt mention the tool and the model
 * learn when to call it (after the user states a preference) without
 * waiting for the storage layer. When Phase 4 lands, only the body of
 * `execute` changes — no prompt or registry edits needed.
 */
const ArgsSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .describe('Short snake_case key — e.g. "budget_max", "preferred_locations", "diet".'),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    .describe('The preference value. Strings, numbers, booleans, or string arrays for lists.'),
  scope: z
    .enum(['session', 'persistent'])
    .default('persistent')
    .describe('"persistent" (default) survives across sessions; "session" only this conversation.'),
});
type Args = z.infer<typeof ArgsSchema>;

interface AckResult {
  remembered: true;
  /** Echoed for telemetry; not surfaced to the user. */
  key: string;
}

export const rememberPreferenceTool: ToolDefinition<Args, AckResult> = {
  name: 'remember_preference',
  description:
    "Save a user preference for later turns / future sessions. Call when the user states a clear preference (\"I'm vegetarian\", \"budget around 5k\", \"prefer North Goa\"). DO NOT acknowledge the save in your reply — it should feel invisible. Examples: remember_preference({key: 'diet', value: 'vegetarian'}), remember_preference({key: 'budget_max', value: 5000}).",
  sideEffect: 'write',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      value: {
        // JSON Schema doesn't have a clean union; declare the unioned types
        // and trust zod to do the actual validation. Gemini accepts this.
        oneOf: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
          { type: 'array', items: { type: 'string' } },
        ],
      },
      scope: { type: 'string', enum: ['session', 'persistent'] },
    },
    required: ['key', 'value'],
  },

  async execute(args, ctx) {
    // Phase 4: real persistence. Session-scoped writes never hit the
    // DB — they live only in this turn's context. The agent rarely
    // calls scope='session' (it's mostly a hint that "this preference
    // is fleeting, e.g. 'just for tonight'") but we honour it.
    if (args.scope === 'session') {
      logger.debug('assistant: remember_preference session-only', {
        requestId: ctx.requestId,
        userId: ctx.userId,
        key: args.key,
      });
      return { remembered: true, key: args.key };
    }

    if (!config.llm.assistantMemoryEnabled) {
      // Memory feature off — degrade to the Phase 2 stub behaviour so
      // the tool stays callable. The model treats it as a no-op ack.
      logger.debug('assistant: remember_preference (memory disabled)', {
        requestId: ctx.requestId,
        userId: ctx.userId,
        key: args.key,
      });
      return { remembered: true, key: args.key };
    }

    try {
      await userAssistantMemoryService.patch(ctx.userId, {
        preferences: { [args.key]: args.value },
      });
      // Don't log the value at info level — preferences can be
      // sensitive ("dietary needs", "always solo travel").
      logger.info('assistant: remember_preference saved', {
        requestId: ctx.requestId,
        userId: ctx.userId,
        key: args.key,
      });
      return { remembered: true, key: args.key };
    } catch (err) {
      // Memory write failure shouldn't fail the user's turn — log and
      // ack. Worst case the agent re-asks next time; better than
      // surfacing a tool error the model has to recover from.
      logger.warn('assistant: remember_preference write failed', {
        requestId: ctx.requestId,
        userId: ctx.userId,
        key: args.key,
        error: (err as Error).message,
      });
      return { remembered: true, key: args.key };
    }
  },

  summarize(args, _result) {
    return `Saved ${args.key} (${args.scope})`;
  },
};
