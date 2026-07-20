/**
 * Listing price helper.
 *
 * Hosts set the list price; an optional `discountPercent` (0–90) is applied to
 * derive the display price. Demand-based / city-tier dynamic pricing was
 * removed — the host is the only knob.
 */

export interface ListingPriceResult {
  adjustedPrice: number;
  originalPrice: number;
  savingsPercent: number | null;
}

export function applyHostDiscount(stay: { price: number; discountPercent?: number }): ListingPriceResult {
  const hostDiscount = Math.max(0, Math.min(90, Number(stay.discountPercent) || 0));
  if (hostDiscount > 0) {
    return {
      adjustedPrice: Math.round(stay.price * (1 - hostDiscount / 100)),
      originalPrice: stay.price,
      savingsPercent: hostDiscount,
    };
  }
  return {
    adjustedPrice: stay.price,
    originalPrice: stay.price,
    savingsPercent: null,
  };
}
