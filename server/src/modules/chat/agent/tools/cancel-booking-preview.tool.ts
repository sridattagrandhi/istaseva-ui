import { z } from 'zod';
import { bookingsService } from '../../../bookings/services/bookings.service.js';
import { NotFoundError, ForbiddenError } from '../../../../common/errors/app-error.js';
import type { ToolDefinition } from '../types.js';

/**
 * READ-ONLY preview of what a cancellation would do. Agent calls this to
 * inform the user before they confirm; the actual cancel is fired by the
 * frontend via the existing PATCH /api/bookings/:id/status endpoint after
 * the user taps "Yes, cancel" on a confirmation card.
 *
 * Phase 2 design — confirmation gate:
 *   1. User: "cancel my Coorg booking"
 *   2. Agent → cancel_booking_preview → returns booking summary + refund est
 *   3. Agent → final reply with action `confirm_cancel_booking` and the
 *      bookingId in params; UI renders a Confirm card.
 *   4. User taps Confirm → frontend calls PATCH /api/bookings/:id/status
 *      with status=cancelled → existing refund/release logic runs.
 *
 * The preview tool deliberately does NO state mutation — it can be called
 * speculatively (e.g. user said "what would happen if I cancelled X?")
 * without locking anything in.
 */
const ArgsSchema = z.object({
  bookingId: z
    .string()
    .min(1)
    .describe("The booking's UUID. Must come from get_user_bookings — never invent."),
});
type Args = z.infer<typeof ArgsSchema>;

interface PreviewResult {
  bookingId: string;
  status: string;
  listing?: string;
  scheduledDate?: string;
  amount?: string;
  /** Plain-English description of what cancelling does, derived from the
   *  same compute function the cancel endpoint runs. */
  cancellationSummary: string;
  /** True iff the user is permitted to cancel this booking from their role
   *  (guest can cancel pending/confirmed). False means the agent should
   *  redirect the user to support / the host. */
  cancellable: boolean;
  /** Refund details the agent can quote back. */
  refundPaise?: number;
  platformKeepsPaise?: number;
  policy?: 'flexible' | 'moderate' | 'strict';
  insuranceVoided?: boolean;
  reason?: string;
}

export const cancelBookingPreviewTool: ToolDefinition<Args, PreviewResult> = {
  name: 'cancel_booking_preview',
  description:
    "PREVIEW (no side effects) what cancelling a booking would do — refund estimate, current status, dates. Call this when the user asks to cancel a booking; surface the details in your reply, and emit action 'confirm_cancel_booking' so the UI shows a confirmation card. NEVER cancel without the user explicitly confirming.",
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      bookingId: { type: 'string' },
    },
    required: ['bookingId'],
  },

  async execute(args, ctx) {
    let preview: Awaited<ReturnType<typeof bookingsService.previewCancellation>> | undefined;
    let booking: Record<string, unknown> | undefined;
    try {
      const [bookingResult, previewResult] = await Promise.all([
        bookingsService.getById(args.bookingId, ctx.userId),
        bookingsService.previewCancellation(args.bookingId, ctx.userId),
      ]);
      booking = bookingResult.data as Record<string, unknown>;
      preview = previewResult;
    } catch (err) {
      if (err instanceof NotFoundError) {
        return {
          bookingId: args.bookingId,
          status: 'unknown',
          cancellationSummary: "Couldn't find that booking under your account.",
          cancellable: false,
          reason: 'not_found',
        };
      }
      if (err instanceof ForbiddenError) {
        return {
          bookingId: args.bookingId,
          status: 'unknown',
          cancellationSummary: "That booking isn't on your account.",
          cancellable: false,
          reason: 'forbidden',
        };
      }
      throw err;
    }

    const status = String(booking?.status ?? 'unknown');

    // Build the human-readable summary from the real refund computation —
    // the agent quotes this back to the user, so the numbers must match
    // what the cancel endpoint will actually do.
    let summary: string;
    if (!preview.cancellable) {
      summary = `This booking is ${status}; cancellation isn't available from chat.`;
    } else if (preview.refundPaise === 0 && preview.chargedPaise == null) {
      summary = "It's still pending payment — cancelling releases the slot, no money moved.";
    } else {
      const refund = `₹${(preview.refundPaise / 100).toLocaleString('en-IN')}`;
      const retained = preview.platformKeepsPaise > 0
        ? ` ₹${(preview.platformKeepsPaise / 100).toLocaleString('en-IN')} retained per the ${preview.policy} policy.`
        : '';
      const insurance = preview.insuranceVoided ? ' Insurance coverage will be voided.' : '';
      summary = `Cancelling refunds ${refund}.${retained}${insurance}`;
    }

    return {
      bookingId: String(booking?.id ?? args.bookingId),
      status,
      listing: typeof booking?.listing_title === 'string'
        ? booking.listing_title
        : (typeof booking?.listing_name === 'string' ? booking.listing_name : undefined),
      scheduledDate: ((): string | undefined => {
        const v = booking?.start_date ?? booking?.scheduled_date ?? booking?.scheduled_at;
        if (typeof v === 'string') return v.slice(0, 10);
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        return undefined;
      })(),
      amount: preview.chargedPaise != null
        ? `₹${(preview.chargedPaise / 100).toFixed(0)}`
        : undefined,
      refundPaise: preview.refundPaise,
      platformKeepsPaise: preview.platformKeepsPaise,
      policy: preview.policy,
      insuranceVoided: preview.insuranceVoided,
      cancellationSummary: summary,
      cancellable: preview.cancellable,
    };
  },

  summarize(_args, result) {
    if (!result.cancellable) return `Cannot cancel ${result.bookingId} (${result.reason ?? result.status})`;
    return `Cancellation preview ready for ${result.listing ?? result.bookingId}`;
  },
};
