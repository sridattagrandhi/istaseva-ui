/**
 * resolve_address — verify a customer-given address against the map BEFORE
 * booking with it, and hand the model the canonical rendering to echo back.
 *
 * Resolution is Places-FIRST: establishment/landmark inputs ("Trident Hotels
 * in Hyderabad", "Secunderabad railway station") match far better through
 * Place Autocomplete than plain geocoding, and autocomplete surfaces the
 * ALTERNATES ("Trident, HITEC City" vs "Trident, Nanakramguda") the model
 * needs for disambiguation — pick-the-first is how a driver ends up at the
 * wrong Trident. Plain geocoding remains the fallback for full street
 * addresses and for dev environments without a Google key (autocomplete
 * returns [] there; Nominatim still geocodes).
 *
 * The model quotes `formattedAddress` VERBATIM — it never gets to claim an
 * address is "verified" on its own, and prepare_booking re-checks at-home
 * addresses server-side regardless (address-verification.ts), so a skipped
 * or ignored tool call still can't slip a junk address into a hold.
 */
import { z } from 'zod';
import { autocompleteAddress, geocodeAddress, placeDetailsForId } from '../../../../common/services/geocode.service.js';
import type { ToolDefinition } from '../types.js';

const ArgsSchema = z.object({
  address: z
    .string()
    .min(3)
    .max(500)
    .describe('The address exactly as the user gave it — do not reword, shorten, or "fix" it. When the user picks one of a previous result\'s alternates, pass that alternate\'s description here.'),
  placeId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('ONLY when re-resolving a candidate from a previous resolve_address result: that candidate\'s placeId. Never invent one.'),
});
type Args = z.infer<typeof ArgsSchema>;

interface AddressCandidate {
  placeId: string;
  description: string;
}

interface ResolveAddressResult {
  resolved: boolean;
  /** The map provider's canonical rendering — quote this back VERBATIM. */
  formattedAddress?: string;
  lat?: number;
  lng?: number;
  placeId?: string;
  /** Other plausible matches. If one could be what the user meant (same name,
   *  different area/city), ask which one BEFORE booking. */
  alternates?: AddressCandidate[];
  userMessage?: string;
}

const UNRESOLVED: ResolveAddressResult = {
  resolved: false,
  userMessage:
    'That address didn\'t resolve on the map. Ask the user to add the street, area, or pincode — or a nearby landmark with the area and city.',
};

export const resolveAddressTool: ToolDefinition<Args, ResolveAddressResult> = {
  name: 'resolve_address',
  description:
    'Verify a customer-given address (at-home service address or transport pickup) against the map BEFORE using it in a booking. Call it the moment the user provides an address or names a place ("Trident Hotels in Hyderabad"). Returns {resolved, formattedAddress, lat, lng, placeId, alternates}. When resolved=true: fold formattedAddress VERBATIM into your NEXT message instead of a separate confirmation turn ("Got it — <formattedAddress>. How many passengers?") — the user corrects you if it\'s wrong; never reword it. BUT if `alternates` contains a plausible other match (same establishment name, different area or city), ask WHICH ONE before booking, then re-call resolve_address with the chosen candidate\'s description as `address` and its placeId as `placeId`. When resolved=false, ask the user to add the street, area, or pincode (a landmark + area + city also works) and resolve again. If it is STILL unresolved after two attempts, do NOT dead-end the booking: proceed with the user\'s exact wording and tell them the provider may call to confirm directions — prepare_booking accepts the address at that point. Use the confirmed formattedAddress as the serviceAddress / pickupLocation you book with.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      address: { type: 'string', description: 'The address exactly as the user gave it (or a chosen alternate\'s description).' },
      placeId: { type: 'string', description: 'Only when re-resolving a chosen alternate from a previous result: its placeId.' },
    },
    required: ['address'],
  },
  argsSchema: ArgsSchema,
  sideEffect: 'read',
  async execute(args: Args): Promise<ResolveAddressResult> {
    // Chosen-alternate path: the user picked a candidate we already surfaced.
    if (args.placeId) {
      const details = await placeDetailsForId(args.placeId);
      if (details) {
        return { resolved: true, formattedAddress: args.address, lat: details.lat, lng: details.lng, placeId: args.placeId };
      }
      // Stale/invalid id — fall through to a fresh resolution of the text.
    }

    // Places-first: best establishment/landmark matching + real alternates.
    const suggestions = await autocompleteAddress(args.address, 'address'); // [] on error / no key
    if (suggestions.length > 0) {
      const top = suggestions[0];
      const details = await placeDetailsForId(top.id);
      if (details) {
        return {
          resolved: true,
          formattedAddress: top.description,
          lat: details.lat,
          lng: details.lng,
          placeId: top.id,
          ...(suggestions.length > 1
            ? { alternates: suggestions.slice(1, 3).map((s) => ({ placeId: s.id, description: s.description })) }
            : {}),
        };
      }
    }

    // Fallback: plain geocoding — full street addresses, and dev/no-key
    // environments where autocomplete is unavailable but Nominatim works.
    const result = await geocodeAddress(args.address); // never throws; null on no-hit
    if (!result) return UNRESOLVED;
    return {
      resolved: true,
      formattedAddress: result.formattedAddress ?? args.address,
      lat: result.lat,
      lng: result.lng,
    };
  },
  summarize(args: Args, result: ResolveAddressResult): string {
    return result.resolved
      ? `Address verified: ${result.formattedAddress ?? args.address}`
      : 'Address not found on the map';
  },
};
