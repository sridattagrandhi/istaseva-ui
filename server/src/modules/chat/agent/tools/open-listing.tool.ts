import { z } from 'zod';
import { listingsService } from '../../../listings/services/listings.service.js';
import type { ToolDefinition } from '../types.js';

/**
 * `open_listing` — navigate the user to a listing's detail page.
 *
 * This used to be only an `action.type` in the final-reply JSON, but the
 * model kept treating it as a tool name (and so the agent loop returned
 * `ok: false` for an "unknown tool", and the navigation never fired even
 * though the verbal reply said "opening it now"). Easier to make the
 * model's natural behaviour correct than to fight the prompt: we register
 * it as a real read-only tool that validates the listing in the DB and
 * returns the data the UI needs to navigate. The post-loop hook in
 * `user-assistant.service.ts` then promotes a successful call into the
 * final response's `action`, guaranteeing the navigation happens.
 *
 * Validating against the DB also fixes a related bug: when the model
 * couldn't recall a listing id from earlier in the conversation it would
 * invent a UUID and call `get_listing_details` with the garbage. Now the
 * agent has a single tool that says "open the page for this listing" —
 * if the id doesn't exist, the tool's userMessage tells the model to
 * re-run `search_listings` instead of guessing.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ArgsSchema = z.object({
  listingId: z
    .string()
    .min(1)
    .describe('Real UUID from a previous search_listings hit. Never invent one.'),
  listingType: z
    .enum(['stay', 'service', 'transport'])
    .optional()
    .describe('Resolved from the listing row when omitted, but pass it through when you have it.'),
});
type Args = z.infer<typeof ArgsSchema>;

export interface OpenListingResult {
  success: boolean;
  listingId: string;
  listingType: 'stay' | 'service' | 'transport';
  listingName: string;
  /** Pre-built relative path the UI can navigate to verbatim. */
  navigateTo: string;
  /** Why it failed, when success=false. Always user-safe wording. */
  userMessage?: string;
  reason?: 'listing_not_found' | 'listing_inactive' | 'invalid_id';
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

export const openListingTool: ToolDefinition<Args, OpenListingResult> = {
  name: 'open_listing',
  description:
    "Navigate the user to a listing's detail page so they can finish the booking themselves. Call this when the user picked self-book at the booking gate ('I'll do it', 'listing page', 'let me finish'), OR when they explicitly say 'open it' / 'show me the page' / 'take me there'. ALWAYS pass a real UUID from a previous search_listings hit — if you don't have one, call search_listings first. The tool validates the id against the DB and returns {success, listingId, listingType, navigateTo} which the UI uses to navigate; on failure the userMessage tells you to re-search. Side-effect: read-only — no money, no hold, just navigation.",
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      listingId: { type: 'string', description: 'Real UUID from search_listings. Never invent one.' },
      listingType: { type: 'string', enum: ['stay', 'service', 'transport'] },
    },
    required: ['listingId'],
  },

  async execute(args): Promise<OpenListingResult> {
    const id = String(args.listingId || '').trim();
    if (!UUID_RE.test(id)) {
      return {
        success: false,
        reason: 'invalid_id',
        listingId: id,
        listingType: args.listingType ?? 'stay',
        listingName: '',
        navigateTo: '',
        userMessage:
          "I don't have a real id for that listing handy — let me search again. (Never invent listing ids.)",
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
        navigateTo: '',
        userMessage:
          "I can't find that listing anymore — it might have been removed. Want me to search again?",
      };
    }
    if (row.is_active === false) {
      return {
        success: false,
        reason: 'listing_inactive',
        listingId: id,
        listingType: args.listingType ?? inferListingType(row),
        listingName: String(row.title || row.name || 'Listing'),
        navigateTo: '',
        userMessage:
          "That listing isn't accepting bookings right now. Want me to find similar options?",
      };
    }
    const listingType = args.listingType ?? inferListingType(row);
    const base = listingType === 'service' ? '/service'
      : listingType === 'transport' ? '/transport'
      : '/stay';
    return {
      success: true,
      listingId: id,
      listingType,
      listingName: String(row.title || row.name || 'Listing'),
      navigateTo: `${base}/${id}`,
    };
  },

  summarize(_args, result) {
    if (result.success) return `Opened ${result.listingName}`;
    return `Couldn't open — ${result.reason ?? 'unknown'}`;
  },
};
