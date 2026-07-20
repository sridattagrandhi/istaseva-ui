import { z } from 'zod';
import { bookingsService } from '../../../bookings/services/bookings.service.js';
import { NotFoundError, ValidationError, ForbiddenError } from '../../../../common/errors/app-error.js';
import { logger } from '../../../../common/logging/logger.js';
import type { ToolDefinition } from '../types.js';

/**
 * Cancel an existing booking from chat.
 *
 *   - operation='cancel' → cancels the booking (refund handled automatically
 *     if a payment was captured). The legacy cancel_booking_preview + confirm
 *     card path also exists; this is the quick-fire path when the user has
 *     already confirmed in chat.
 *
 * Returns a `{success, ...}` envelope so the model can read off a userMessage
 * on failure rather than paraphrasing a backend error.
 */
const ArgsSchema = z.object({
  operation: z.literal('cancel'),
  bookingId: z.string().min(1),
});
type Args = z.infer<typeof ArgsSchema>;

type FailureReason =
  | 'auth_required'
  | 'not_found'
  | 'forbidden'
  | 'invalid_state'      // already cancelled / completed / past
  | 'unknown';

type ModifyResult =
  | { success: true; operation: 'cancel'; bookingId: string; scheduledDate?: string; status?: string }
  | { success: false; reason: FailureReason; userMessage: string };

function classify(err: unknown): { reason: FailureReason; userMessage: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (err instanceof NotFoundError) {
    return { reason: 'not_found', userMessage: "I can't find that booking — it may already be gone." };
  }
  if (err instanceof ForbiddenError) {
    return { reason: 'forbidden', userMessage: raw };
  }
  if (err instanceof ValidationError) {
    if (lower.includes('state') || lower.includes("can't be")) {
      return { reason: 'invalid_state', userMessage: "That booking can't be changed at this point — it's past the modify window." };
    }
    return { reason: 'invalid_state', userMessage: raw };
  }
  return {
    reason: 'unknown',
    userMessage: "Something on our end stopped the change from going through. Try again in a moment, or message support and they'll sort it.",
  };
}

export const modifyBookingTool: ToolDefinition<Args, ModifyResult> = {
  name: 'modify_booking',
  description:
    "Cancel an existing booking. operation='cancel' cancels the booking (refund handled automatically if a payment was captured). ONLY call after the user has explicitly confirmed the cancellation in chat (\"yes cancel it\"). Returns {success:true, ...} on success — your final reply MUST briefly confirm what changed. On {success:false, reason, userMessage}, quote userMessage verbatim and (when reason='auth_required') emit action 'auth_required'.",
  sideEffect: 'write',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['cancel'] },
      bookingId: { type: 'string' },
    },
    required: ['operation', 'bookingId'],
  },

  async execute(args, ctx): Promise<ModifyResult> {
    if (!ctx.userId) {
      return { success: false, reason: 'auth_required', userMessage: 'You need to sign in before I can change that. Want me to take you to sign-in?' };
    }

    try {
      const result = await bookingsService.updateStatus(args.bookingId, 'cancelled' as any, ctx.userId, 'guest');
      return {
        success: true,
        operation: 'cancel',
        bookingId: args.bookingId,
        status: 'cancelled',
        scheduledDate: (result as any)?.data?.scheduled_date ?? undefined,
      };
    } catch (err) {
      const classified = classify(err);
      logger.warn('modify_booking: classified failure', {
        userId: ctx.userId,
        bookingId: args.bookingId,
        operation: args.operation,
        reason: classified.reason,
        rawError: err instanceof Error ? err.message : String(err),
      });
      return { success: false, ...classified };
    }
  },

  summarize(_args, result) {
    if (result.success) {
      return 'Booking cancelled';
    }
    return `Couldn't cancel — ${result.reason}`;
  },
};
