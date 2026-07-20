// @vitest-environment node

import { describe, it, expect, vi } from 'vitest';

// The service pulls in the repository (→ DB). Mock it so we can unit-test the
// pure windowing without a database.
vi.mock('../repositories/admin-metrics.repository.js', () => ({ adminMetricsRepository: {} }));

const { AdminMetricsService } = await import('./admin-metrics.service.js');
const svc = new AdminMetricsService();

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

describe('AdminMetricsService.window', () => {
  it('produces an inclusive N-day window ending today', () => {
    const w = svc.window({ days: 30 });
    expect(w.days).toBe(30);
    expect(daysBetween(w.from, w.to)).toBe(29); // 30 inclusive days spans 29 gaps
  });

  it('clamps trailing days to [1, 400] and defaults invalid input to 30', () => {
    expect(svc.window({ days: 0 }).days).toBe(30);
    expect(svc.window({ days: NaN }).days).toBe(30);
    expect(svc.window({ days: 9999 }).days).toBe(400);
    expect(svc.window({ days: 1 }).days).toBe(1);
    expect(daysBetween(svc.window({ days: 1 }).from, svc.window({ days: 1 }).to)).toBe(0);
  });

  it('honours an explicit from/to calendar range (month/year/FY pickers)', () => {
    const w = svc.window({ from: '2026-04-01', to: '2027-03-31' }); // FY 2026-27
    expect(w.from).toBe('2026-04-01');
    expect(w.to).toBe('2027-03-31');
    expect(w.days).toBe(365);
  });

  it('falls back to days when the range is invalid (from > to)', () => {
    expect(svc.window({ from: '2026-05-10', to: '2026-05-01', days: 7 }).days).toBe(7);
  });
});

describe('AdminMetricsService.previousWindow', () => {
  it('returns the equal-length window ending the day before the current one starts', () => {
    expect(svc.previousWindow({ from: '2026-06-01', to: '2026-06-30', days: 30 }))
      .toEqual({ from: '2026-05-02', to: '2026-05-31', days: 30 });
  });

  it('handles a single-day window', () => {
    expect(svc.previousWindow({ from: '2026-07-09', to: '2026-07-09', days: 1 }))
      .toEqual({ from: '2026-07-08', to: '2026-07-08', days: 1 });
  });

  it('is contiguous: prev.to is exactly one day before range.from across a month boundary', () => {
    const prev = svc.previousWindow(svc.window({ from: '2026-03-01', to: '2026-03-07' }));
    expect(prev).toEqual({ from: '2026-02-22', to: '2026-02-28', days: 7 });
  });
});
