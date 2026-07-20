import { z } from 'zod';
import { listingsService } from '../../../listings/services/listings.service.js';
import {
  applyFees,
  resolveServiceAddOns,
  resolveServiceCatalogGroup,
  subtotalForServicePaise,
  subtotalForTransportHourlyPaise,
  subtotalForTransportDayPaise,
  subtotalForTransportPackagePaise,
} from '../../../payments/pricing/booking-price.js';
import { insurancePremiumRupees } from '../../../payments/pricing/fees.js';
import { feeRulesService } from '../../../payments/services/fee-rules.service.js';
import { matchPackageId } from '../room-matching.js';
import { NotFoundError } from '../../../../common/errors/app-error.js';
import { logger } from '../../../../common/logging/logger.js';
import type { ToolDefinition } from '../types.js';

/**
 * Non-mutating price preview for SERVICE + TRANSPORT bookings.
 *
 * Mirrors `get_stay_pricing_preview` for the non-stay side. Uses the same
 * canonical subtotal helpers + applyFees that `assistantBookingService.prepare`
 * will use when it actually creates the hold, so the quoted total is
 * byte-identical to the Confirm & Pay card.
 *
 * The agent MUST call this before prepare_booking for services/transport so
 * the user can confirm the price BEFORE a slot hold gets created.
 */

const ArgsSchema = z
  .object({
    listingId: z.string().min(1),
    /** Service-only: 'at-home' | 'visit-provider' | 'online'. */
    serviceMode: z.enum(['at-home', 'visit-provider', 'online']).optional(),
    /** Optional service duration (in hours) — used when pricing is per-hour. */
    serviceHours: z.number().positive().max(24).optional(),
    /** Service variant id from get_listing_details.serviceCatalog[].id (e.g.
     *  Men's vs Women's haircut). Sets the base price; REQUIRED when the
     *  listing has >1 variant or the quote won't match the actual charge. */
    serviceCatalogId: z.string().min(1).max(64).optional(),
    /** Optional ids of extras for the SAME appointment the customer picked.
     *  Each id must come from `addOns[]` OR `serviceCatalog[]` returned by
     *  get_listing_details — passing another serviceCatalog[].id here combines
     *  multiple distinct services into one booking (each priced at its own
     *  rate). Inventing ids is rejected as ValidationError. Prices are resolved
     *  server-side from the listing — never trust client-quoted prices. */
    serviceAddOnIds: z.array(z.string().min(1).max(64)).max(20).optional(),
    /** Transport-only mode the user picked. */
    transportMode: z.enum(['hourly', 'day', 'package']).optional(),
    /** Hours for transport hourly mode. */
    transportHours: z.number().positive().max(24).optional(),
    /** Days for transport day mode — default 1 if omitted. */
    transportDays: z.number().int().min(1).max(60).optional(),
    /** Package id when transportMode is 'package'. */
    transportPackageId: z.string().optional(),
    /** Trip-protection / insurance opt-in. */
    insuranceOptIn: z.boolean().optional(),
  });
type Args = z.infer<typeof ArgsSchema>;

interface PreviewResult {
  available: boolean;
  reason?: 'unknown_listing' | 'unknown_package' | 'no_price' | 'mode_required' | 'missing_input' | 'unknown';
  userMessage?: string;
  category?: 'service' | 'transport' | 'stay' | 'other';
  /** Plain-English breakdown lines the agent can quote verbatim. */
  breakdown?: string[];
  subtotal?: number;
  platformFee?: number;
  taxes?: number;
  gstRatePct?: number;
  insurance?: { included: boolean; amount: number };
  total?: number;
  currency?: 'INR';
}

/** Exact paise → rupees (2-dp number) so the previewed total reconciles to the
 *  paise-accurate Razorpay charge instead of rounding to whole rupees (which
 *  drifted ~₹0.50 from the modal). */
function rupees(paise: number): number {
  return Math.round(paise) / 100;
}
/** Display string for a paise amount: "829.54", "3", "700" (drops a .00 tail). */
function rupeeStr(paise: number): string {
  const v = rupees(paise);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

// Safe, non-leaky line for an unresolvable listingId. The model usually got
// here by passing a stale/invented id — the prompt's `unknown_listing` rule
// tells it to silently re-pull the real id from the recent search hit and
// retry, NOT to surface ids ("the listing ID I was using might be incorrect").
const UNKNOWN_LISTING_MSG = "I lost track of that listing for a second — let me pull it back up.";

function num(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'string' ? Number(String(v).replace(/[^\d.]/g, '')) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const getBookingPricePreviewTool: ToolDefinition<Args, PreviewResult> = {
  name: 'get_booking_price_preview',
  description:
    "Preview the real total for a SERVICE or TRANSPORT booking BEFORE prepare_booking. Uses the same subtotal helpers + platform fee + GST + insurance math the hold uses, so the number you quote is the number the user will be asked to pay. For services pass serviceMode (and serviceHours if pricingUnit is per_hour), serviceCatalogId when the listing has multiple variants (it sets the base price), plus serviceAddOnIds if the user picked any optional add-ons. For transport pass transportMode + the mode-specific field (transportHours / transportDays / transportPackageId). Returns {available:true, total, breakdown[]} on success, {available:false, reason, userMessage} when input is incomplete. Quote the breakdown lines + total to the user and get a 'yes book it' BEFORE calling prepare_booking.",
  sideEffect: 'read',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      listingId: { type: 'string' },
      serviceMode: { type: 'string', enum: ['at-home', 'visit-provider', 'online'] },
      serviceHours: { type: 'number' },
      serviceCatalogId: { type: 'string', description: 'Service variant id (serviceCatalog[].id) — required when the listing has multiple variants; sets the base price.' },
      serviceAddOnIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional ids of extras for the same appointment. Each id must come from addOns[] OR serviceCatalog[] in get_listing_details — another serviceCatalog[].id combines multiple distinct services into one booking. Prices stack additively onto the base service price and are taxable.',
      },
      transportMode: { type: 'string', enum: ['hourly', 'day', 'package'] },
      transportHours: { type: 'number' },
      transportDays: { type: 'number' },
      transportPackageId: { type: 'string' },
      insuranceOptIn: { type: 'boolean' },
    },
    required: ['listingId'],
  },

  async execute(args, _ctx): Promise<PreviewResult> {
    try {
      const listingRes = await listingsService.getById(args.listingId);
      const listing = listingRes.data as Record<string, unknown> | undefined;
      if (!listing) return { available: false, reason: 'unknown_listing', userMessage: UNKNOWN_LISTING_MSG };

      const meta = (listing.metadata as Record<string, unknown> | null | undefined) ?? {};
      // Mirror inferListingType in assistant-booking.service: prefer the
      // authoritative `listing_type` column, fall back to metadata.listingType
      // (set by onboarding), then `listing.type`. Without this fallback,
      // older transport/service rows with only metadata.listingType set fall
      // into the generic branch and either misclassify or skip the GST fix.
      const listingType = String(
        listing.listing_type
          ?? (meta as Record<string, unknown>).listingType
          ?? listing.type
          ?? '',
      ).toLowerCase();

      const breakdown: string[] = [];
      let subtotalPaise = 0;
      // serviceCategory passed into applyFees so GST rate matches what
      // bookings.service computeHoldSubtotalPaise will use. For transport
      // we override with the mode-derived `driver-*` slug — the listing's
      // raw `category` ("transport" / "cab") doesn't always trigger the
      // /^driver-/ test in gstRateFor, which means an 18% preview vs. a
      // 5% hold without this remap.
      let feeCategory: string | null = (typeof listing.category === 'string' ? listing.category : null) ?? listingType ?? null;

      if (listingType === 'service') {
        // Resolve the chosen service VARIANT the SAME way createHold does, so
        // the previewed price equals the actual charge. When the listing has a
        // multi-variant catalog, require the variant id — otherwise we'd price
        // the FIRST variant (the hold default) and silently misquote.
        const catalogRaw = Array.isArray(meta.servicesCatalog) ? (meta.servicesCatalog as unknown[]) : [];
        const variant = resolveServiceCatalogGroup(meta, args.serviceCatalogId);
        // On a multi-variant listing demand an EXPLICIT choice: no id (the
        // resolver would silently default to the first variant) or an id that
        // didn't match → ask which one instead of misquoting.
        if (catalogRaw.length > 1 && (!args.serviceCatalogId || !variant)) {
          const opts = catalogRaw
            .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
            .filter((g) => Number(g.basePrice) > 0)
            .map((g) => `${String(g.name ?? 'Option')} (₹${Math.round(Number(g.basePrice))})`)
            .join(', ');
          return {
            available: false,
            reason: 'missing_input',
            userMessage: opts ? `Which one — ${opts}?` : 'Which service option would you like?',
            category: 'service',
          };
        }
        // Variant base price + its OWN add-ons when present; else the flat
        // listing price + listing-level add-ons (legacy/single-price rows).
        const priceRupees = variant ? variant.basePrice : num(listing.price ?? meta.price);
        const listingAddOns = variant ? variant.addOns : meta.addOns;
        if (!priceRupees) {
          return { available: false, reason: 'no_price', userMessage: "That service doesn't have a price set yet — can't price it online.", category: 'service' };
        }
        const pricingUnit = String(meta.pricingUnit ?? '').toLowerCase();
        let hours = 1;
        if (pricingUnit === 'per_hour') {
          if (!args.serviceHours) {
            return { available: false, reason: 'missing_input', userMessage: 'For per-hour services I need how many hours — how long do you need?', category: 'service' };
          }
          hours = args.serviceHours;
        }
        // Resolve any selected add-ons against the listing's authoritative
        // metadata.addOns. Throws if the model invented an id — same
        // contract as the booking modal + createHold.
        let resolvedAddOns: Array<{ id: string; label: string; price: number }> = [];
        let addOnsRupees = 0;
        if (Array.isArray(args.serviceAddOnIds) && args.serviceAddOnIds.length > 0) {
          try {
            const r = resolveServiceAddOns({
              listingAddOns,
              selectedIds: args.serviceAddOnIds,
              catalogVariants: meta.servicesCatalog,
              baseVariantId: variant?.id ?? args.serviceCatalogId ?? null,
            });
            resolvedAddOns = r.items;
            addOnsRupees = r.sumRupees;
          } catch (err) {
            return {
              available: false,
              reason: 'missing_input',
              userMessage: (err as Error).message,
              category: 'service',
            };
          }
        }
        subtotalPaise = subtotalForServicePaise({ priceRupees, durationHours: hours, addOnsRupees });
        const unitLabel = pricingUnit === 'per_hour' ? `₹${priceRupees}/hour × ${hours}h`
          : pricingUnit === 'per_visit' ? `₹${priceRupees}/visit`
          : pricingUnit === 'per_session' ? `₹${priceRupees}/session`
          : pricingUnit === 'per_day' ? `₹${priceRupees}/day`
          : `₹${priceRupees}`;
        const baseLabel = variant?.name ? `${variant.name}: ${unitLabel}` : `Base: ${unitLabel}`;
        breakdown.push(`${baseLabel} = ₹${rupeeStr(subtotalPaise - Math.round(addOnsRupees * 100))}`);
        for (const opt of resolvedAddOns) {
          breakdown.push(`+ ${opt.label}: ₹${opt.price}`);
        }
        if (args.serviceMode) breakdown.push(`Mode: ${args.serviceMode}`);
      } else if (listingType === 'transport') {
        const supportedModes: Array<'hourly' | 'day' | 'package'> = [];
        if (num(meta.pricePerHour)) supportedModes.push('hourly');
        if (num(meta.pricePerDay)) supportedModes.push('day');
        if (Array.isArray(meta.packageOptions) && meta.packageOptions.length > 0) supportedModes.push('package');
        const primaryMode = typeof meta.transportMode === 'string' && ['hourly', 'day', 'package'].includes(meta.transportMode)
          ? (meta.transportMode as 'hourly' | 'day' | 'package')
          : undefined;
        const transportMode = args.transportMode
          ?? (supportedModes.length === 1 ? supportedModes[0] : undefined)
          ?? (supportedModes.length === 0 ? primaryMode : undefined);
        if (!transportMode) {
          const labels = supportedModes.length > 0
            ? supportedModes.map((m) => m === 'day' ? 'full day' : m).join(', ')
            : 'hourly, full day, or a package';
          return { available: false, reason: 'mode_required', userMessage: `Which mode — ${labels}?`, category: 'transport' };
        }
        if (transportMode === 'hourly') {
          const rate = num(meta.pricePerHour);
          if (!rate) return { available: false, reason: 'no_price', userMessage: "Driver hasn't set an hourly rate yet.", category: 'transport' };
          if (!args.transportHours) return { available: false, reason: 'missing_input', userMessage: 'How many hours?', category: 'transport' };
          subtotalPaise = subtotalForTransportHourlyPaise({ pricePerHourRupees: rate, durationHours: args.transportHours });
          breakdown.push(`₹${rate}/hour × ${args.transportHours}h = ₹${rupeeStr(subtotalPaise)}`);
          feeCategory = 'driver-hourly';
        } else if (transportMode === 'day') {
          const rate = num(meta.pricePerDay);
          if (!rate) return { available: false, reason: 'no_price', userMessage: "Driver hasn't set a day rate yet.", category: 'transport' };
          const days = args.transportDays ?? 1;
          if (days < 1 || days > 30) {
            return { available: false, reason: 'missing_input', userMessage: 'Days must be between 1 and 30.', category: 'transport' };
          }
          subtotalPaise = subtotalForTransportDayPaise({ pricePerDayRupees: rate, days });
          breakdown.push(`₹${rate}/day × ${days} day${days === 1 ? '' : 's'} = ₹${rupeeStr(subtotalPaise)}`);
          feeCategory = 'driver-day';
        } else if (transportMode === 'package') {
          const opts = Array.isArray(meta.packageOptions) ? meta.packageOptions : [];
          const optObjs = opts.filter((o): o is Record<string, unknown> => !!o && typeof o === 'object');
          const optionLabels = optObjs.map((o) => `${String(o.label ?? 'Package')} (₹${o.price})`).join(', ');
          if (!args.transportPackageId) {
            return { available: false, reason: 'missing_input', userMessage: optionLabels ? `Which package: ${optionLabels}?` : 'Which package?', category: 'transport' };
          }
          // Resolve the model's ref (label / slug / guessed id) to the canonical
          // id — the SAME tolerant matcher prepare_booking uses, so a preview
          // never dies on a ref the actual booking would have accepted.
          const resolvedPackageId = matchPackageId(args.transportPackageId, optObjs);
          if (!resolvedPackageId) {
            // Model-actionable: a wrong/stale ref means RE-READ the options,
            // not "the package was removed" — never claim the listing changed.
            return {
              available: false,
              reason: 'unknown_package',
              userMessage: optionLabels
                ? `That packageId didn't match — the listing's current packages are: ${optionLabels}. Retry with the exact id or label from get_listing_details.`
                : 'This listing has no packages set up — offer the other transport modes instead.',
              category: 'transport',
            };
          }
          // optObjs (not raw opts) so positional "pkg-<i>" ids line up with
          // the indexes matchPackageId resolved against.
          subtotalPaise = subtotalForTransportPackagePaise({ packageOptions: optObjs, packageId: resolvedPackageId });
          if (subtotalPaise <= 0) return { available: false, reason: 'no_price', userMessage: "That package doesn't have a valid price set yet.", category: 'transport' };
          const matched = optObjs.find((o, i) => (typeof o.id === 'string' ? o.id : `pkg-${i}`) === resolvedPackageId);
          breakdown.push(`Package: ${matched?.label ?? resolvedPackageId} = ₹${rupeeStr(subtotalPaise)}`);
          feeCategory = 'driver-package';
        }
      } else {
        return {
          available: false,
          reason: 'unknown',
          userMessage: 'This preview tool is for services and transport only — use get_stay_pricing_preview for stays.',
          category: 'other',
        };
      }

      if (subtotalPaise <= 0) {
        return { available: false, reason: 'no_price', userMessage: "Couldn't compute a price for that — host may not have set rates yet." };
      }

      // Same fee-rule resolution as createHold, so the previewed platform
      // fee matches what the hold will actually charge under admin rules.
      const resolvedFee = await feeRulesService.resolveForListingRow(
        listing ?? null,
        feeCategory,
      );
      const fees = applyFees({ subtotalPaise, category: feeCategory, nightlyHintPaise: null, fee: resolvedFee.spec });
      // Insurance is a flat ₹2 added AFTER tax (helper ignores its argument).
      const insuranceAmount = args.insuranceOptIn ? insurancePremiumRupees(rupees(fees.totalPaise)) : 0;
      const totalPaise = fees.totalPaise + Math.round(insuranceAmount * 100);
      const totalRupees = rupees(totalPaise);

      breakdown.push(`Platform fee: ₹${rupeeStr(fees.platformFeePaise)}`);
      breakdown.push(`GST (${Math.round(fees.gstRate * 100)}%): ₹${rupeeStr(fees.taxesPaise)}`);
      if (args.insuranceOptIn) breakdown.push(`Trip protection: ₹${insuranceAmount}`);
      breakdown.push(`Total: ₹${rupeeStr(totalPaise)}`);

      return {
        available: true,
        category: listingType === 'service' ? 'service' : listingType === 'transport' ? 'transport' : 'other',
        breakdown,
        subtotal: rupees(fees.discountedSubtotalPaise),
        platformFee: rupees(fees.platformFeePaise),
        taxes: rupees(fees.taxesPaise),
        gstRatePct: Math.round(fees.gstRate * 100),
        insurance: { included: !!args.insuranceOptIn, amount: insuranceAmount },
        total: totalRupees,
        currency: 'INR',
      };
    } catch (err) {
      if (err instanceof NotFoundError) return { available: false, reason: 'unknown_listing', userMessage: UNKNOWN_LISTING_MSG };
      logger.warn('get_booking_price_preview failed', { error: (err as Error).message });
      return { available: false, reason: 'unknown', userMessage: "Couldn't price that just now — try again in a moment." };
    }
  },

  summarize(_args, result) {
    if (result.available && result.total) return `Preview: ₹${result.total.toLocaleString()} total`;
    if (result.reason) return `Can't price — ${result.reason}`;
    return 'Priced';
  },
};
