/**
 * Pricing Domain Service
 */

import type { DemandLevel, PricingConfig, ServiceResult } from "@/types/domain";

export class PricingService {
  async getConfig(_serviceCategory: string): Promise<ServiceResult<PricingConfig | null>> {
    return { success: true, data: null };
  }

  calculatePrice(basePrice: number, config: PricingConfig, demandLevel: DemandLevel): number {
    const demandMultiplier = config.demandMultipliers[demandLevel] || 1;
    const price = basePrice * demandMultiplier;
    const bounded = Math.max(config.minPrice, config.maxPrice ? Math.min(price, config.maxPrice) : price);
    return Math.round(bounded);
  }
}

let _instance: PricingService | null = null;
export function getPricingService(): PricingService {
  if (!_instance) _instance = new PricingService();
  return _instance;
}
