import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors/app-error.js';
import { logger } from '../../../common/logging/logger.js';
import { config } from '../../../common/config/index.js';
import { onboardingChatService } from '../services/onboarding-chat.service.js';
import { onboardingAgentService } from '../services/onboarding-agent.service.js';
import { enhanceListingDescription } from '../services/description-enhance.service.js';

const chatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  })),
  profile: z.record(z.any()).default({}),
  displayLang: z.string().default('en'),
  /** Which portal the user walked in through. Lets the agent frame the
   *  conversation around what they likely want, and gracefully redirect
   *  if their description is genuinely out of scope. */
  entryType: z.enum(['host', 'service', 'transport', 'any']).default('any'),
  /** Stable per-conversation id minted by the client. Used to thread
   *  observability events across turns of the same chat. Optional —
   *  if absent, the agent falls back to its per-request requestId
   *  (groups one turn together but loses cross-turn linkage). */
  sessionId: z.string().min(1).max(120).optional(),
});

const enhanceDescriptionSchema = z.object({
  description: z.string().max(2000).optional().default(''),
  profile: z.record(z.any()).default({}),
});

export class OnboardingChatController {
  async chat(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = chatSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      // Diagnostic: log the incoming request shape so we can tell whether
      // (a) the agent path or the legacy path served this turn, and
      // (b) the client actually sent a profile with prior-turn fields.
      const lastMsg = parsed.data.messages[parsed.data.messages.length - 1];
      logger.info('onboarding-chat: incoming', {
        userId: req.user?.id,
        agentEnabled: config.llm.onboardingAgentEnabled,
        path: config.llm.onboardingAgentEnabled && req.user ? 'agent' : 'legacy',
        msgCount: parsed.data.messages.length,
        lastMsgRole: lastMsg?.role,
        lastMsgPreview: lastMsg?.content?.slice(0, 200),
        profileKeys: Object.keys(parsed.data.profile ?? {}),
        entryType: parsed.data.entryType,
      });

      // Phase 2b: when ONBOARDING_AGENT=1, route through the tool-calling
      // agent service. Same response shape so the client doesn't need to
      // know which path served it. Per-environment opt-in keeps the
      // rollout reversible.
      if (config.llm.onboardingAgentEnabled && req.user) {
        try {
          const response = await onboardingAgentService.respond({
            ...parsed.data,
            user: { id: req.user.id, name: req.user.name, role: req.user.role },
            entryType: parsed.data.entryType,
          });
          res.json(response);
          return;
        } catch (err) {
          // Fall through to legacy on any agent failure — onboarding is a
          // user's first impression, we don't want them stuck on a broken
          // agent. The same error would have failed the legacy path anyway
          // since both share the LLM provider, but logging the agent fault
          // separately makes it tunable.
          logger.warn('onboarding-agent failed, falling back to legacy', {
            error: (err as Error).message,
          });
        }
      }

      const response = await onboardingChatService.respond(parsed.data);
      res.json(response);
      return;
    } catch (err) {
      logger.error('Onboarding chat error', { error: (err as Error).message });
      next(err);
    }
  }

  /**
   * Opt-in description polish for the manual onboarding forms. Returns
   * `{ description }` — the enhanced text, or the original draft unchanged
   * when the model is unavailable (dev mock / transient error), so the
   * client can always safely drop the result back into the field.
   */
  async enhanceDescription(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = enhanceDescriptionSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      const description = await enhanceListingDescription(parsed.data);
      res.json({ description });
    } catch (err) {
      next(err);
    }
  }
}

export const onboardingChatController = new OnboardingChatController();
