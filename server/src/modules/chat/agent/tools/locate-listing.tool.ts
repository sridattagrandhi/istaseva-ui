import { z } from 'zod';
import { listingsService } from '../../../listings/services/listings.service.js';
import type { ToolDefinition } from '../types.js';

/**
 * `locate_listing` — point the user at a specific listing ON THE PAGE they're
 * already browsing: scroll its card into view and flash it, without leaving
 * the grid. The sibling of `open_listing` (which navigates to the detail
 * page). Use this for "where is X on the list?" / "show me X" / "point out
 * the Innova one" while the user is on /explore, /services, or /transport.
 *
 * Same DB-validation pattern as open_listing so the model can't act on a
 * hallucinated id. user-assistant.service.ts promotes a successful call into
 * a `highlight_listing` action; the web client scrolls+flashes the card if
 * it's on screen, and falls back to opening the detail page when it isn't
 * (e.g. the listing is on a different category page or past the loaded grid).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ArgsSchema = z.object({
  listingId: z
    .string()
    .min(1)
    .describe('Real UUID from a previous search_listings / get_saved_listings hit. Never invent one.'),
  listingType: z
    .enum(['stay', 'service', 'transport'])
    .optional()
    .describe('Resolved from the listing row when omitted; pass it through when you have it.'),
});
type Args = z.infer<typeof ArgsSchema>;

export interface LocateListingResult {
  success: boolean;
  listingId: string;
  listingType: 'stay' | 'service' | 'transport';
  listingName: string;
  userMessage?: string;
  reason?: 'listing_not_found' | 'invalid_id';
}

function inferListingType(row: Record<string, unknown>): 'stay' | 'service' | 'transport' {
  const typed = typeof row.listing_type === 'string' ? row.listing_type.toLowerCase() : '';
  if (typed === 'stay' || typed === 'service' || typed === 'transport') return typed as never;
  if (row.price_per_night || row.property_type) return 'stay';
  if (row.vehicle_name) return 'transport';
  const cat = String(row.category || '').toLowerCase();
  if (/^(hotel|homestay|lodge|stay|farm|heritage|sathram|village-stay)$/.test(cat) || cat.startsWith('stay:')) return 'stay';
  if (/^(auto|cab|van|bike|tempo|transport|driver-)/.test(cat)) return 'transport';
  return 'service';
}

export const locateListingTool: ToolDefinition<Args, LocateListingResult> = {
  name: 'locate_listing',
  description:
    "Point the user at a specific listing ON THE PAGE they're browsing — scroll its card into view and highlight it, without leaving the grid. Use for 'where is X?' / 'show me X on the list' / 'point out the Innova one' while on /explore, /services, or /transport. Pass a real UUID from a previous search_listings/get_saved_listings hit. The UI flashes the card if it's on screen and otherwise opens its detail page. Use open_listing instead when the user explicitly wants the full detail PAGE ('open it', 'take me there'). Read-only.",
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      listingId: { type: 'string', description: 'Real UUID from a prior hit. Never invent one.' },
      listingType: { type: 'string', enum: ['stay', 'service', 'transport'] },
    },
    required: ['listingId'],
  },

  async execute(args): Promise<LocateListingResult> {
    const id = String(args.listingId || '').trim();
    if (!UUID_RE.test(id)) {
      return {
        success: false,
        reason: 'invalid_id',
        listingId: id,
        listingType: args.listingType ?? 'stay',
        listingName: '',
        userMessage: "I don't have a real id for that listing handy — let me search again. (Never invent listing ids.)",
      };
    }
    let row: Record<string, unknown> | null = null;
    try {
      const result = await listingsService.getById(id);
      row = (result as { data?: Record<string, unknown> | null }).data ?? null;
    } catch {
      row = null;
    }
    if (!row) {
      return {
        success: false,
        reason: 'listing_not_found',
        listingId: id,
        listingType: args.listingType ?? 'stay',
        listingName: '',
        userMessage: "I can't find that listing anymore — want me to search again?",
      };
    }
    return {
      success: true,
      listingId: id,
      listingType: args.listingType ?? inferListingType(row),
      listingName: String(row.title || row.name || 'Listing'),
    };
  },

  summarize(_args, result) {
    return result.success ? `Located ${result.listingName}` : `Couldn't locate — ${result.reason ?? 'unknown'}`;
  },
};
