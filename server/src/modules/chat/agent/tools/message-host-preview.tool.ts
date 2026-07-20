import { z } from 'zod';
import { listingsService } from '../../../listings/services/listings.service.js';
import { NotFoundError } from '../../../../common/errors/app-error.js';
import type { ToolDefinition } from '../types.js';

/**
 * READ-ONLY preview of a host message. Agent calls this when the user
 * wants to message a listing's host. Returns enough context for the agent
 * to surface a draft, but does NOT actually send anything — the frontend
 * sends via the existing POST /api/chat/messages endpoint after the user
 * confirms via a UI card (action `confirm_message_host`).
 *
 * Why not just send: messages are user-attributable and visible to the
 * host. A model misreading intent and firing a real DM is a high-blast
 * mistake. The two-step gate is mandatory for anything user-attributable.
 */
const ArgsSchema = z.object({
  listingId: z
    .string()
    .min(1)
    .describe("Listing UUID from a previous tool result."),
  draftMessage: z
    .string()
    .min(2)
    .max(800)
    .describe("The proposed message body, in the user's language. Concise — chat tone, not formal."),
});
type Args = z.infer<typeof ArgsSchema>;

interface PreviewResult {
  listingId: string;
  listingTitle: string;
  hostName?: string;
  hostUserId?: string;
  draftMessage: string;
  /** Reasonable: the host can be DMed (host_user_id is present). */
  sendable: boolean;
  reason?: string;
}

export const messageHostPreviewTool: ToolDefinition<Args, PreviewResult> = {
  name: 'message_host_preview',
  description:
    "PREVIEW a message to a listing's host (no send). Call when the user wants to ask the host something. Returns host name + draft. Then emit action 'confirm_message_host' with {listingId, message} so the UI shows a Confirm card. NEVER send without explicit user confirmation.",
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      listingId: { type: 'string' },
      draftMessage: { type: 'string' },
    },
    required: ['listingId', 'draftMessage'],
  },

  async execute(args, _ctx) {
    let listing: Record<string, unknown>;
    try {
      const result = await listingsService.getById(args.listingId);
      listing = ((result as { data?: Record<string, unknown> }).data
        ?? (result as unknown as Record<string, unknown>));
    } catch (err) {
      if (err instanceof NotFoundError) {
        return {
          listingId: args.listingId,
          listingTitle: 'unknown listing',
          draftMessage: args.draftMessage,
          sendable: false,
          reason: 'listing_not_found',
        };
      }
      throw err;
    }

    // The DM target is the listing's owning user (the host). Field name
    // varies a bit across listing rows — check the common spellings.
    const hostUserId = typeof listing.user_id === 'string'
      ? listing.user_id
      : (typeof listing.host_user_id === 'string' ? listing.host_user_id : undefined);

    if (!hostUserId) {
      return {
        listingId: args.listingId,
        listingTitle: String(listing.title ?? listing.name ?? 'Untitled'),
        draftMessage: args.draftMessage,
        sendable: false,
        reason: 'no_host_contact',
      };
    }

    return {
      listingId: args.listingId,
      listingTitle: String(listing.title ?? listing.name ?? 'Untitled'),
      hostName: typeof listing.host_name === 'string' ? listing.host_name : undefined,
      hostUserId,
      draftMessage: args.draftMessage,
      sendable: true,
    };
  },

  summarize(_args, result) {
    if (!result.sendable) return `Can't message host of ${result.listingTitle} (${result.reason})`;
    return `Drafted message to ${result.hostName ?? 'host'} of ${result.listingTitle}`;
  },
};
