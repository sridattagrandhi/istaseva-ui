import { cacheGet, cacheSet } from '../../../common/cache/redis.js';
import { dbQuery } from '../../../common/repositories/database.js';

export class SupplyOptimizationService {
  async getMetrics() {
    const cached = await cacheGet<any>('supply:metrics');
    if (cached) return cached;

    let categories: any[] = [];
    try {
      const result = await dbQuery('SELECT * FROM service_category_metrics ORDER BY promotion_priority DESC');
      categories = result.rows;
    } catch (error: any) {
      if (error?.code !== '42P01') {
        throw error;
      }
    }

    const response = {
      all: categories,
      featured: categories.filter((category: any) => category.is_featured),
      homepageVisible: categories.filter((category: any) => category.is_homepage_visible),
      highDemand: categories.filter((category: any) => category.high_demand_vertical),
      highSupply: categories.filter((category: any) => category.supply_count >= 200),
      searchBoosts: Object.fromEntries(
        categories.map((category: any) => [category.category_name, category.search_boost_factor])
      ),
    };

    await cacheSet('supply:metrics', response, 300);
    return response;
  }

  async recalculateMetrics() {
    const supplyResult = await dbQuery(`
      SELECT unnest(service_categories) as category, COUNT(*) as count
      FROM provider_profiles
      WHERE is_available = true
      GROUP BY category
    `);

    const demandResult = await dbQuery(`
      SELECT service_category as category, COUNT(*) as count
      FROM bookings
      WHERE created_at > NOW() - INTERVAL '30 days'
        AND status != 'cancelled'
      GROUP BY service_category
    `);

    const maxDemand = Math.max(...demandResult.rows.map((row: any) => parseInt(row.count, 10)), 1);
    const supply = Object.fromEntries(supplyResult.rows.map((row: any) => [row.category, parseInt(row.count, 10)]));
    const demand = Object.fromEntries(demandResult.rows.map((row: any) => [row.category, parseInt(row.count, 10)]));
    const allCategories = new Set([...Object.keys(supply), ...Object.keys(demand)]);

    for (const category of allCategories) {
      const s = supply[category] || 0;
      const d = demand[category] || 0;
      const demandScore = Math.round((d / maxDemand) * 100);
      const searchBoost = Math.min(2.0, 1.0 + s / 500 + d / 200);
      const promotionPriority = Math.round(s * 0.3 + d * 0.7);

      await dbQuery(`
        INSERT INTO service_category_metrics (category_name, supply_count, demand_score, search_boost_factor, promotion_priority, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (category_name) DO UPDATE SET
          supply_count = $2, demand_score = $3, search_boost_factor = $4, promotion_priority = $5, updated_at = NOW()
      `, [category, s, demandScore, searchBoost, promotionPriority]);
    }

    return { success: true, message: 'Metrics recalculated' };
  }
}

export const supplyOptimizationService = new SupplyOptimizationService();
