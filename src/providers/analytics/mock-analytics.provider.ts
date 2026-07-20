import type { IAnalyticsProvider } from './analytics.interface';
import { frontendConfig } from '@/config/frontend';

export class MockAnalyticsProvider implements IAnalyticsProvider {
  track(event: string, properties?: Record<string, any>): void {
    if (frontendConfig.environment === 'development') {
      console.log(`[Analytics] track: ${event}`, properties);
    }
  }

  identify(userId: string, traits?: Record<string, any>): void {
    if (frontendConfig.environment === 'development') {
      console.log(`[Analytics] identify: ${userId}`, traits);
    }
  }

  page(name: string, properties?: Record<string, any>): void {
    if (frontendConfig.environment === 'development') {
      console.log(`[Analytics] page: ${name}`, properties);
    }
  }
}
