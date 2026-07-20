import { useQuery } from "@tanstack/react-query";
import { getPlatformAnalyticsService } from "@/domains/analytics/platform-analytics.service";

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

export const useSupplyOptimization = () => {
  return useQuery({
    queryKey: ["supply-optimization"],
    queryFn: async () => {
      const result = await getPlatformAnalyticsService().getSupplyOptimization();
      if (!result.success || !result.data) {
        throw new Error(result.error || "Failed to load optimization metrics");
      }

      return result.data;
    },
    staleTime: 5 * 60 * 1000, // 5 min cache
  });
};

// Apply search boost to sort services
export const applySearchBoost = (
  services: any[],
  searchBoosts: Record<string, number>,
  sortBy: string
) => {
  if (sortBy !== "Recommended") return services;

  return [...services].sort((a, b) => {
    const boostA = searchBoosts[a.category] || 1.0;
    const boostB = searchBoosts[b.category] || 1.0;
    // Combine rating with boost factor for ranking
    const scoreA = a.rating * boostA + (a.reviews / 100) * boostA;
    const scoreB = b.rating * boostB + (b.reviews / 100) * boostB;
    return scoreB - scoreA;
  });
};
