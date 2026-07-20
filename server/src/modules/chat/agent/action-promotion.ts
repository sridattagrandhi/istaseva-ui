/**
 * Deterministic UI-action resolution from tool results.
 *
 * Why this exists
 * ---------------
 * The agent loop asks the model, on its final (no-tool) turn, to emit a
 * `{message, action, suggestions}` JSON envelope. Gemini in tool-calling
 * mode is reliable about CALLING tools but flaky about then composing that
 * structured envelope — it usually returns conversational prose, so the
 * `action` is dropped and the reply renders as a plain chat message even
 * though a tool clearly did something the UI should reflect (search hits to
 * render as cards, a cancel preview that needs a confirm card, etc.).
 *
 * The fix: treat TOOL RESULTS as the source of truth for UI actions. If a
 * tool ran and its result implies a UI action, we synthesise that action
 * here regardless of what (if anything) the model put in `action`. The
 * model's emitted action is only a fallback for turns where no tool implies
 * a UI affordance (e.g. "navigate to my dashboard").
 *
 * This generalises the original `open_listing` / `prepare_booking`
 * promotion that already lived in user-assistant.service.ts.
 *
 * Precedence (first match wins)
 * -----------------------------
 *   1. prepare_booking (success)        → prepare_booking_done
 *   2. open_listing (ok + listingId)    → open_listing
 *   3. cancel_booking_preview (cancellable) → confirm_cancel_booking
 *   4. message_host_preview (sendable)  → confirm_message_host
 *   5. toggle_wishlist (ok)             → wishlist_updated
 *   6. get_user_bookings (has rows, pure-read turn) → show_bookings
 *   7. search_listings / get_saved_listings (hits, discovery turn) → show_listing_cards
 *   8. model's emitted action
 *   9. none
 *
 * Guard: if the turn carried a side-effect intent (a booking / cancel /
 * message / open tool was attempted) but none of those promotions fired
 * — e.g. prepare_booking returned room_required, or open_listing lost the
 * id — we DON'T fall through to show_listing_cards. A snagged booking flow
 * needs the model's clarifying reply (or its own action like auth_required),
 * not a wall of cards from an earlier intermediate search.
 */

/** Minimal shape of a tool-call telemetry entry (subset of AgentLoopOutput). */
export interface PromotableToolCall {
  name: string;
  args?: Record<string, unknown>;
  ok: boolean;
  /** Tool result envelope: { ok, data } when the tool ran. */
  result?: { ok?: boolean; data?: Record<string, unknown> } | Record<string, unknown>;
}

export interface AssistantAction {
  type: string;
  params?: Record<string, unknown>;
}

export type ActionSource =
  | 'prepare_booking'
  | 'open_listing'
  | 'cancel_preview'
  | 'message_preview'
  | 'wishlist'
  | 'bookings'
  | 'insights'
  | 'filter_marketplace'
  | 'locate_listing'
  | 'listing_cards'
  | 'model'
  | 'none';

export interface ResolvedAction {
  action: AssistantAction;
  /** Which path produced the action — for telemetry / debugging. */
  source: ActionSource;
}

/** Pull the `.data` object out of a tool result envelope, if present. */
function dataOf(tc: PromotableToolCall): Record<string, unknown> | undefined {
  const r = tc.result as { data?: Record<string, unknown> } | undefined;
  return r && typeof r === 'object' ? r.data : undefined;
}

/** Map a search/saved row to the InlineListingHit shape the frontend renders. */
function toInlineHit(row: Record<string, unknown>): {
  id: string;
  title: string;
  type: string;
  location?: string;
  price?: string;
  rating?: number;
  image?: string;
} | null {
  const id = typeof row.id === 'string' ? row.id : undefined;
  const title = typeof row.title === 'string' ? row.title : undefined;
  if (!id || !title) return null;
  // Defense-in-depth for the availability gate: search_listings drops 'busy'
  // hits itself, but if an annotated-busy row ever reaches promotion (older
  // cached result, future tool), it must not ship as a tappable card.
  if (row.availability === 'busy') return null;
  return {
    id,
    title,
    type: typeof row.type === 'string' ? row.type : 'stay',
    location: typeof row.location === 'string' ? row.location : undefined,
    price: typeof row.price === 'string' ? row.price : undefined,
    rating: typeof row.rating === 'number' ? row.rating : undefined,
    image: typeof row.image === 'string' ? row.image : undefined,
  };
}

/** Map a get_user_bookings row to the compact shape the inline bookings list renders. */
function toBookingSummary(row: Record<string, unknown>): {
  id: string;
  status: string;
  listing?: string;
  provider?: string;
  start?: string;
  amount?: string;
} | null {
  const id = typeof row.id === 'string' ? row.id : undefined;
  if (!id) return null;
  return {
    id,
    status: typeof row.status === 'string' ? row.status : 'unknown',
    listing: typeof row.listing === 'string' ? row.listing : undefined,
    provider: typeof row.provider === 'string' ? row.provider : undefined,
    start: typeof row.start === 'string' ? row.start : undefined,
    amount: typeof row.amount === 'string' ? row.amount : undefined,
  };
}

/** Build the `filters` blob carried alongside cards so Open/Book preserve context. */
function filtersFromSearchArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined;
  const f: Record<string, unknown> = {};
  if (typeof args.category === 'string') f.category = args.category;
  if (typeof args.listingType === 'string' && !f.category) f.category = args.listingType;
  if (typeof args.location === 'string') f.location = args.location;
  if (typeof args.maxPrice === 'number') f.maxPrice = args.maxPrice;
  if (typeof args.query === 'string') f.q = args.query;
  return Object.keys(f).length ? f : undefined;
}

export function resolveAssistantAction(
  toolCalls: PromotableToolCall[],
  modelAction?: AssistantAction,
): ResolvedAction {
  const okCalls = (name: string) => toolCalls.filter((t) => t.name === name && t.ok);

  // 1. prepare_booking — the tool's data IS the PrepareBookingResult the
  //    frontend's prepare_booking_done handler expects. Only promote on a
  //    genuine success (hold + order created); failures (room_required,
  //    auth_required, ...) are left to the model.
  const prepareCalls = okCalls('prepare_booking');
  for (let i = prepareCalls.length - 1; i >= 0; i--) {
    const data = dataOf(prepareCalls[i]);
    if (
      data &&
      data.success === true &&
      typeof data.bookingId === 'string' &&
      typeof data.orderId === 'string'
    ) {
      return { action: { type: 'prepare_booking_done', params: data }, source: 'prepare_booking' };
    }
  }

  // 2. open_listing — navigate to the validated detail page.
  const openCalls = okCalls('open_listing');
  if (openCalls.length > 0) {
    const data = dataOf(openCalls[openCalls.length - 1]);
    const listingId = typeof data?.listingId === 'string' ? data.listingId : undefined;
    const listingType = typeof data?.listingType === 'string' ? data.listingType : undefined;
    if (listingId) {
      return { action: { type: 'open_listing', params: { listingId, listingType } }, source: 'open_listing' };
    }
  }

  // 2b. locate_listing — scroll to + flash a card on the current grid (the
  //     web client falls back to opening the detail page when it isn't on
  //     screen). Only promote on success — a bad id leaves it to the model.
  const locateCalls = okCalls('locate_listing');
  if (locateCalls.length > 0) {
    const data = dataOf(locateCalls[locateCalls.length - 1]);
    const listingId = typeof data?.listingId === 'string' ? data.listingId : undefined;
    if (data?.success === true && listingId) {
      return {
        action: {
          type: 'highlight_listing',
          params: {
            listingId,
            listingType: typeof data.listingType === 'string' ? data.listingType : undefined,
          },
        },
        source: 'locate_listing',
      };
    }
  }

  // 3. cancel_booking_preview — surface a Confirm-cancel card with the real
  //    refund summary. Only when the booking is actually cancellable.
  const cancelCalls = okCalls('cancel_booking_preview');
  for (let i = cancelCalls.length - 1; i >= 0; i--) {
    const data = dataOf(cancelCalls[i]);
    if (data && data.cancellable === true && typeof data.bookingId === 'string') {
      return {
        action: {
          type: 'confirm_cancel_booking',
          params: {
            bookingId: data.bookingId,
            summary: typeof data.cancellationSummary === 'string' ? data.cancellationSummary : undefined,
          },
        },
        source: 'cancel_preview',
      };
    }
  }

  // 4. message_host_preview — surface a Confirm-send card with the draft.
  const messageCalls = okCalls('message_host_preview');
  for (let i = messageCalls.length - 1; i >= 0; i--) {
    const data = dataOf(messageCalls[i]);
    if (
      data &&
      data.sendable === true &&
      typeof data.listingId === 'string' &&
      typeof data.hostUserId === 'string' &&
      typeof data.draftMessage === 'string'
    ) {
      return {
        action: {
          type: 'confirm_message_host',
          params: {
            listingId: data.listingId,
            hostUserId: data.hostUserId,
            message: data.draftMessage,
            hostName: typeof data.hostName === 'string' ? data.hostName : undefined,
          },
        },
        source: 'message_preview',
      };
    }
  }

  // 5. toggle_wishlist — the tool already persisted the save server-side; the
  //    UI just needs to reflect it (flip the heart / refresh the Saved tab).
  //    listingType isn't on the tool result, so read it from the call args.
  const wishlistCalls = okCalls('toggle_wishlist');
  if (wishlistCalls.length > 0) {
    const last = wishlistCalls[wishlistCalls.length - 1];
    const data = dataOf(last);
    const listingId = typeof data?.listingId === 'string' ? data.listingId : undefined;
    const action =
      typeof data?.action === 'string'
        ? data.action
        : typeof last.args?.action === 'string'
          ? (last.args.action as string)
          : undefined;
    const listingType = typeof last.args?.listingType === 'string' ? (last.args.listingType as string) : undefined;
    if (listingId) {
      return {
        action: { type: 'wishlist_updated', params: { listingId, listingType, action } },
        source: 'wishlist',
      };
    }
  }

  // Guard: a side-effect intent was attempted but didn't promote above. Don't
  // fall through to a render action (cards / bookings list) from an
  // intermediate read — let the model drive the recovery (room selection,
  // auth_required, "which one?", cancel confirmation, ...).
  const sideEffectAttempted = toolCalls.some((t) =>
    t.name === 'prepare_booking' ||
    t.name === 'open_listing' ||
    t.name === 'cancel_booking_preview' ||
    t.name === 'message_host_preview' ||
    t.name === 'toggle_wishlist' ||
    t.name === 'modify_booking' ||
    t.name === 'locate_listing',
  );

  // 5b. filter_marketplace — narrow the on-screen marketplace grid in place.
  //     The web client routes this to the live filter state (or a filtered-
  //     page navigation when that page isn't mounted). Tool-driven so it's
  //     reliable — the model kept reaching for search_listings (cards) when
  //     asked to "filter this page".
  const filterCalls = okCalls('filter_marketplace');
  if (filterCalls.length > 0) {
    const data = dataOf(filterCalls[filterCalls.length - 1]);
    const category = typeof data?.category === 'string' ? data.category : undefined;
    if (category) {
      const filters: Record<string, unknown> = {};
      if (typeof data?.q === 'string' && data.q) filters.q = data.q;
      if (typeof data?.maxPrice === 'number') filters.maxPrice = data.maxPrice;
      if (typeof data?.minRating === 'number') filters.minRating = data.minRating;
      if (Array.isArray(data?.propertyTypes) && data!.propertyTypes.length) {
        filters.categories = (data!.propertyTypes as unknown[]).map(String);
      }
      // Service top-level mode tab + subcategory chips; transport mode tab.
      if (typeof data?.serviceMode === 'string') filters.serviceMode = data.serviceMode;
      if (typeof data?.transportMode === 'string') filters.transportMode = data.transportMode;
      if (Array.isArray(data?.subcategories) && data!.subcategories.length) {
        filters.subcategories = (data!.subcategories as unknown[]).map(String);
      }
      return {
        action: { type: 'apply_filters', params: { category, filters } },
        source: 'filter_marketplace',
      };
    }
  }

  // 6a. get_booking_insights — render a compact stats strip (spend / counts /
  //     next trip) instead of prose. Pure-read turns only; skip the empty case
  //     (the model just says "no bookings yet").
  if (!sideEffectAttempted) {
    const insightCalls = okCalls('get_booking_insights');
    for (let i = insightCalls.length - 1; i >= 0; i--) {
      const data = dataOf(insightCalls[i]);
      if (data && data.empty !== true && (typeof data.totalSpent === 'string' || data.counts || data.nextTrip)) {
        return { action: { type: 'show_insights', params: { insights: data } }, source: 'insights' };
      }
    }
  }

  // 6. get_user_bookings — render the user's bookings inline rather than just
  //    describing them or bouncing to the dashboard. Pure-read turns only.
  //    Wins even if the model emitted `view_bookings`: the user asked to SEE
  //    them, and inline is better than forcing a navigation away from chat.
  if (!sideEffectAttempted) {
    const bookingCalls = okCalls('get_user_bookings');
    for (let i = bookingCalls.length - 1; i >= 0; i--) {
      const data = dataOf(bookingCalls[i]);
      const rows = Array.isArray(data?.bookings) ? (data!.bookings as Record<string, unknown>[]) : [];
      const bookings = rows.map(toBookingSummary).filter((b): b is NonNullable<typeof b> => b !== null);
      if (bookings.length > 0) {
        return { action: { type: 'show_bookings', params: { bookings } }, source: 'bookings' };
      }
    }
  }

  // The model explicitly chose a genuine page transition — respect it over
  // cards. Note `search` / `apply_filters` are deliberately NOT here: when a
  // search actually returned hits, rendering them inline is strictly better
  // than bouncing the user to a feed, so cards win even if the model emitted
  // one of those. (With no hits, the cards branch is skipped and we fall
  // through to the model's search/apply_filters action anyway.)
  const modelWantsExplicitNav =
    !!modelAction &&
    ['navigate', 'view_bookings', 'become_host', 'auth_required', 'start_booking'].includes(modelAction.type);

  // 7. search_listings / get_saved_listings — render the results as inline
  //    cards. Use the LAST such call that actually returned hits.
  if (!sideEffectAttempted && !modelWantsExplicitNav) {
    const cardCalls = toolCalls.filter(
      (t) => (t.name === 'search_listings' || t.name === 'get_saved_listings') && t.ok,
    );
    for (let i = cardCalls.length - 1; i >= 0; i--) {
      const data = dataOf(cardCalls[i]);
      const rows = Array.isArray(data?.results)
        ? (data!.results as Record<string, unknown>[])
        : Array.isArray(data?.items)
          ? (data!.items as Record<string, unknown>[])
          : [];
      const hits = rows.map(toInlineHit).filter((h): h is NonNullable<typeof h> => h !== null);
      if (hits.length > 0) {
        const filters = filtersFromSearchArgs(cardCalls[i].args);
        return {
          action: { type: 'show_listing_cards', params: filters ? { hits, filters } : { hits } },
          source: 'listing_cards',
        };
      }
    }
  }

  // 6 / 7. Fall through to the model's action, else none.
  if (modelAction) return { action: modelAction, source: 'model' };
  return { action: { type: 'none', params: {} }, source: 'none' };
}
