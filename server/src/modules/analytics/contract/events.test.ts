import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANALYTICS_EVENTS,
  BOOKING_FUNNEL,
  EVENT_NAMES,
  EVENT_CONTRACT_VERSION,
  eventSpec,
} from './events.js';

describe('analytics event contract (PUX-014) — server', () => {
  it('exposes a versioned, non-empty registry', () => {
    expect(EVENT_CONTRACT_VERSION).toBeGreaterThanOrEqual(1);
    expect(EVENT_NAMES.length).toBeGreaterThan(10);
    for (const name of EVENT_NAMES) {
      const spec = ANALYTICS_EVENTS[name];
      expect(spec.version).toBeGreaterThanOrEqual(1);
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it('eventSpec returns null for unknown names (drives lenient handling)', () => {
    expect(eventSpec('definitely_not_an_event')).toBeNull();
    expect(eventSpec('booking_confirmed')).not.toBeNull();
  });

  it('per-event prop schemas catch a wrong TYPE but allow extra keys', () => {
    // Wrong type on a known field → rejected (this is what gets logged).
    expect(ANALYTICS_EVENTS.booking_confirmed.props.safeParse({ revenuePaise: '50000' }).success).toBe(false);
    // Correct type + an unknown extra key → accepted (permissive by design).
    expect(
      ANALYTICS_EVENTS.booking_confirmed.props.safeParse({ revenuePaise: 50000, extra: 'ok' }).success,
    ).toBe(true);
    // Events with no load-bearing props accept anything.
    expect(ANALYTICS_EVENTS.card_clicked.props.safeParse({ whatever: 1 }).success).toBe(true);
  });

  it('every declared booking-funnel stage is a known event', () => {
    for (const stage of BOOKING_FUNNEL) expect(EVENT_NAMES).toContain(stage);
  });

  it('every booking-funnel stage is actually handled by the rollup', () => {
    // Ties the DECLARED funnel to its IMPLEMENTATION: if a stage is renamed in
    // the contract but not in the aggregator (or vice-versa), this fails.
    // Resolved from this file, not process.cwd(), so the test passes whether the
    // suite is run from server/ or from the repo root.
    const rollupSrc = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../services/analytics-rollup.ts'),
      'utf8',
    );
    for (const stage of BOOKING_FUNNEL) {
      expect(rollupSrc.includes(`case '${stage}'`), `rollup handles ${stage}`).toBe(true);
    }
  });
});
