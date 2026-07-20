// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findSlots = vi.fn();

vi.mock('../../../providers/services/smart-schedule.service.js', () => ({
  smartScheduleService: { findSlots },
}));

vi.mock('../../../../common/logging/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const baseCtx = {
  userId: 'u1',
  displayLang: 'en',
  requestId: 'req-1',
  abortSignal: new AbortController().signal,
  toolResultCache: new Map(),
} as any;

describe('findAvailableSlotsTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps smart-schedule slots into the tool result shape', async () => {
    const { findAvailableSlotsTool } = await import('./find-available-slots.tool.js');
    findSlots.mockResolvedValue({
      slots: [
        { provider_id: 'p1', provider_name: 'Aman', start_time: '10:00', end_time: '11:00', estimated_travel_minutes: 12, distance_km: 4.2 },
        { provider_id: 'p2', provider_name: 'Sita', start_time: '13:00', end_time: '14:00', estimated_travel_minutes: 18, distance_km: 7.5 },
      ],
      totalProviders: 2,
    });

    const result = await findAvailableSlotsTool.execute({
      serviceCategory: 'cleaning',
      preferredDate: '2026-05-15',
      durationMinutes: 60,
    }, baseCtx);

    expect(result.slots).toHaveLength(2);
    expect(result.slots[0]).toEqual({
      providerId: 'p1', providerName: 'Aman', startTime: '10:00', endTime: '11:00', travelMinutes: 12, distanceKm: 4.2,
    });
    expect(result.totalProviders).toBe(2);
    expect(result.topSlots).toHaveLength(2);
  });

  it('caps topSlots to 3', async () => {
    const { findAvailableSlotsTool } = await import('./find-available-slots.tool.js');
    findSlots.mockResolvedValue({
      slots: Array.from({ length: 5 }, (_, i) => ({
        provider_id: `p${i}`, provider_name: `P${i}`, start_time: '10:00', end_time: '11:00',
        estimated_travel_minutes: 5, distance_km: 1,
      })),
      totalProviders: 5,
    });
    const result = await findAvailableSlotsTool.execute({
      serviceCategory: 'cleaning', preferredDate: '2026-05-15', durationMinutes: 60,
    }, baseCtx);
    expect(result.topSlots).toHaveLength(3);
    expect(result.slots).toHaveLength(5);
  });

  it('degrades to an empty result when smart-schedule throws', async () => {
    const { findAvailableSlotsTool } = await import('./find-available-slots.tool.js');
    findSlots.mockRejectedValue(new Error('db down'));
    const result = await findAvailableSlotsTool.execute({
      serviceCategory: 'cleaning', preferredDate: '2026-05-15', durationMinutes: 60,
    }, baseCtx);
    expect(result).toEqual({ slots: [], totalProviders: 0, topSlots: [] });
  });
});
