import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

/**
 * Filter the marketplace PAGE the user is currently looking at — in place.
 *
 * Why a tool and not just an `apply_filters` action:
 *   The model reliably CALLS tools but routinely drops the free-text action
 *   envelope, and when asked to "filter this page" it tends to reach for
 *   search_listings (which renders cards in chat) instead. Making page
 *   filtering a first-class tool call makes the behaviour deterministic:
 *   user-assistant.service.ts promotes a successful call into the
 *   `apply_filters` action, and the web client drives the live filter state
 *   of the Stays/Services/Transport grid (chips move, results re-filter) with
 *   the chat panel still open — falling back to a filtered-page navigation
 *   when that page isn't currently mounted.
 *
 * Server-side this is a pure intent normaliser — there's no DB write and no
 * grid to mutate here; the filtering happens client-side over data the page
 * already loaded. The tool exists so the MODEL can express the intent
 * reliably, not to do work on the backend.
 */
const ArgsSchema = z.object({
  category: z
    .enum(['stay', 'service', 'transport'])
    .describe("Which marketplace the user is filtering. Match the page they're on (/explore=stay, /services=service, /transport=transport)."),
  q: z
    .string()
    .max(120)
    .optional()
    .describe('Free-text needle — city, area, temple, host, or property name. e.g. "Coorg", "Hyderabad".'),
  maxPrice: z
    .number()
    .positive()
    .optional()
    .describe('Upper price bound in rupees. "under 5k" → 5000.'),
  minRating: z
    .number()
    .min(0)
    .max(5)
    .optional()
    .describe('Minimum star rating. "4 stars and up" → 4.'),
  propertyTypes: z
    .array(z.string())
    .optional()
    .describe('Stays only — property-type chips, e.g. ["Homestay"], ["Hotel","Village stay"]. Omit for service/transport.'),
  serviceMode: z
    .enum(['at-home', 'visit-provider', 'online'])
    .optional()
    .describe('Services only — switch the top-level mode tab. "at home" → at-home, "at the salon/shop" → visit-provider, "online" → online.'),
  transportMode: z
    .enum(['hourly', 'day', 'package'])
    .optional()
    .describe('Transport only — switch the top-level mode tab. "by the hour" → hourly, "full day" → day, "tour/package" → package.'),
  subcategories: z
    .array(z.string())
    .optional()
    .describe('Services only — subcategory chips, e.g. ["cleaning"], ["haircut","beard trim"]. Omit for stay/transport.'),
});
type Args = z.infer<typeof ArgsSchema>;

interface Result {
  category: 'stay' | 'service' | 'transport';
  q?: string;
  maxPrice?: number;
  minRating?: number;
  propertyTypes?: string[];
  serviceMode?: 'at-home' | 'visit-provider' | 'online';
  transportMode?: 'hourly' | 'day' | 'package';
  subcategories?: string[];
}

export const filterMarketplaceTool: ToolDefinition<Args, Result> = {
  name: 'filter_marketplace',
  description:
    "Filter the marketplace PAGE the user is currently browsing, in place — the on-screen grid re-filters live. Call this (NOT search_listings) when the user is on /explore, /services, or /transport and wants to narrow what's already on screen: 'under 5k', 'only homestays', 'cheaper', 'in Coorg', '4 stars and up', 'show Innova cars', 'at-home services only', 'just cleaning', 'switch to day rentals'. Pass `category` matching the page. For services pass `serviceMode` (at-home/visit-provider/online) and/or `subcategories`; for transport pass `transportMode` (hourly/day/package). search_listings is for surfacing fresh options as cards in chat; this is for operating the list the user is looking at.",
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['stay', 'service', 'transport'] },
      q: { type: 'string' },
      maxPrice: { type: 'number' },
      minRating: { type: 'number' },
      propertyTypes: { type: 'array', items: { type: 'string' } },
      serviceMode: { type: 'string', enum: ['at-home', 'visit-provider', 'online'] },
      transportMode: { type: 'string', enum: ['hourly', 'day', 'package'] },
      subcategories: { type: 'array', items: { type: 'string' } },
    },
    required: ['category'],
  },

  async execute(args) {
    // Pure intent normaliser — echo the validated filters back. The action
    // promotion + web client do the actual in-place filtering.
    return {
      category: args.category,
      q: args.q,
      maxPrice: args.maxPrice,
      minRating: args.minRating,
      propertyTypes: args.propertyTypes,
      serviceMode: args.serviceMode,
      transportMode: args.transportMode,
      subcategories: args.subcategories,
    };
  },

  summarize(args) {
    const parts: string[] = [];
    if (args.q) parts.push(args.q);
    if (typeof args.maxPrice === 'number') parts.push(`under ₹${args.maxPrice}`);
    if (typeof args.minRating === 'number') parts.push(`${args.minRating}★+`);
    if (args.propertyTypes?.length) parts.push(args.propertyTypes.join('/'));
    if (args.serviceMode) parts.push(args.serviceMode);
    if (args.transportMode) parts.push(args.transportMode);
    if (args.subcategories?.length) parts.push(args.subcategories.join('/'));
    return parts.length ? `Filtered ${args.category} — ${parts.join(', ')}` : `Filtered ${args.category}`;
  },
};
