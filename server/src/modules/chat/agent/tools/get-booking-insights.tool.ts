import { z } from 'zod';
import { bookingsService } from '../../../bookings/services/bookings.service.js';
import type { ToolDefinition } from '../types.js';

/**
 * Aggregate "dashboard insight" view of the signed-in user's bookings:
 * total spent, counts by bucket, and the next upcoming trip. Lets the
 * agent answer "how much have I spent?" / "when's my next trip?" / "give me
 * a summary of my bookings" with real numbers instead of either guessing or
 * dumping the raw list and making the user add it up.
 *
 * Reuses bookingsService.listForUser — whose rows already carry the
 * completed-payment breakdown via a LATERAL join — so spend reflects what
 * was actually charged (base + fees + GST + insurance − discount), not the
 * pre-fee agreed price. Always scoped to ctx.userId; never takes a userId
 * from args.
 */
const ArgsSchema = z.object({});
type Args = z.infer<typeof ArgsSchema>;

interface TripRef {
  id: string;
  listing?: string;
  provider?: string;
  date?: string;
  status: string;
}

interface InsightsResult {
  totalSpent: string;
  totalSpentPaise: number;
  counts: { upcoming: number; past: number; cancelled: number; total: number };
  nextTrip?: TripRef;
  /** True when there are no bookings at all — lets the agent say so plainly. */
  empty: boolean;
}

/** Normalise a date-ish DB value to a YYYY-MM-DD string, or undefined. */
function isoDate(v: unknown): string | undefined {
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return undefined;
}

export const getBookingInsightsTool: ToolDefinition<Args, InsightsResult> = {
  name: 'get_booking_insights',
  description:
    "Summary stats about the signed-in user's bookings: total amount spent, counts (upcoming / past / cancelled), and their next upcoming trip. Call this for questions like 'how much have I spent?', 'when's my next trip?', 'give me a summary of my bookings', 'how many trips do I have coming up?'. For a full LIST of bookings use get_user_bookings instead — this returns aggregates, not every row.",
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: { type: 'object', properties: {} },

  async execute(_args, ctx) {
    // Pull a wide window; aggregates need the full picture, not a page.
    const result = await bookingsService.listForUser({
      userId: ctx.userId,
      status: undefined,
      page: 1,
      limit: 200,
    });

    const rows = (result.data ?? []) as Record<string, unknown>[];
    const todayIso = new Date().toISOString().slice(0, 10);

    let upcoming = 0;
    let past = 0;
    let cancelled = 0;
    let totalSpentPaise = 0;
    let nextTrip: TripRef | undefined;
    let nextTripDate: string | undefined;

    for (const b of rows) {
      const status = String(b.status ?? '');
      // Pre-payment holds aren't real bookings from the user's view — match
      // the get_user_bookings + dashboard filter so the numbers agree.
      if (status === 'pending' || status === 'expired') continue;

      const date = isoDate(b.start_date ?? b.scheduled_date ?? b.scheduled_at);
      const isCancelled = status === 'cancelled' || status === 'refunded';
      const isFuture = date ? date >= todayIso : false;

      if (isCancelled) {
        cancelled += 1;
      } else if (isFuture) {
        upcoming += 1;
      } else {
        past += 1;
      }

      // Spend = what was actually charged (completed payment). Cancelled
      // bookings may have been refunded, so we only count non-cancelled.
      if (!isCancelled && typeof b.payment_amount_paise === 'number') {
        totalSpentPaise += b.payment_amount_paise;
      }

      // Track the EARLIEST future non-cancelled trip as "next".
      if (!isCancelled && isFuture && date && (!nextTripDate || date < nextTripDate)) {
        nextTripDate = date;
        nextTrip = {
          id: String(b.id),
          listing: typeof b.listing_title === 'string'
            ? b.listing_title
            : (typeof b.listing_name === 'string' ? b.listing_name : undefined),
          provider: typeof b.provider_name === 'string' ? b.provider_name : undefined,
          date,
          status,
        };
      }
    }

    return {
      totalSpent: `₹${(totalSpentPaise / 100).toLocaleString('en-IN')}`,
      totalSpentPaise,
      counts: { upcoming, past, cancelled, total: upcoming + past + cancelled },
      nextTrip,
      empty: upcoming + past + cancelled === 0,
    };
  },

  summarize(_args, result) {
    if (result.empty) return 'No bookings yet';
    const parts = [`${result.counts.total} booking${result.counts.total === 1 ? '' : 's'}`];
    if (result.totalSpentPaise > 0) parts.push(`${result.totalSpent} spent`);
    if (result.nextTrip?.date) parts.push(`next ${result.nextTrip.date}`);
    return parts.join(' · ');
  },
};
