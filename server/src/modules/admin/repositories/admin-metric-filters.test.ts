// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  EMPTY_METRIC_FILTER,
  buildMetricFilter,
  metricFilterActive,
  type MetricListingFilter,
} from './admin-metric-filters.js';

const filter = (over: Partial<MetricListingFilter> = {}): MetricListingFilter => ({
  ...EMPTY_METRIC_FILTER,
  ...over,
});

describe('metricFilterActive', () => {
  it('is false for the empty filter and true once any dimension is set', () => {
    expect(metricFilterActive(EMPTY_METRIC_FILTER)).toBe(false);
    expect(metricFilterActive(filter({ types: ['stay'] }))).toBe(true);
    expect(metricFilterActive(filter({ categories: ['salon'] }))).toBe(true);
    expect(metricFilterActive(filter({ states: ['Kerala'] }))).toBe(true);
    expect(metricFilterActive(filter({ cities: ['Kochi'] }))).toBe(true);
    expect(metricFilterActive(filter({ listingId: 'abc' }))).toBe(true);
  });
});

describe('buildMetricFilter', () => {
  it('returns an empty clause + no params when nothing is set', () => {
    const { sql, params } = buildMetricFilter(EMPTY_METRIC_FILTER, 2);
    expect(sql).toBe('');
    expect(params).toEqual([]);
  });

  it('binds params after `start`, lowercases values, and matches the ops-screen semantics', () => {
    const { sql, params } = buildMetricFilter(
      filter({ types: ['Stay'], categories: ['Salon'], states: ['Karnataka', ' TELANGANA '], cities: ['Bengaluru'], listingId: 'L-1' }),
      2,
      { categoryExpr: 'COALESCE(b.service_category, l.category)' },
    );
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain('AND lower(l.listing_type) = ANY($3)');
    expect(flat).toContain('AND lower(btrim(COALESCE(b.service_category, l.category))) = ANY($4)');
    expect(flat).toContain('AND lower(btrim(l.state)) = ANY($5)');
    expect(flat).toContain('AND lower(btrim(l.city)) = ANY($6)');
    expect(flat).toContain('AND l.id::text = $7');
    expect(params).toEqual([['stay'], ['salon'], ['karnataka', 'telangana'], ['bengaluru'], 'L-1']);
  });

  it('defaults the category match to l.category and offsets param indexes by `start`', () => {
    const { sql, params } = buildMetricFilter(filter({ categories: ['plumbing'] }), 4);
    expect(sql.replace(/\s+/g, ' ')).toContain('AND lower(btrim(l.category)) = ANY($5)');
    expect(params).toEqual([['plumbing']]);
  });
});
