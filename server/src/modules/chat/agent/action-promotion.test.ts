// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { resolveAssistantAction, type PromotableToolCall } from './action-promotion.js';

/** Build a successful tool-call telemetry entry with a data envelope. */
function ok(name: string, data: Record<string, unknown>, args: Record<string, unknown> = {}): PromotableToolCall {
  return { name, args, ok: true, result: { ok: true, data } };
}

/** Build a failed tool-call entry. */
function fail(name: string, data: Record<string, unknown> = {}, args: Record<string, unknown> = {}): PromotableToolCall {
  return { name, args, ok: false, result: { ok: false, data } };
}

describe('resolveAssistantAction', () => {
  it('falls back to the model action when no tool implies a UI affordance', () => {
    const r = resolveAssistantAction([], { type: 'navigate', params: { path: '/bookings' } });
    expect(r.source).toBe('model');
    expect(r.action.type).toBe('navigate');
  });

  it('returns none when there is neither a tool nor a model action', () => {
    const r = resolveAssistantAction([]);
    expect(r.source).toBe('none');
    expect(r.action.type).toBe('none');
  });

  it('promotes a successful prepare_booking to prepare_booking_done with the full payload', () => {
    const payload = { success: true, bookingId: 'b1', orderId: 'o1', listing: { name: 'Taj' } };
    const r = resolveAssistantAction([ok('prepare_booking', payload)]);
    expect(r.source).toBe('prepare_booking');
    expect(r.action.type).toBe('prepare_booking_done');
    expect(r.action.params).toMatchObject({ bookingId: 'b1', orderId: 'o1' });
  });

  it('does NOT promote a failed prepare_booking (room_required) and defers to the model', () => {
    const r = resolveAssistantAction(
      [
        ok('search_listings', { results: [{ id: 'l1', title: 'Hotel A', type: 'stay' }] }),
        { name: 'prepare_booking', args: {}, ok: true, result: { ok: true, data: { success: false, reason: 'room_required' } } },
      ],
      undefined,
    );
    // A snagged booking flow must NOT dump search cards — let the model ask.
    expect(r.source).toBe('none');
    expect(r.action.type).toBe('none');
  });

  it('promotes open_listing over a same-turn search', () => {
    const r = resolveAssistantAction([
      ok('search_listings', { results: [{ id: 'l1', title: 'Hotel A', type: 'stay' }] }),
      ok('open_listing', { listingId: 'l1', listingType: 'stay' }),
    ]);
    expect(r.source).toBe('open_listing');
    expect(r.action.params).toMatchObject({ listingId: 'l1', listingType: 'stay' });
  });

  it('prepare_booking trumps open_listing when both succeed', () => {
    const r = resolveAssistantAction([
      ok('open_listing', { listingId: 'l1', listingType: 'stay' }),
      ok('prepare_booking', { success: true, bookingId: 'b1', orderId: 'o1' }),
    ]);
    expect(r.source).toBe('prepare_booking');
  });

  it('promotes search_listings results to show_listing_cards with mapped hits + filters', () => {
    const r = resolveAssistantAction([
      ok(
        'search_listings',
        {
          results: [
            { id: 'l1', title: 'Hotel A', type: 'stay', location: 'Goa', price: '₹5,000', rating: 4.5 },
            { id: 'l2', title: 'Hotel B', type: 'stay' },
          ],
        },
        { category: 'stay', location: 'Goa', maxPrice: 6000, query: 'beach' },
      ),
    ]);
    expect(r.source).toBe('listing_cards');
    expect(r.action.type).toBe('show_listing_cards');
    const params = r.action.params as { hits: unknown[]; filters: Record<string, unknown> };
    expect(params.hits).toHaveLength(2);
    expect(params.hits[0]).toMatchObject({ id: 'l1', title: 'Hotel A', location: 'Goa', price: '₹5,000', rating: 4.5 });
    expect(params.filters).toMatchObject({ category: 'stay', location: 'Goa', maxPrice: 6000, q: 'beach' });
  });

  it('drops rows missing id or title when mapping hits', () => {
    const r = resolveAssistantAction([
      ok('search_listings', { results: [{ id: 'l1', title: 'Good' }, { id: 'l2' }, { title: 'NoId' }] }),
    ]);
    const params = r.action.params as { hits: unknown[] };
    expect(params.hits).toHaveLength(1);
  });

  it('does not promote cards when search returned zero hits', () => {
    const r = resolveAssistantAction([ok('search_listings', { results: [] })], { type: 'none' });
    expect(r.source).toBe('model');
  });

  it('promotes get_saved_listings items to show_listing_cards', () => {
    const r = resolveAssistantAction([
      ok('get_saved_listings', { items: [{ id: 's1', title: 'Saved Stay', type: 'stay', image: 'x.jpg' }] }),
    ]);
    expect(r.source).toBe('listing_cards');
    const params = r.action.params as { hits: Array<Record<string, unknown>> };
    expect(params.hits[0]).toMatchObject({ id: 's1', title: 'Saved Stay', image: 'x.jpg' });
  });

  it('respects an explicit model navigation action over cards from an intermediate search', () => {
    const r = resolveAssistantAction(
      [ok('search_listings', { results: [{ id: 'l1', title: 'Hotel A', type: 'stay' }] })],
      { type: 'navigate', params: { path: '/bookings' } },
    );
    expect(r.source).toBe('model');
    expect(r.action.type).toBe('navigate');
  });

  it('lets inline cards win over a model "search" action when the search returned hits', () => {
    const r = resolveAssistantAction(
      [ok('search_listings', { results: [{ id: 'l1', title: 'Hotel A', type: 'stay' }] })],
      { type: 'search', params: { category: 'stay', location: 'Goa' } },
    );
    expect(r.source).toBe('listing_cards');
    expect(r.action.type).toBe('show_listing_cards');
  });

  it('falls through to a model apply_filters action when there are no search hits to render', () => {
    const r = resolveAssistantAction(
      [ok('search_listings', { results: [] })],
      { type: 'apply_filters', params: { category: 'stay', filters: { maxPrice: 2000 } } },
    );
    expect(r.source).toBe('model');
    expect(r.action.type).toBe('apply_filters');
  });

  it('promotes a cancellable cancel_booking_preview to confirm_cancel_booking', () => {
    const r = resolveAssistantAction([
      ok('cancel_booking_preview', {
        bookingId: 'b1',
        cancellable: true,
        cancellationSummary: 'Cancelling refunds ₹4,000.',
      }),
    ]);
    expect(r.source).toBe('cancel_preview');
    expect(r.action.type).toBe('confirm_cancel_booking');
    expect(r.action.params).toMatchObject({ bookingId: 'b1', summary: 'Cancelling refunds ₹4,000.' });
  });

  it('does NOT promote a non-cancellable preview (defers to model to explain)', () => {
    const r = resolveAssistantAction(
      [ok('cancel_booking_preview', { bookingId: 'b1', cancellable: false, reason: 'forbidden' })],
      { type: 'none' },
    );
    expect(r.source).toBe('model');
  });

  it('promotes a sendable message_host_preview to confirm_message_host', () => {
    const r = resolveAssistantAction([
      ok('message_host_preview', {
        listingId: 'l1',
        hostUserId: 'h1',
        hostName: 'Asha',
        draftMessage: 'Is parking available?',
        sendable: true,
      }),
    ]);
    expect(r.source).toBe('message_preview');
    expect(r.action.type).toBe('confirm_message_host');
    expect(r.action.params).toMatchObject({
      listingId: 'l1',
      hostUserId: 'h1',
      message: 'Is parking available?',
      hostName: 'Asha',
    });
  });

  it('promotes toggle_wishlist to wishlist_updated, reading listingType from the call args', () => {
    const r = resolveAssistantAction([
      {
        name: 'toggle_wishlist',
        args: { listingId: 'l1', listingType: 'transport', action: 'add' },
        ok: true,
        result: { ok: true, data: { ok: true, action: 'add', listingId: 'l1' } },
      },
    ]);
    expect(r.source).toBe('wishlist');
    expect(r.action.type).toBe('wishlist_updated');
    expect(r.action.params).toMatchObject({ listingId: 'l1', listingType: 'transport', action: 'add' });
  });

  it('does not render cards when a wishlist save followed an intermediate search', () => {
    const r = resolveAssistantAction([
      ok('search_listings', { results: [{ id: 'l1', title: 'Hotel A', type: 'stay' }] }),
      {
        name: 'toggle_wishlist',
        args: { listingId: 'l1', listingType: 'stay', action: 'add' },
        ok: true,
        result: { ok: true, data: { ok: true, action: 'add', listingId: 'l1' } },
      },
    ]);
    expect(r.source).toBe('wishlist');
  });

  it('promotes get_user_bookings with rows to show_bookings', () => {
    const r = resolveAssistantAction(
      [
        ok('get_user_bookings', {
          bookings: [
            { id: 'bk1', status: 'confirmed', listing: 'Raji Tours', start: '2026-06-10', amount: '₹3,500' },
            { id: 'bk2', status: 'pending', listing: 'Coorg Homestay' },
          ],
          total: 2,
        }),
      ],
      { type: 'view_bookings' },
    );
    expect(r.source).toBe('bookings');
    expect(r.action.type).toBe('show_bookings');
    const params = r.action.params as { bookings: Array<Record<string, unknown>> };
    expect(params.bookings).toHaveLength(2);
    expect(params.bookings[0]).toMatchObject({ id: 'bk1', status: 'confirmed', listing: 'Raji Tours', amount: '₹3,500' });
  });

  it('does not promote show_bookings when there are no bookings (defers to model)', () => {
    const r = resolveAssistantAction([ok('get_user_bookings', { bookings: [], total: 0 })], { type: 'view_bookings' });
    expect(r.source).toBe('model');
    expect(r.action.type).toBe('view_bookings');
  });

  it('does not show a bookings list when a booking modification ran (defers to model)', () => {
    const r = resolveAssistantAction(
      [
        ok('modify_booking', { success: true, operation: 'cancel', bookingId: 'bk1' }),
        ok('get_user_bookings', { bookings: [{ id: 'bk1', status: 'confirmed' }], total: 1 }),
      ],
      { type: 'none' },
    );
    expect(r.source).toBe('model');
  });

  it('promotes filter_marketplace to an apply_filters action (in-place page filtering)', () => {
    const r = resolveAssistantAction([
      ok('filter_marketplace', { category: 'stay', q: 'Coorg', maxPrice: 5000, minRating: 4, propertyTypes: ['Homestay'] }),
    ]);
    expect(r.source).toBe('filter_marketplace');
    expect(r.action.type).toBe('apply_filters');
    expect(r.action.params).toMatchObject({
      category: 'stay',
      filters: { q: 'Coorg', maxPrice: 5000, minRating: 4, categories: ['Homestay'] },
    });
  });

  it('maps service mode + subcategories from filter_marketplace into apply_filters', () => {
    const r = resolveAssistantAction([
      ok('filter_marketplace', { category: 'service', serviceMode: 'at-home', subcategories: ['cleaning'], maxPrice: 1500 }),
    ]);
    expect(r.source).toBe('filter_marketplace');
    expect(r.action.params).toMatchObject({
      category: 'service',
      filters: { serviceMode: 'at-home', subcategories: ['cleaning'], maxPrice: 1500 },
    });
  });

  it('maps transport mode from filter_marketplace into apply_filters', () => {
    const r = resolveAssistantAction([ok('filter_marketplace', { category: 'transport', transportMode: 'day' })]);
    expect(r.action.params).toMatchObject({ category: 'transport', filters: { transportMode: 'day' } });
  });

  it('filter_marketplace wins over an intermediate search_listings in the same turn', () => {
    const r = resolveAssistantAction([
      ok('search_listings', { results: [{ id: 'l1', title: 'A', type: 'stay' }] }),
      ok('filter_marketplace', { category: 'transport', q: 'Hyderabad' }),
    ]);
    expect(r.source).toBe('filter_marketplace');
    expect(r.action.type).toBe('apply_filters');
    expect(r.action.params).toMatchObject({ category: 'transport', filters: { q: 'Hyderabad' } });
  });

  it('promotes get_booking_insights (non-empty) to show_insights', () => {
    const insights = { totalSpent: '₹12,000', totalSpentPaise: 1200000, counts: { upcoming: 1, past: 2, cancelled: 0, total: 3 }, nextTrip: { id: 'b1', listing: 'Raji Tours', date: '2026-07-15', status: 'confirmed' }, empty: false };
    const r = resolveAssistantAction([ok('get_booking_insights', insights)]);
    expect(r.source).toBe('insights');
    expect(r.action.type).toBe('show_insights');
    expect((r.action.params as { insights: unknown }).insights).toMatchObject({ totalSpent: '₹12,000' });
  });

  it('does NOT promote empty insights (model just says "no bookings")', () => {
    const r = resolveAssistantAction([ok('get_booking_insights', { totalSpent: '₹0', counts: { upcoming: 0, past: 0, cancelled: 0, total: 0 }, empty: true })], { type: 'none' });
    expect(r.source).toBe('model');
  });

  it('promotes a successful locate_listing to highlight_listing', () => {
    const r = resolveAssistantAction([
      ok('locate_listing', { success: true, listingId: 'l9', listingType: 'transport', listingName: 'Raji Tours' }),
    ]);
    expect(r.source).toBe('locate_listing');
    expect(r.action.type).toBe('highlight_listing');
    expect(r.action.params).toMatchObject({ listingId: 'l9', listingType: 'transport' });
  });

  it('does not promote a failed locate_listing (defers to model)', () => {
    const r = resolveAssistantAction(
      [ok('locate_listing', { success: false, listingId: 'bad', reason: 'listing_not_found' })],
      { type: 'none' },
    );
    expect(r.source).toBe('model');
  });

  it('ignores failed tool calls when resolving', () => {
    const r = resolveAssistantAction([fail('search_listings', { results: [{ id: 'x', title: 'Y' }] })], { type: 'none' });
    expect(r.source).toBe('model');
  });
});
