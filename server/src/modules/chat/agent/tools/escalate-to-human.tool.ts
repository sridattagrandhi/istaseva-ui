import { z } from 'zod';
import { logger } from '../../../../common/logging/logger.js';
import { redis } from '../../../../common/cache/redis.js';
import { config } from '../../../../common/config/index.js';
import { messagesService } from '../../services/messages.service.js';
import type { ToolDefinition } from '../types.js';

/**
 * Per-user rate limit so a confused / runaway model can't open a flood of
 * support tickets. 5 escalations per user per 10 minutes is generous —
 * a real user spam-clicks "talk to a person" maybe twice before giving
 * up; we want headroom for legitimate retries (e.g. they escalated, the
 * /messages page didn't load, they tried again).
 *
 * Falls open on Redis errors so an outage doesn't block users from
 * actually reaching support — the worst case there is a few extra
 * tickets, not a missed urgent issue.
 */
const ESCALATION_WINDOW_SECONDS = 600;
const ESCALATION_MAX_PER_WINDOW = 5;
async function isRateLimited(userId: string): Promise<boolean> {
  try {
    const key = `assistant:escalate:${userId}`;
    const count = await redis.incr(key);
    if (count === 1) {
      // First request in the window — set the expiry. Doing it after
      // INCR avoids a race where two parallel calls both INCR but neither
      // sets TTL because both saw count > 1.
      await redis.expire(key, ESCALATION_WINDOW_SECONDS);
    }
    return count > ESCALATION_MAX_PER_WINDOW;
  } catch (err) {
    logger.warn('escalate-to-human: rate-limit check failed, falling open', {
      userId,
      error: (err as Error).message,
    });
    return false;
  }
}

/**
 * Hand-off signal to a human support agent. When a staffed support
 * account is configured (ASSISTANT_SUPPORT_USER_ID), this opens a real
 * /messages thread with support on the user's behalf; otherwise it
 * degrades to the original telemetry-only stub + navigation hint.
 *
 * Trigger conditions baked into the prompt:
 *   - User explicitly asks for a human ("agent please", "talk to a person")
 *   - Agent failed the same task twice in this conversation
 *   - Sentiment turns hostile (multiple consecutive frustrated messages)
 *
 * Returns a target route the agent should hint the UI toward via the
 * `navigate` action — we don't have a /support page today, so /messages
 * is the closest landing.
 */
const ArgsSchema = z.object({
  reason: z
    .enum(['user_requested', 'repeated_failure', 'hostile_sentiment', 'safety_concern', 'other'])
    .describe('Why the agent is escalating. Used for telemetry — be honest, this is not user-facing.'),
  summary: z
    .string()
    .max(500)
    .optional()
    .describe('One-sentence summary of what the user actually needs. Helps support pick up faster.'),
});
type Args = z.infer<typeof ArgsSchema>;

interface EscalationResult {
  acknowledged: true;
  /** Where to send the user. Always /messages until support backend lands. */
  navigateTo: '/messages';
  /** Phase 6 will populate a real ticket id; for now this is a correlation
   *  id usable for cross-referencing logs. */
  ticketId: string;
}

export const escalateToHumanTool: ToolDefinition<Args, EscalationResult> = {
  name: 'escalate_to_human',
  description:
    "Hand off to a human support agent. Call when the user EXPLICITLY asks for a person, or when you've failed the same task twice, or when sentiment turns hostile. Returns a navigation hint — emit a 'navigate' action to the returned navigateTo path in your reply.",
  sideEffect: 'write',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        enum: ['user_requested', 'repeated_failure', 'hostile_sentiment', 'safety_concern', 'other'],
      },
      summary: { type: 'string' },
    },
    required: ['reason'],
  },

  async execute(args, ctx) {
    // Rate-limit first — even if the model loops on escalation in a single
    // session, we don't want to spam the future support inbox.
    if (await isRateLimited(ctx.userId)) {
      logger.warn('assistant: escalation rate-limited', {
        userId: ctx.userId,
        reason: args.reason,
      });
      throw new Error(
        'You\'ve been escalated to support recently — give the team a few minutes to respond before opening another thread.',
      );
    }

    logger.info('assistant: escalation', {
      requestId: ctx.requestId,
      userId: ctx.userId,
      reason: args.reason,
      summary: args.summary,
    });

    // Phase 6: when a staffed support account is configured
    // (ASSISTANT_SUPPORT_USER_ID), open a REAL /messages thread by sending
    // a DM from the user to support through the normal chat machinery —
    // support sees it in their inbox, the user sees the thread on
    // /messages, and the reply lands as a normal chat message. Without the
    // config this stays the telemetry-only stub (no silent fake tickets).
    const supportUserId = config.llm.assistantSupportUserId;
    if (supportUserId && supportUserId !== ctx.userId) {
      try {
        await messagesService.sendMessage(ctx.userId, {
          receiver_id: supportUserId,
          content:
            `[Assistant escalation — ${args.reason}] `
            + (args.summary || 'The user asked to speak with a person.')
            + ' (Sent on the user\'s behalf by the IstaSeva assistant; please reply in this thread.)',
          metadata: { source: 'assistant_escalation', reason: args.reason, requestId: ctx.requestId },
        });
        return { acknowledged: true, navigateTo: '/messages', ticketId: ctx.requestId };
      } catch (err) {
        // Don't fail the escalation on a messaging hiccup — the user still
        // gets pointed at /messages and ops sees the error.
        logger.error('assistant: escalation DM failed', {
          userId: ctx.userId,
          supportUserId,
          error: (err as Error).message,
        });
      }
    }

    return {
      acknowledged: true,
      navigateTo: '/messages',
      ticketId: ctx.requestId,
    };
  },

  summarize(args, _result) {
    return `Escalated to support (${args.reason})`;
  },
};
