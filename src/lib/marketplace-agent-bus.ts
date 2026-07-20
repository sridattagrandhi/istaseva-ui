/**
 * Marketplace agent bus — a tiny module-level pub/sub that lets the
 * globally-mounted Ista AI assistant operate the marketplace page the user
 * is currently looking at, WITHOUT navigating away or reloading.
 *
 * Why a bus (not React context):
 *   The assistant widget (App.tsx, always mounted) and the marketplace
 *   surface (ClientRedesign, mounted only on /, /explore, /services,
 *   /transport) are siblings that mount/unmount independently. A module
 *   singleton sidesteps provider plumbing and is naturally resilient to the
 *   marketplace coming and going: when no marketplace page is mounted there
 *   are simply no subscribers, and `emit` reports that so the caller can
 *   fall back to URL navigation.
 *
 * Contract:
 *   - The active marketplace sub-page subscribes on mount and handles intents
 *     it understands for ITS category, returning true iff it applied them.
 *   - The widget calls `emit(intent)`; if it returns true the page handled it
 *     in place (keep the chat open, no navigation). If false, nothing on
 *     screen could act on it → the widget navigates with URL params instead
 *     (ClientRedesign's useUrlFilterSync then applies them on arrival).
 */

export interface ApplyFiltersIntent {
  type: 'apply_filters';
  /** Which marketplace the filters target. Undefined = "whatever page is open". */
  category?: 'stay' | 'service' | 'transport';
  /** Free-text needle (city / temple / host / property). */
  q?: string;
  /** Upper price bound → maps to each page's `priceMax`. */
  maxPrice?: number;
  /** Lower rating bound → maps to each page's `ratingMin`. */
  minRating?: number;
  /** Stay property-type chips (e.g. ["Hotel","Homestay"]) → stay filters.types. */
  types?: string[];
  /** Service top-level mode tab (At home / Visit / Online). */
  serviceMode?: "at-home" | "visit-provider" | "online";
  /** Transport top-level mode tab (Hourly / Day rental / Tour package). */
  transportMode?: "hourly" | "day" | "package";
  /** Service subcategory chips (e.g. ["cleaning"]) → service filters.categories. */
  subcategories?: string[];
}

export type MarketplaceIntent = ApplyFiltersIntent;

/** Returns true if the subscriber acted on the intent. */
export type MarketplaceIntentHandler = (intent: MarketplaceIntent) => boolean;

const handlers = new Set<MarketplaceIntentHandler>();

export const marketplaceAgentBus = {
  /** Register a handler (the active sub-page). Returns an unsubscribe fn. */
  subscribe(handler: MarketplaceIntentHandler): () => void {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  },

  /**
   * Dispatch an intent to all subscribers. Returns true if AT LEAST ONE
   * subscriber reported it handled the intent — the caller uses this to
   * decide between "acted in place" and "fall back to navigation".
   */
  emit(intent: MarketplaceIntent): boolean {
    let handled = false;
    for (const handler of handlers) {
      try {
        if (handler(intent)) handled = true;
      } catch {
        /* a misbehaving subscriber must not break dispatch to the others */
      }
    }
    return handled;
  },
};

/**
 * Scroll a marketplace card into view and flash it, if it's on the page right
 * now. Returns true when the card exists in the current DOM (so the caller
 * knows it acted in place), false otherwise (so it can fall back to opening
 * the listing's detail page). Grid cards carry `id="mp-card-<listingId>"`.
 *
 * Deliberately DOM-level rather than React state: the highlight is a transient
 * visual cue and the three marketplace grids render different card components,
 * so a single id convention + a flash class is far less invasive than
 * threading highlight state through every grid and card.
 */
export function highlightMarketplaceCard(listingId: string): boolean {
  if (typeof document === 'undefined' || !listingId) return false;
  const el = document.getElementById(`mp-card-${listingId}`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('mp-card-flash');
  // Force a reflow so re-adding the class restarts the animation if the same
  // card is highlighted twice in a row.
  void (el as HTMLElement).offsetWidth;
  el.classList.add('mp-card-flash');
  window.setTimeout(() => el.classList.remove('mp-card-flash'), 2200);
  return true;
}
