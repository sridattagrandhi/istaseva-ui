// @vitest-environment node

/**
 * User-assistant replay harness.
 *
 * Feeds canned LLM responses into the REAL `runAgentLoop` + REAL assistant
 * tools (search_listings with its mode filter and hard availability gate)
 * over a mocked data layer, then asserts on the tool results and the
 * deterministically promoted UI action. Mirrors the onboarding replay
 * harness (../onboarding/__tests__/replay/) and shares its trade-off: the
 * model is stubbed, so this verifies the HARD layers (tool filtering,
 * availability gate, action promotion) and DOCUMENTS the expected model
 * behavior as the canned script — it cannot detect a prompt regression
 * where the live model stops emitting these calls. Those are caught by
 * staging smoke tests; when one slips through, encode the incident here
 * as a new scenario.
 *
 * Seed scenario — the 2026-06-12 "driver 2–5pm on the 15th" incident:
 *   the live agent re-asked the date, pitched a day-rate-only driver for an
 *   hourly ask, and never checked availability. The expected behavior is a
 *   single search call carrying transportPricingMode:'hourly' AND
 *   date:'2026-06-15' — the tool then hard-drops the day-only driver (mode
 *   filter) and the booked-out driver (availability gate), so only genuinely
 *   bookable options can reach the cards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Data-layer mocks (vi.mock factories are hoisted, so the fns must be too) ──
const { searchMock, listPublicMock, overridesMock, roomTypesMock, bookedDatesMock, windowOverlapMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  listPublicMock: vi.fn(),
  overridesMock: vi.fn(),
  roomTypesMock: vi.fn(),
  bookedDatesMock: vi.fn(),
  windowOverlapMock: vi.fn(),
}));

vi.mock('../../../../search/services/search.service.js', () => ({
  searchService: { search: searchMock },
}));
vi.mock('../../../../listings/services/listings.service.js', () => ({
  listingsService: { listPublic: listPublicMock, getById: vi.fn() },
}));
vi.mock('../../../../listings/services/availability-overrides.service.js', () => ({
  availabilityOverridesService: { listForListing: overridesMock },
}));
vi.mock('../../../../listings/repositories/room-types.repository.js', () => ({
  roomTypesRepository: { listForListing: roomTypesMock, getById: vi.fn() },
}));
vi.mock('../../../../bookings/repositories/bookings.repository.js', () => ({
  bookingsRepository: {
    listBookedDatesForListing: bookedDatesMock,
    listActiveBookingsOverlappingWindow: windowOverlapMock,
  },
}));
// recent-hits + chip emission touch Redis/realtime — keep them inert.
vi.mock('../../recent-hits.js', () => ({
  recordRecentHits: vi.fn().mockResolvedValue(undefined),
  readRecentHits: vi.fn().mockResolvedValue([]),
}));

import { runAgentLoop } from '../../agent-loop.js';
import { DEFAULT_TOOLS, TOOLS_BY_NAME } from '../../tools/index.js';
import { resolveAssistantAction } from '../../action-promotion.js';
import type { LlmToolingResult } from '../../../../../common/providers/interfaces/llm-provider.interface.js';
import { StubLlmProvider, nextCallId } from '../../onboarding/__tests__/replay/stub-llm.js';

// ── Fixtures: four Hyderabad drivers ──
const RAJI = 'aaaaaaaa-0000-0000-0000-000000000001';   // hourly+day, free on the 15th
const RAVI = 'aaaaaaaa-0000-0000-0000-000000000002';   // day-rate ONLY
const BUSYW = 'aaaaaaaa-0000-0000-0000-000000000003';  // hourly, HOST-BLOCKED on the 15th → dropped
const PARTT = 'aaaaaaaa-0000-0000-0000-000000000004';  // hourly, one booking that date → must STILL surface ('unknown')

const DRIVERS = [
  {
    id: RAJI, title: "Raji's Van service", listing_type: 'transport', type: 'transport',
    city: 'Hyderabad', location: 'Hyderabad, Telangana',
    metadata: { pricePerHour: 100, pricePerDay: 500 },
  },
  {
    id: RAVI, title: "Ravi's Trips", listing_type: 'transport', type: 'transport',
    city: 'Hyderabad', location: 'Hyderabad, Telangana',
    metadata: { pricePerDay: 2000 },
  },
  {
    id: BUSYW, title: 'Busy Wheels', listing_type: 'transport', type: 'transport',
    city: 'Hyderabad', location: 'Hyderabad, Telangana',
    metadata: { pricePerHour: 150 },
  },
  {
    id: PARTT, title: 'Part-Time Wheels', listing_type: 'transport', type: 'transport',
    city: 'Hyderabad', location: 'Hyderabad, Telangana',
    metadata: { pricePerHour: 120 },
  },
];

function toolCallResponse(calls: Array<{ name: string; args: Record<string, unknown> }>): LlmToolingResult {
  return { toolCalls: calls.map((c) => ({ id: nextCallId(c.name), name: c.name, args: c.args })) };
}

function finalText(message: string): LlmToolingResult {
  return {
    toolCalls: [],
    text: JSON.stringify({ message, action: { type: 'none', params: {} }, suggestions: [] }),
  };
}

function makeCtx() {
  return {
    userId: 'test-user',
    userRole: 'guest',
    displayLang: 'en',
    requestId: 'test-req',
    abortSignal: new AbortController().signal,
    toolResultCache: new Map(),
  } as any;
}

async function runScenario(responses: LlmToolingResult[]) {
  const llm = new StubLlmProvider(responses);
  return runAgentLoop({
    llm: llm as any,
    systemPrompt: 'test prompt',
    initialTurns: [{ role: 'user', content: 'I need a driver from 2pm to 5pm on the 15th, pickup in Charminar, Hyderabad' }],
    tools: DEFAULT_TOOLS,
    toolsByName: TOOLS_BY_NAME,
    ctx: makeCtx(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  searchMock.mockResolvedValue({ data: DRIVERS });
  listPublicMock.mockResolvedValue({ data: DRIVERS });
  // Busy Wheels is HOST-BLOCKED on the 15th — whole-day truth, gate drops it.
  overridesMock.mockImplementation(async (listingId: string) => ({
    data: listingId === BUSYW ? [{ date: '2026-06-15', blocked: true, room_type_id: null }] : [],
  }));
  roomTypesMock.mockResolvedValue({ rows: [] });           // transport: no rooms
  // Part-Time Wheels has ONE booking that date. For no-room listings the repo
  // marks the whole DATE booked — which must NOT hide an hourly driver whose
  // other hours are free (the 2026-06-12 "no drivers available" bug).
  bookedDatesMock.mockImplementation(async (listingId: string) => ({
    rows: listingId === PARTT ? [{ date: '2026-06-15' }] : [],
  }));
  // Window-level overlap (the hard snip). Part-Time Wheels' single booking
  // that date is 9–11 AM — it does NOT overlap a 2–5 PM request, so the
  // window check returns no conflict. Override per-test for the taken case.
  windowOverlapMock.mockResolvedValue({ rows: [] });
});

describe('assistant replay — driver 2–5pm on the 15th', () => {
  it('mode filter + availability gate leave only the bookable hourly driver, promoted to cards', async () => {
    const result = await runScenario([
      // Expected model behavior (encoded, not tested): one search carrying
      // the implied hourly mode AND the resolved date — no date re-ask.
      toolCallResponse([{
        name: 'search_listings',
        args: { category: 'transport', location: 'Hyderabad', transportPricingMode: 'hourly', date: '2026-06-15' },
      }]),
      // NOTE: quotes only the tool-surfaced rate (₹100/hr). A computed total
      // ("₹300") would trip the grounding check — by design, totals must come
      // from get_booking_price_preview, not model arithmetic.
      finalText("Raji's Van service is free 2–5pm on June 15 at ₹100/hr. One other hourly driver was already booked that day. Want me to price it?"),
    ]);

    // One search call, succeeded.
    expect(result.toolCalls).toHaveLength(1);
    const call = result.toolCalls[0];
    expect(call.name).toBe('search_listings');
    expect(call.ok).toBe(true);

    const data = (call.result as { data: any }).data;
    // Ravi (day-only) dropped by the MODE filter; Busy Wheels (host-blocked)
    // by the availability gate. Raji survives verified-free; Part-Time Wheels
    // (one booking that date) survives as 'unknown' — a date-level booking on
    // a no-rooms listing must NOT hide a driver whose other hours are free.
    const byId = Object.fromEntries(data.results.map((r: any) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual([RAJI, PARTT].sort());
    expect(byId[RAJI].availability).toBe('free');
    expect(byId[RAJI].availableModes).toContain('hourly');
    expect(byId[PARTT].availability).toBe('unknown');
    expect(data.checkedDate).toBe('2026-06-15');
    expect(data.unavailableDroppedCount).toBe(1);

    // Promotion ships exactly the surviving hits as inline cards.
    const { action } = resolveAssistantAction(result.toolCalls);
    expect(action.type).toBe('show_listing_cards');
    const hits = (action.params as { hits: Array<{ id: string }> }).hits;
    expect(hits.map((h) => h.id).sort()).toEqual([RAJI, PARTT].sort());
  });

  it('HARD SNIP: a driver booked for the requested window is dropped before the model can suggest it', async () => {
    // The reported bug: Raji's is booked 9 AM–5 PM on the 15th, yet the agent
    // offered it for a 2–5 PM ask. With startTime/endTime passed, the window
    // gate runs the hold's overlap predicate and drops Raji entirely — it
    // never reaches the cards, so it can't be suggested.
    windowOverlapMock.mockImplementation(async (listingId: string) => ({
      rows: listingId === RAJI ? [{ id: 'existing-9to5' }] : [],
    }));
    const result = await runScenario([
      toolCallResponse([{
        name: 'search_listings',
        args: {
          category: 'transport', location: 'Hyderabad', transportPricingMode: 'hourly',
          date: '2026-06-15', startTime: '14:00', endTime: '17:00',
        },
      }]),
      finalText('Part-Time Wheels is open for 2–5 PM on June 15. Want me to check the price?'),
    ]);

    const data = (result.toolCalls[0].result as { data: any }).data;
    const ids = data.results.map((r: any) => r.id);
    expect(ids).not.toContain(RAJI);   // booked 2–5pm → dropped, never suggestible
    expect(ids).not.toContain(BUSYW);  // host-blocked → dropped
    expect(ids).not.toContain(RAVI);   // day-only → mode filter
    expect(ids).toContain(PARTT);      // free for the window → 'free'
    expect(data.results.find((r: any) => r.id === PARTT).availability).toBe('free');
    // Two dropped by the gate: Raji (window booked) + Busy Wheels (host-block).
    // Ravi was dropped earlier by the mode filter, which isn't an availability drop.
    expect(data.unavailableDroppedCount).toBe(2);

    // The promoted cards likewise cannot contain the booked driver.
    const { action } = resolveAssistantAction(result.toolCalls);
    const hits = (action.params as { hits: Array<{ id: string }> }).hits;
    expect(hits.map((h) => h.id)).toEqual([PARTT]);
  });

  it('WHOLE-DAY modes: a vehicle with any booking that date is dropped for a day rental', async () => {
    // Day/package need the entire day free, so ANY booking that date makes the
    // vehicle unavailable — unlike hourly, where a morning ride leaves the
    // afternoon open. Part-Time Wheels has a booking on the 15th; a day-rate
    // search must drop it (busy), whereas the hourly search above kept it.
    const result = await runScenario([
      toolCallResponse([{
        name: 'search_listings',
        args: { category: 'transport', location: 'Hyderabad', transportPricingMode: 'day', date: '2026-06-15' },
      }]),
      finalText('Raji\'s Van service is open for a full-day rental on June 15.'),
    ]);
    const data = (result.toolCalls[0].result as { data: any }).data;
    const ids = data.results.map((r: any) => r.id);
    // Ravi is day-capable here (₹2000/day) so the mode filter KEEPS it; it has
    // no booking that date → free. Part-Time Wheels (booked that date) → dropped.
    // Raji (day-capable, free) → kept. Busy Wheels (hourly-only) → mode-filtered.
    expect(ids).not.toContain(PARTT);
    expect(ids).not.toContain(BUSYW);
    expect(ids.sort()).toEqual([RAJI, RAVI].sort());
  });

  it('without a date arg the gate is off — busy listings still surface (documented opt-in)', async () => {
    const result = await runScenario([
      toolCallResponse([{
        name: 'search_listings',
        args: { category: 'transport', location: 'Hyderabad', transportPricingMode: 'hourly' },
      }]),
      finalText('Found a couple of hourly drivers in Hyderabad.'),
    ]);

    const data = (result.toolCalls[0].result as { data: any }).data;
    // Mode filter still applies (Ravi gone), but Busy Wheels is back because
    // no date was given to check against — and nothing claims it's free.
    expect(data.results.map((r: any) => r.id).sort()).toEqual([RAJI, BUSYW, PARTT].sort());
    expect(data.results.every((r: any) => r.availability === undefined)).toBe(true);
    expect(data.unavailableDroppedCount).toBeUndefined();
  });

  it('promotion drops a busy-annotated row even if a tool ever ships one', async () => {
    // Defense-in-depth unit check on the promotion layer itself.
    const { action } = resolveAssistantAction([{
      name: 'search_listings',
      args: {},
      ok: true,
      result: {
        ok: true,
        data: {
          results: [
            { id: RAJI, title: "Raji's Van service", type: 'transport', availability: 'free' },
            { id: BUSYW, title: 'Busy Wheels', type: 'transport', availability: 'busy' },
          ],
          count: 2,
        },
      },
    }]);
    expect(action.type).toBe('show_listing_cards');
    const hits = (action.params as { hits: Array<{ id: string }> }).hits;
    expect(hits.map((h) => h.id)).toEqual([RAJI]);
  });
});
