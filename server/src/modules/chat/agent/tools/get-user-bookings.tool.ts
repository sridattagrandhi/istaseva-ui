import { z } from 'zod';
import { bookingsService } from '../../../bookings/services/bookings.service.js';
import type { ToolDefinition } from '../types.js';

/**
 * Pull the signed-in user's bookings so the agent can answer "what did I
 * book?" / "where am I staying next?" with real names and dates instead
 * of a generic "you have a few coming up".
 *
 * Always scoped to ctx.userId — never accepts a userId from args.
 */
const ArgsSchema = z.object({
  status: z
    .enum(['upcoming', 'past', 'all'])
    .default('upcoming')
    .describe('Filter to upcoming (confirmed/pending future), past (completed/cancelled), or all bookings.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe('Max bookings to return. Default 10.'),
});
type Args = z.infer<typeof ArgsSchema>;

interface BookingSummary {
  id: string;
  status: string;
  listing?: string;
  provider?: string;
  start?: string;
  amount?: string;
}

export const getUserBookingsTool: ToolDefinition<Args, { bookings: BookingSummary[]; total: number }> = {
  name: 'get_user_bookings',
  description:
    "Get the signed-in user's bookings. Call when the user asks about their bookings, trips, or upcoming stays/services. Returns ids + listing names + dates + status — reference these specifically, never say 'you have a few bookings'.",
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['upcoming', 'past', 'all'] },
      limit: { type: 'number' },
    },
  },

  async execute(args, ctx) {
    // bookingsService.listForUser doesn't have a built-in upcoming/past
    // split — it filters by raw `status`. We pull a wider set and slice
    // client-side to map the agent's intent. This keeps the tool's
    // contract simple ("upcoming"/"past") without forcing the agent to
    // know our internal status enum.
    const result = await bookingsService.listForUser({
      userId: ctx.userId,
      status: undefined,
      page: 1,
      limit: Math.max(args.limit, 20),
    });

    const todayIso = new Date().toISOString().slice(0, 10);

    const filtered = (result.data ?? []).filter((b: Record<string, unknown>) => {
      const startRaw = (b.start_date ?? b.scheduled_date ?? b.scheduled_at) as string | Date | undefined;
      const start = typeof startRaw === 'string'
        ? startRaw.slice(0, 10)
        : (startRaw instanceof Date ? startRaw.toISOString().slice(0, 10) : null);
      const status = String(b.status ?? '');
      const isFuture = start ? start >= todayIso : false;
      const isCancelled = status === 'cancelled' || status === 'refunded';
      // Hide unpaid holds and lapsed holds from "my bookings" responses —
      // these are pre-payment intents (Razorpay order created but Confirm
      // & Pay not tapped) and from the user's perspective aren't bookings
      // until payment lands. Matches the GuestDashboard filter so chat
      // and the dashboard agree on what counts as a booking.
      if (status === 'pending' || status === 'expired') return false;

      if (args.status === 'upcoming') return isFuture && !isCancelled;
      if (args.status === 'past') return !isFuture || isCancelled;
      return true;
    });

    const bookings: BookingSummary[] = filtered.slice(0, args.limit).map((b: Record<string, unknown>) => ({
      id: String(b.id),
      status: String(b.status ?? 'unknown'),
      listing: typeof b.listing_title === 'string'
        ? b.listing_title
        : (typeof b.listing_name === 'string' ? b.listing_name : undefined),
      provider: typeof b.provider_name === 'string' ? b.provider_name : undefined,
      start: ((): string | undefined => {
        const v = b.start_date ?? b.scheduled_date ?? b.scheduled_at;
        if (typeof v === 'string') return v.slice(0, 10);
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        return undefined;
      })(),
      amount: typeof b.total_amount_paise === 'number'
        ? `₹${(b.total_amount_paise / 100).toFixed(0)}`
        : undefined,
    }));

    return { bookings, total: bookings.length };
  },

  summarize(args, result) {
    return result.total > 0
      ? `Found ${result.total} ${args.status} booking${result.total === 1 ? '' : 's'}`
      : `No ${args.status} bookings`;
  },
};
