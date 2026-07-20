import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { ServiceResult } from "@/types/domain";

export interface CategoryMetric {
  id: string;
  category_name: string;
  subcategory: string | null;
  supply_count: number;
  demand_score: number;
  promotion_priority: number;
  is_featured: boolean;
  is_homepage_visible: boolean;
  search_boost_factor: number;
  high_demand_vertical: boolean;
  tags: string[];
}

export interface SupplyOptimizationResult {
  all: CategoryMetric[];
  featured: CategoryMetric[];
  homepageVisible: CategoryMetric[];
  highDemand: CategoryMetric[];
  highSupply: CategoryMetric[];
  searchBoosts: Record<string, number>;
}

export class PlatformAnalyticsService {
  async getSupplyOptimization(): Promise<ServiceResult<SupplyOptimizationResult>> {
    return apiRequest<SupplyOptimizationResult>("/api/supply-optimization", {
      headers: getJsonHeaders(false),
    });
  }
}

let _instance: PlatformAnalyticsService | null = null;

export function getPlatformAnalyticsService() {
  if (!_instance) _instance = new PlatformAnalyticsService();
  return _instance;
}
