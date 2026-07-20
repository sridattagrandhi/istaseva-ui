import { ValidationError } from '../../../common/errors/app-error.js';

/**
 * Thrown when a service booking is about to be locked WITHOUT the user having
 * been offered the optional add-ons the chosen variant (or the listing) carries.
 * The deterministic half of the "always offer add-ons before booking" rule:
 * the model can resolve the offer by passing `serviceAddOnIds` (chosen ids, or
 * `[]` to mean "asked, declined") — but it must OFFER first. An undefined
 * `serviceAddOnIds` means it never did, so we refuse the hold.
 *
 * This offer has no confirm card — it's resolved ORALLY (the
 * prepare_booking tool maps this to reason 'addon_offer_required', the model
 * quotes the add-ons in chat and retries once the user answers). Carries the
 * offerable add-ons + the chosen variant name so the tool can echo them.
 *
 * Lives here (not assistant-booking.service.ts) so tool tests that vi.mock the
 * service module keep a real class for instanceof checks.
 */
export class AddOnOfferRequiredError extends ValidationError {
  constructor(
    public readonly listingName: string,
    public readonly variantName: string,
    public readonly addOns: Array<{ id: string; label: string; price: number }>,
  ) {
    super('Optional add-ons are available for this service — offer them before booking.');
  }
}
