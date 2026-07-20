import { getEventProvider } from '../../../common/providers/registry.js';
import { logger } from '../../../common/logging/logger.js';
import { analyticsRollupRepository } from '../repositories/analytics-rollup.repository.js';
import { aggregateDailyMetrics, type RollupEvent } from './analytics-rollup.js';

export class AnalyticsRollupService {
  /**
   * Read one UTC calendar day of raw events from DynamoDB, aggregate them, and
   * write the rollup tables. Returns the number of events processed.
   */
  async rollupDay(date: string): Promise<{ date: string; events: number }> {
    const provider = await getEventProvider();
    const events = await provider.queryByDate<RollupEvent & { timestamp: string; userId: string }>(
      'analytics_events',
      date,
    );
    const aggregate = aggregateDailyMetrics(events as RollupEvent[]);
    await analyticsRollupRepository.writeDailyRollup(date, aggregate);

    // Event-derived customer-profile columns (language / home city /
    // last-active day) from the same in-memory day of events — no second
    // DynamoDB scan. Last observation in the day wins; the upsert COALESCEs
    // so a day without a field never erases an earlier observation.
    const activity = new Map<string, { language: string | null; originCity: string | null }>();
    for (const e of events) {
      if (!e.userId || e.userId === 'anonymous' || e.userId === 'system') continue;
      const row = activity.get(e.userId) ?? { language: null, originCity: null };
      if (typeof e.language === 'string' && e.language) row.language = e.language.toLowerCase();
      if (typeof e.originCity === 'string' && e.originCity.trim()) row.originCity = e.originCity.trim();
      activity.set(e.userId, row);
    }
    if (activity.size > 0) {
      await analyticsRollupRepository.upsertCustomerActivity(
        Array.from(activity.entries()).map(([userId, v]) => ({ userId, language: v.language, originCity: v.originCity, day: date })),
      );
    }

    return { date, events: events.length };
  }

  /**
   * Nightly batch entrypoint. Rolls up yesterday (the last complete day) and
   * today (partial, so the dashboard isn't a full day behind). Both are
   * idempotent, so re-running is safe.
   */
  async runDailyRollup(): Promise<void> {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
    for (const day of [yesterday, today]) {
      const result = await this.rollupDay(day);
      logger.info('Analytics rollup complete', { day: result.date, events: result.events });
    }
    // Booking-derived customer profile stats (RFM) from Postgres — once per
    // run, after the event days, so event-derived and booking-derived columns
    // land together. Recomputed wholesale; idempotent.
    try {
      await analyticsRollupRepository.refreshCustomerBookingStats();
      logger.info('Customer booking stats refreshed');
    } catch (err) {
      logger.warn('Customer booking stats refresh failed', { err: String(err) });
    }
  }
}

export const analyticsRollupService = new AnalyticsRollupService();
