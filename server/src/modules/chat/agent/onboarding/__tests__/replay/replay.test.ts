/**
 * Onboarding-agent replay harness.
 *
 * Feeds canned LLM responses into the real `runAgentLoop` + real
 * onboarding tools (extract_fields, submit_listing, ...) and asserts
 * on the resulting toolCalls + final profile. This catches regressions
 * in the registry-driven schema/normalization/submit-gate plumbing —
 * NOT regressions in what the Gemini model would actually emit. See
 * stub-llm.ts for the trade-off rationale.
 *
 * Six scenarios cover the design's hard-set invariants:
 *   1. Salon — single service with inline add-ons (single extract_fields
 *      call collects base + every add-on).
 *   2. Salon — multiple bookable services (one extract_fields call,
 *      multi-group catalog).
 *   3. Mid-conversation correction — re-emit FULL catalog overwrites
 *      cleanly.
 *   4. Submit blocked when servicesCatalog is empty for services.
 *   5. Submit allowed when everything required is filled.
 *   6. Transport multi-vehicle — transportationTypes[] with multiple
 *      entries.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runAgentLoop } from '../../../agent-loop.js';
import { ONBOARDING_TOOLS, ONBOARDING_TOOLS_BY_NAME } from '../../tools/index.js';
import type { OnboardingAgentContext, OnboardingProfileState } from '../../types.js';
import type { LlmToolingResult } from '../../../../../../common/providers/interfaces/llm-provider.interface.js';
import { StubLlmProvider, nextCallId } from './stub-llm.js';

function makeCtx(profile: Partial<OnboardingProfileState> = {}): OnboardingAgentContext {
  return {
    userId: 'test-user',
    userRole: 'host',
    displayLang: 'en',
    requestId: 'test-req',
    abortSignal: new AbortController().signal,
    toolResultCache: new Map(),
    profile: profile as OnboardingProfileState,
    pickerAction: 'none',
  };
}

/** Build a `generateWithTools` response with one or more tool calls. */
function toolCallResponse(calls: Array<{ name: string; args: Record<string, unknown> }>): LlmToolingResult {
  return {
    toolCalls: calls.map((c) => ({ id: nextCallId(c.name), name: c.name, args: c.args })),
  };
}

/** Build a `generateWithTools` response with the final JSON-text reply. */
function finalText(reply: { message: string; action?: string; is_complete?: boolean }): LlmToolingResult {
  return {
    toolCalls: [],
    text: JSON.stringify({
      message: reply.message,
      action: reply.action ?? 'none',
      is_complete: reply.is_complete ?? false,
    }),
  };
}

async function runScenario(
  responses: LlmToolingResult[],
  ctx: OnboardingAgentContext,
) {
  const llm = new StubLlmProvider(responses);
  return runAgentLoop({
    llm,
    systemPrompt: 'test prompt',
    initialTurns: [{ role: 'user', content: 'stub user message' }],
    tools: ONBOARDING_TOOLS,
    toolsByName: ONBOARDING_TOOLS_BY_NAME,
    ctx,
  });
}

beforeEach(() => {
  // No-op — the stub id counter is monotonic across tests, which is
  // fine; ids only need to be unique within a single LLM exchange.
});

describe('onboarding-agent replay', () => {
  it('salon — single service with inline add-ons → one group, two add-ons', async () => {
    const ctx = makeCtx();
    const result = await runScenario([
      toolCallResponse([{
        name: 'extract_fields',
        args: {
          category: 'salon',
          name: 'Smart Cuts',
          location: 'Banjara Hills, Hyderabad',
          serviceModes: ['visit-provider'],
          visitAddress: 'Shop 3, Banjara Hills Road No 5, Hyderabad 500034',
          pricingUnit: 'per_visit',
          duration: '1 hour',
          experience: '5 years',
          servicesCatalog: [{
            name: "Men's Haircut",
            basePrice: 500,
            addOns: [
              { label: 'Beard trim', price: 100 },
              { label: 'Shaving', price: 80 },
            ],
          }],
        },
      }]),
      finalText({ message: 'Got it.' }),
    ], ctx);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('extract_fields');
    expect(result.toolCalls[0].ok).toBe(true);
    expect(ctx.profile.servicesCatalog).toHaveLength(1);
    const group = ctx.profile.servicesCatalog![0];
    expect(group.name).toBe("Men's Haircut");
    expect(group.basePrice).toBe(500);
    expect(group.addOns).toHaveLength(2);
    expect(group.addOns.map((a) => a.label)).toEqual(['Beard trim', 'Shaving']);
    // Every group + add-on must have a stable id after normalization.
    expect(group.id).toBeTruthy();
    for (const a of group.addOns) expect(a.id).toBeTruthy();
  });

  it('salon — multi-service → three groups, correct add-ons per group', async () => {
    const ctx = makeCtx();
    const result = await runScenario([
      toolCallResponse([{
        name: 'extract_fields',
        args: {
          category: 'salon',
          name: 'Smart Cuts',
          location: 'Banjara Hills, Hyderabad',
          servicesCatalog: [
            { name: "Men's Haircut", basePrice: 500, addOns: [{ label: 'Beard trim', price: 100 }] },
            { name: "Women's Haircut", basePrice: 1200, addOns: [] },
            { name: 'Nail art', basePrice: 800, addOns: [{ label: 'Gel polish', price: 200 }] },
          ],
        },
      }]),
      finalText({ message: 'Three services captured.' }),
    ], ctx);

    expect(result.toolCalls[0].ok).toBe(true);
    expect(ctx.profile.servicesCatalog).toHaveLength(3);
    expect(ctx.profile.servicesCatalog!.map((g) => g.name)).toEqual([
      "Men's Haircut", "Women's Haircut", 'Nail art',
    ]);
    expect(ctx.profile.servicesCatalog![1].addOns).toHaveLength(0);
    expect(ctx.profile.servicesCatalog![2].addOns[0].label).toBe('Gel polish');
  });

  it('mid-conversation correction — re-emitting full catalog overwrites cleanly', async () => {
    const ctx = makeCtx({
      category: 'salon',
      servicesCatalog: [
        { id: 'svc-1', name: "Men's Haircut", basePrice: 500, addOns: [] },
        { id: 'svc-2', name: "Women's Haircut", basePrice: 1200, addOns: [] },
      ],
    });
    const result = await runScenario([
      toolCallResponse([{
        name: 'extract_fields',
        args: {
          // Model re-emits FULL list with the corrected women's price.
          servicesCatalog: [
            { name: "Men's Haircut", basePrice: 500, addOns: [] },
            { name: "Women's Haircut", basePrice: 1500, addOns: [] },
          ],
        },
      }]),
      finalText({ message: 'Updated.' }),
    ], ctx);

    expect(result.toolCalls[0].ok).toBe(true);
    expect(ctx.profile.servicesCatalog).toHaveLength(2);
    expect(ctx.profile.servicesCatalog![1].basePrice).toBe(1500);
    // Men's price unchanged.
    expect(ctx.profile.servicesCatalog![0].basePrice).toBe(500);
  });

  it('submit_listing blocked when servicesCatalog is empty for a service listing', async () => {
    const ctx = makeCtx({
      category: 'plumber',
      name: 'Ravi',
      location: 'Hyderabad',
      experience: '5 years',
      duration: '1 hour',
      pricingUnit: 'per_visit',
      serviceModes: ['at-home'],
      serviceRadius: 5,
      // NO servicesCatalog, no legacy price.
    });
    const result = await runScenario([
      toolCallResponse([{ name: 'submit_listing', args: {} }]),
      // Loop will feed the tool error back as a tool response, then
      // give the model a chance to react. We send the final text on
      // the second LLM call.
      finalText({ message: "I still need your services catalog before we can review." }),
    ], ctx);

    // submit_listing ran and FAILED — that's a tool_error from the
    // gate. The loop captures ok:false, the model recovers.
    const submitCall = result.toolCalls.find((t) => t.name === 'submit_listing');
    expect(submitCall).toBeDefined();
    expect(submitCall!.ok).toBe(false);
    // The agent's createdListingId marker is NOT set — the gate
    // rejected the flip.
    expect(ctx.createdListingId).toBeUndefined();
  });

  it('submit_listing succeeds when everything required is filled', async () => {
    const ctx = makeCtx({
      category: 'salon',
      name: 'Smart Cuts',
      location: 'Banjara Hills, Hyderabad',
      description: 'Walk-in salon offering haircuts, beard trims, and styling.',
      experience: '5 years',
      duration: '1 hour',
      pricingUnit: 'per_visit',
      languages: ['English', 'Hindi'],
      serviceModes: ['visit-provider'],
      visitAddress: 'Shop 3, Banjara Hills Road No 5, Hyderabad 500034',
      servicesCatalog: [{
        id: 'svc-1',
        name: "Men's Haircut",
        basePrice: 500,
        addOns: [{ id: 'addon-1', label: 'Beard trim', price: 100 }],
      }],
      workingHours: {
        mon: ['09:00', '20:00'], tue: ['09:00', '20:00'], wed: ['09:00', '20:00'],
        thu: ['09:00', '20:00'], fri: ['09:00', '20:00'], sat: ['09:00', '20:00'],
        sun: null,
      },
    });
    const result = await runScenario([
      toolCallResponse([{ name: 'submit_listing', args: {} }]),
      finalText({ message: 'Opening the preview.', is_complete: true }),
    ], ctx);

    const submitCall = result.toolCalls.find((t) => t.name === 'submit_listing');
    expect(submitCall).toBeDefined();
    expect(submitCall!.ok).toBe(true);
    expect(ctx.createdListingId).toBe('__pending_preview__');
  });

  it('transport multi-vehicle — transportationTypes[] with multiple entries persists intact', async () => {
    const ctx = makeCtx();
    const result = await runScenario([
      toolCallResponse([{
        name: 'extract_fields',
        args: {
          category: 'driver-cab',
          name: 'Ravi Travels',
          location: 'Coorg',
          experience: '8 years',
          serviceRadius: 25,
          transportMode: 'package',
          packageOptions: [{
            label: 'Coorg loop', price: 3500, hours: 8,
            stops: [{ place: 'Abbey Falls' }, { place: 'Coffee estate' }],
            distanceKmMin: 80, distanceKmMax: 100,
          }],
          transportationTypes: [
            {
              type: 'sedan_cab',
              details: { vehicleName: 'Maruti Swift Dzire', basePrice: 100, seatingCapacity: 4, acAvailable: true },
            },
            {
              type: 'tempo_traveller',
              details: { vehicleName: 'Force Tempo', basePrice: 200, seatingCapacity: 12, acAvailable: true },
            },
          ],
        },
      }]),
      finalText({ message: 'Two vehicles captured.' }),
    ], ctx);

    expect(result.toolCalls[0].ok).toBe(true);
    expect(ctx.profile.transportationTypes).toHaveLength(2);
    expect(ctx.profile.transportationTypes!.map((t) => t.type)).toEqual([
      'sedan_cab', 'tempo_traveller',
    ]);
  });
});
