import { z } from 'zod';
import { listingsService } from '../../../listings/services/listings.service.js';
import { approximateListingGeo } from '../../../listings/services/listing-geo-privacy.js';
import { NotFoundError } from '../../../../common/errors/app-error.js';
import { recordRecentHits } from '../recent-hits.js';
import { recordListingPriceables } from '../recent-priceables.js';
import { buildPriceableOptions } from '../priceable-options.js';
import { clampText } from '../clamp-text.js';
import type { ToolDefinition } from '../types.js';

// Cap the free-text description fed back to the model. This is the largest
// prose field in the result and it's replayed on every agent-loop iteration
// (COST-002). 600 chars keeps a solid descriptive paragraph while clipping
// multi-KB marketing copy; all structured/bookable fields stay untruncated.
const DESCRIPTION_MAX_CHARS = 600;

/**
 * Pull the full record for one listing the user is asking about. The agent
 * should call this after `search_listings` when the user picks one and
 * before drilling into "is it free Saturday?" or "what amenities?" — the
 * search hit is intentionally a thin summary.
 */
const ArgsSchema = z.object({
  listingId: z
    .string()
    .min(1)
    .max(64)
    .describe('Listing UUID. Must come from a previous search_listings result — never invent.'),
});
type Args = z.infer<typeof ArgsSchema>;

interface DetailsResult {
  id: string;
  title: string;
  type: string;
  description?: string;
  location?: string;
  price?: string;
  rating?: number;
  amenities?: unknown;
  hostName?: string;
  category?: string;
  /** Multi-value sub-skills the provider explicitly offers. Lets the agent
   *  answer "does this salon do beard trims?" without guessing from the
   *  single `category` value. Reads both new array shape and legacy scalar. */
  subcategories?: string[];
  maxGuests?: number;
  rooms?: Array<{
    id: string;
    name?: string;
    description?: string;
    pricePerNight?: number;
    maxGuests?: number;
    bedrooms?: number;
    bathrooms?: number;
    quantity?: number;
  }>;
  /** True when the listing exposes bookable room types — agent should ask which room to book. */
  hasRoomTypes?: boolean;
  /** True when the listing itself has no nightly/per-job price AND has no room types either. */
  noBookablePrice?: boolean;
  /** Service mode hints (only populated when listing_type='service'). The
   *  agent should ask which mode the customer wants and only request an
   *  address when 'at-home' is chosen. */
  serviceModes?: Array<'at-home' | 'visit-provider' | 'online'>;
  /** Service billing unit — agent should multiply per-hour/per-visit/etc.
   *  when previewing price. */
  pricingUnit?: string;
  /** Provider's shop/studio address — present when 'visit-provider' is one
   *  of the offered modes. Agent surfaces this rather than asking for it. */
  visitAddress?: string;
  /** Free-text meeting instructions when 'online' is one of the modes. */
  meetingDetails?: string;
  /** Provider weekly working hours: { mon: ["09:00","19:00"] | null, ... }.
   *  Agent should use this with find_available_slots, not invent hours. */
  workingHours?: Record<string, [string, string] | null>;
  /** Transport primary/default mode — only populated when listing_type='transport'.
   *  Do not treat this as the only supported mode; use transportModes/prices
   *  to decide what the driver can actually book. */
  transportMode?: 'hourly' | 'day' | 'package';
  /** All priced transport modes this listing currently supports. */
  transportModes?: Array<'hourly' | 'day' | 'package'>;
  /** Transport hourly rate in rupees (numeric). Use × hours for hourly bookings. */
  pricePerHour?: number;
  /** Transport per-day rate in rupees (numeric). Use as flat price for day rentals. */
  pricePerDay?: number;
  /** Predefined transport packages — `prepare_booking` references one by id/label. */
  packageOptions?: Array<{ id?: string; label: string; price: number; hours?: number; description?: string }>;
  /** Passenger seating capacity of the vehicle (transport only). The agent
   *  MUST check the user's passengerCount against this BEFORE calling
   *  prepare_booking — assistantBookingService rejects passengers > capacity
   *  with ValidationError, but a polite upfront refusal ("this cab seats 4,
   *  not 5") is a better UX than a backend bounce. Sourced from
   *  listing.metadata.capacity (host onboarding) → falls back to
   *  listing.capacity if a legacy row stored it as a top-level column. */
  capacity?: number;
  /** Service add-ons (sub-services) the customer can stack onto the base
   *  price at booking — each row { id, label, price (rupees) }. Stack
   *  ADDITIVELY: total = base + Σ chosen add-on prices. The agent should
   *  offer these by label after the user picks a slot, then pass the
   *  selected ids to get_booking_price_preview / prepare_booking. */
  addOns?: Array<{ id: string; label: string; price: number }>;
  /** Service VARIANTS the host priced separately (e.g. Men's / Women's / Kid's
   *  haircut), from listing.metadata.servicesCatalog. Each is { id, name,
   *  basePrice (rupees), addOns }. When present, listing.price is just the
   *  cheapest variant and is NOT what every customer pays — quote the per-
   *  variant prices, ask which one, then pass its `id` as `serviceCatalogId`
   *  to get_booking_price_preview / prepare_booking. The chosen variant's OWN
   *  addOns are the bookable add-ons (they differ per variant). */
  serviceCatalog?: Array<{
    id: string;
    name: string;
    basePrice: number;
    addOns: Array<{ id: string; label: string; price: number }>;
  }>;
  /** Normalized, type-agnostic list of EVERY priced option on this listing —
   *  stay room types, service variants, AND transport modes/packages, all in
   *  one shape. Lets the assistant (and a deterministic server-side
   *  enumerator) present the full menu without per-type branching. When the
   *  user asks "what all do they offer" / "full price list", enumerate ALL of
   *  these — never a subset, never just the cheapest. `unit` tells you the
   *  billing suffix (/visit, /hr, /night, /day, package). Service-wide add-ons
   *  appear as their own `group:'Add-ons'` entries; per-variant add-ons are
   *  nested under that variant's `addOns`. */
  priceableOptions?: Array<{
    group: string;
    name: string;
    price: number;
    unit: 'per_visit' | 'per_hour' | 'per_night' | 'per_day' | 'package';
    maxGuests?: number;
    addOns?: Array<{ name: string; price: number }>;
  }>;
}

export const getListingDetailsTool: ToolDefinition<Args, DetailsResult> = {
  name: 'get_listing_details',
  description:
    "Fetch full details for a specific listing by id. Use after search_listings when the user wants more info about one option (description, amenities, host) — and ALWAYS call this before suggesting prepare_booking for a stay, so you know whether the listing has bookable room types (hasRoomTypes=true ⇒ ask the user which room) vs. a single listing-level price.",
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      listingId: { type: 'string' },
    },
    required: ['listingId'],
  },

  async execute(args, ctx) {
    // UUID guard: real listing ids are UUIDs. The model has hallucinated
    // ids like "good-maths-123" before — those reach the SQL layer as
    // "invalid input syntax for type uuid" 500s, which is a) ugly and
    // b) a much louder failure than the model needs. Reject early with
    // a typed message it can act on (re-call search_listings to get a
    // real id, then retry).
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(String(args.listingId || '').trim())) {
      throw new Error(
        `Listing id ${JSON.stringify(args.listingId)} is not a valid UUID. `
        + 'Call search_listings first to get a real id; never invent or guess one.',
      );
    }
    let listing: Record<string, unknown>;
    try {
      const result = await listingsService.getById(args.listingId);
      listing = (result as { data?: Record<string, unknown> }).data
        ?? (result as unknown as Record<string, unknown>);
      // GEO PRIVACY (WS6): getById returns the raw row (the controller masks
      // for HTTP, but this tool bypasses it). Chat is a discovery surface —
      // exact address/coords are for booked users, and those come from the
      // bookings tools, not here.
      listing = approximateListingGeo(listing);
    } catch (err) {
      // The model occasionally invents a syntactically-valid UUID (passes
      // the regex above but isn't a row in the DB). Default NotFoundError
      // copy ("Listing <id> not found") got read as "the listing is gone"
      // and the agent would give up. Steer it to re-search instead, by
      // name + category from the original user query, so the next turn
      // can recover with a real id.
      const isNotFound = err instanceof NotFoundError
        || /not found/i.test((err as Error)?.message ?? '');
      if (isNotFound) {
        throw new Error(
          `Listing id "${args.listingId}" doesn't exist in the catalog — you likely invented it instead of using one from a previous search_listings result. `
          + 'Call search_listings with the listing\'s name + category to get a real id, then retry get_listing_details with that id. Never re-quote the bad id.',
        );
      }
      throw err;
    }
    try {

      // Rooms live on listing.room_types after listingsService.getById joined
      // them in. The repo stores prices in `base_price_paise` (NOT
      // `price_paise` — older code in this tool used the wrong field, which
      // is why the agent kept saying "the host hasn't set a price" for hotels
      // that do have rooms with prices).
      const rawRooms = Array.isArray(listing.room_types)
        ? (listing.room_types as Array<Record<string, unknown>>)
        : [];
      const rooms = rawRooms.map((r) => {
        const paise = Number(r.base_price_paise);
        return {
          id: String(r.id),
          name: typeof r.name === 'string' ? r.name : undefined,
          description: typeof r.description === 'string' ? r.description : undefined,
          pricePerNight: Number.isFinite(paise) && paise > 0 ? Math.round(paise / 100) : undefined,
          maxGuests: typeof r.max_guests === 'number' ? r.max_guests : undefined,
          bedrooms: typeof r.bedrooms === 'number' ? r.bedrooms : undefined,
          bathrooms: typeof r.bathrooms === 'number' ? r.bathrooms : undefined,
          quantity: typeof r.quantity === 'number' ? r.quantity : undefined,
        };
      });

      const listingPrice = typeof listing.price_paise === 'number'
        ? `₹${(listing.price_paise / 100).toFixed(0)}`
        : (typeof listing.price === 'string' || typeof listing.price === 'number'
            ? `₹${listing.price}`
            : (typeof listing.price_per_night === 'number'
                ? `₹${listing.price_per_night}`
                : undefined));

      const hasRoomTypes = rooms.length > 0;
      const noBookablePrice = !hasRoomTypes && !listingPrice;

      // Service / transport metadata lives in listing.metadata (JSONB on
      // listings). Surface only what the agent needs to drive its follow-up
      // questions — never invent fields, just pass through what the host set.
      const meta = (listing.metadata as Record<string, unknown> | null | undefined) ?? {};
      const listingType = String(listing.listing_type ?? meta.listingType ?? '').toLowerCase();
      const isService = listingType === 'service';
      const isTransport = listingType === 'transport';
      const num = (v: unknown): number | undefined => {
        if (v == null) return undefined;
        const n = typeof v === 'string' ? Number(v.replace(/[^\d.]/g, '')) : Number(v);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      };
      const arrStr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
      const serviceModes = isService
        ? (arrStr(meta.serviceModes) as Array<'at-home' | 'visit-provider' | 'online'>)
        : undefined;
      const transportModeRaw = isTransport && typeof meta.transportMode === 'string' ? meta.transportMode : undefined;
      const transportMode = transportModeRaw === 'hourly' || transportModeRaw === 'day' || transportModeRaw === 'package'
        ? transportModeRaw
        : undefined;
      const pricePerHour = isTransport ? num(meta.pricePerHour) : undefined;
      const pricePerDay = isTransport ? num(meta.pricePerDay) : undefined;
      type PkgOption = { id: string; label: string; price: number; hours?: number; description?: string };
      const rawPackages = isTransport && Array.isArray(meta.packageOptions) ? meta.packageOptions : [];
      const packageOptions: PkgOption[] = [];
      rawPackages.forEach((p, idx) => {
        if (!p || typeof p !== 'object') return;
        const row = p as Record<string, unknown>;
        const label = typeof row.label === 'string' ? row.label : '';
        const price = num(row.price);
        if (!label || price == null) return;
        const opt: PkgOption = {
          id: typeof row.id === 'string' ? row.id : `pkg-${idx}`,
          label,
          price,
        };
        const h = num(row.hours);
        if (h != null) opt.hours = h;
        if (typeof row.description === 'string') opt.description = row.description;
        packageOptions.push(opt);
      });
      const transportModes: Array<'hourly' | 'day' | 'package'> = [];
      if (pricePerHour != null) transportModes.push('hourly');
      if (pricePerDay != null) transportModes.push('day');
      if (packageOptions.length > 0) transportModes.push('package');

      // Vehicle seating capacity. Matches assistantBookingService.prepare's
      // server-side validation (`passengers > capacity ⇒ ValidationError`)
      // and the booking modal's Stepper `max={item.capacity}`. Mirror their
      // lookup order: metadata.capacity is the host-onboarded source of
      // truth, the top-level `capacity` column is a legacy fallback.
      const capacity = isTransport ? num(meta.capacity ?? (listing as Record<string, unknown>).capacity) : undefined;

      const wh = (listing as { working_hours?: unknown }).working_hours
        ?? (meta as { workingHours?: unknown }).workingHours;
      const workingHours = wh && typeof wh === 'object' ? (wh as Record<string, [string, string] | null>) : undefined;

      // Service add-ons (optional sub-services). Surface only for services;
      // the booking modal renders these as checkboxes and the price-preview
      // / prepare-booking tools accept their ids.
      type AddOn = { id: string; label: string; price: number };
      const addOnsRaw = isService && Array.isArray(meta.addOns) ? meta.addOns : [];
      const addOns: AddOn[] = [];
      addOnsRaw.forEach((p, idx) => {
        if (!p || typeof p !== 'object') return;
        const row = p as Record<string, unknown>;
        const label = typeof row.label === 'string' ? row.label.trim() : '';
        const priceNum = Number(row.price);
        if (!label || !Number.isFinite(priceNum) || priceNum < 0) return;
        addOns.push({
          id: typeof row.id === 'string' && row.id.trim() ? row.id : `addon-${idx + 1}`,
          label,
          price: Math.round(priceNum),
        });
      });

      // Service catalog — per-variant pricing (Men's / Women's / Kid's haircut
      // etc.). Each variant carries its own base price AND its own add-ons. The
      // booking modal lets the user pick one; the pricing path resolves the
      // chosen variant via notes.selectedServiceCatalogId. Surface it so the
      // assistant can quote real per-variant prices instead of anchoring on
      // listing.price (which is just the cheapest variant) and so it can pass
      // the picked variant's id back as serviceCatalogId.
      const normalizeAddOns = (raw: unknown): AddOn[] => {
        if (!Array.isArray(raw)) return [];
        const out: AddOn[] = [];
        raw.forEach((p, idx) => {
          if (!p || typeof p !== 'object') return;
          const row = p as Record<string, unknown>;
          const label = typeof row.label === 'string' ? row.label.trim() : '';
          const priceNum = Number(row.price);
          if (!label || !Number.isFinite(priceNum) || priceNum < 0) return;
          out.push({
            id: typeof row.id === 'string' && row.id.trim() ? row.id : `addon-${idx + 1}`,
            label,
            price: Math.round(priceNum),
          });
        });
        return out;
      };
      type ServiceVariant = { id: string; name: string; basePrice: number; addOns: AddOn[] };
      const serviceCatalog: ServiceVariant[] = [];
      if (isService && Array.isArray(meta.servicesCatalog)) {
        (meta.servicesCatalog as unknown[]).forEach((g, idx) => {
          if (!g || typeof g !== 'object') return;
          const row = g as Record<string, unknown>;
          const name = typeof row.name === 'string' ? row.name.trim() : '';
          const basePrice = Number(row.basePrice);
          if (!name || !Number.isFinite(basePrice) || basePrice <= 0) return;
          serviceCatalog.push({
            id: typeof row.id === 'string' && row.id.trim() ? row.id : `svc-${idx}`,
            name,
            basePrice: Math.round(basePrice),
            addOns: normalizeAddOns(row.addOns),
          });
        });
      }

      // Normalized priced-options menu — collapses rooms / service variants /
      // transport modes (+ service-wide add-ons) into ONE shape. Built by the
      // shared helper so get_listing_details AND the full-menu self-fetch
      // backstop (user-assistant.service.ts) compute the SAME list from one
      // place and can't drift apart.
      const priceableOptions = buildPriceableOptions(listing);

      // Subcategories: prefer the new array, fall back to legacy scalar.
      // Drives the agent's "does this listing offer X?" answers without a
      // second tool call.
      const subsArrayRaw = Array.isArray(meta.subcategories)
        ? (meta.subcategories as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        : [];
      const subcategoriesList = subsArrayRaw.length > 0
        ? subsArrayRaw
        : (typeof meta.subcategory === 'string' && meta.subcategory.trim()
            ? [meta.subcategory.trim()]
            : []);

      // Keep the recent-hits scratchpad current — once the user is
      // engaging with a single listing, future turns should be able to
      // re-derive its id even if no new search runs.
      void recordRecentHits(ctx.userId, [{
        id: String(listing.id),
        title: String(listing.title ?? listing.name ?? 'Untitled'),
        type: String(listing.listing_type ?? listing.type ?? '').toLowerCase() || undefined,
        location: typeof listing.location === 'string'
          ? listing.location
          : (typeof listing.city === 'string' ? listing.city : undefined),
        price: listingPrice,
      }]);

      // Cache the full normalized menu so the full-menu backstop can complete
      // a partial price list on a LATER turn — when the model re-quotes prices
      // from context and drops a variant, this turn's tool result is already
      // gone. Best-effort; never blocks the response.
      if (priceableOptions.length > 0) {
        void recordListingPriceables(ctx.userId, String(listing.id), priceableOptions);
      }

      return {
        id: String(listing.id),
        title: String(listing.title ?? listing.name ?? 'Untitled'),
        type: String(listing.type ?? listing.listing_type ?? 'unknown'),
        category: typeof listing.category === 'string' ? listing.category : undefined,
        subcategories: subcategoriesList.length > 0 ? subcategoriesList : undefined,
        description: typeof listing.description === 'string'
          ? clampText(listing.description, DESCRIPTION_MAX_CHARS)
          : undefined,
        location: typeof listing.location === 'string'
          ? listing.location
          : (typeof listing.city === 'string' ? listing.city : undefined),
        price: listingPrice,
        rating: typeof listing.rating === 'number' ? listing.rating : undefined,
        amenities: listing.amenities,
        hostName: typeof listing.host_name === 'string' ? listing.host_name : undefined,
        maxGuests: typeof listing.guests === 'number' ? listing.guests : undefined,
        rooms: hasRoomTypes ? rooms : undefined,
        hasRoomTypes,
        noBookablePrice,
        serviceModes: serviceModes && serviceModes.length > 0 ? serviceModes : undefined,
        pricingUnit: isService && typeof meta.pricingUnit === 'string' ? meta.pricingUnit : undefined,
        visitAddress: isService && typeof meta.visitAddress === 'string' ? meta.visitAddress : undefined,
        meetingDetails: isService && typeof meta.meetingDetails === 'string' ? meta.meetingDetails : undefined,
        workingHours,
        transportMode,
        transportModes: isTransport && transportModes.length > 0 ? transportModes : undefined,
        pricePerHour,
        pricePerDay,
        packageOptions: isTransport && packageOptions.length > 0 ? packageOptions : undefined,
        capacity,
        addOns: addOns.length > 0 ? addOns : undefined,
        serviceCatalog: serviceCatalog.length > 0 ? serviceCatalog : undefined,
        priceableOptions: priceableOptions.length > 0 ? priceableOptions : undefined,
      };
    } catch (err) {
      if (err instanceof NotFoundError) {
        // Surface a clean message the model can react to ("looks like that
        // listing's gone — want me to find similar?") instead of a stack.
        throw new Error(`Listing ${args.listingId} not found`);
      }
      throw err;
    }
  },

  summarize(_args, result) {
    return `Loaded ${result.title}`;
  },
};
