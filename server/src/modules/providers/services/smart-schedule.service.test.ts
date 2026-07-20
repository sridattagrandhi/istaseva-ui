// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { dayOfWeekForYmd } from './smart-schedule.service.js';

/**
 * Regression coverage for the IST-vs-UTC weekday bug: when the chat agent
 * resolves "May 27" against the IST-anchored date in its system prompt and
 * hands us "2026-05-27", the smart-schedule service used to call
 * `new Date('2026-05-27T00:00:00').getDay()`. On a UTC-hosted process that
 * returned the previous day's weekday, so the provider lookup ran against
 * the wrong column of `working_hours` and the assistant replied "no
 * availability" even when a Wednesday slot existed.
 */
describe('dayOfWeekForYmd', () => {
  it('returns 3 (Wednesday) for 2026-05-27', () => {
    expect(dayOfWeekForYmd('2026-05-27')).toBe(3);
  });

  it('returns 4 (Thursday) for 2026-05-28', () => {
    expect(dayOfWeekForYmd('2026-05-28')).toBe(4);
  });

  it('returns 0 (Sunday) for 2026-05-24', () => {
    expect(dayOfWeekForYmd('2026-05-24')).toBe(0);
  });

  it('returns 6 (Saturday) for 2026-05-23', () => {
    expect(dayOfWeekForYmd('2026-05-23')).toBe(6);
  });

  it('is stable against the host TZ — does not depend on `new Date(str).getDay()`', () => {
    // Cross-checking against the same computation produces consistent
    // results regardless of the local TZ in which the test runs. The
    // historical implementation `new Date('YYYY-MM-DDT00:00:00').getDay()`
    // diverges by 1 between UTC and IST hosts; this helper never does.
    for (const ymd of ['2025-01-01', '2026-05-27', '2026-12-31', '2027-02-28']) {
      const fromHelper = dayOfWeekForYmd(ymd);
      const [y, m, d] = ymd.split('-').map(Number);
      const fromUtcRef = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      expect(fromHelper).toBe(fromUtcRef);
    }
  });
});
