/**
 * Fraud / Risk Domain Service
 *
 * Captures risk signals and fraud events.
 */

import type { FraudEvent, RiskLevel, UUID } from '@/types/domain';
import { getAnalyticsProvider } from '@/config/providers';
import { apiRequest, getJsonHeaders } from '@/lib/api-client';

export class FraudService {
  private analytics = getAnalyticsProvider();

  // Keep a lightweight local trail for debug surfaces without making it the source of truth.
  private events: FraudEvent[] = [];

  /** Log a fraud/risk event */
  async logEvent(params: {
    userId?: UUID;
    eventType: string;
    riskLevel: RiskLevel;
    metadata?: Record<string, any>;
  }): Promise<void> {
    const event: FraudEvent = {
      id: `fraud_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      userId: params.userId,
      eventType: params.eventType,
      riskLevel: params.riskLevel,
      metadata: params.metadata || {},
      createdAt: new Date().toISOString(),
    };

    this.events.push(event);
    this.analytics.track('fraud_event', {
      eventType: params.eventType,
      riskLevel: params.riskLevel,
    });

    await apiRequest('/api/fraud/signals', {
      method: 'POST',
      headers: getJsonHeaders(),
      body: JSON.stringify({
        eventType: params.eventType,
        riskLevel: params.riskLevel,
        metadata: params.metadata || {},
      }),
    });

    if (params.riskLevel === 'critical') {
      console.error('[FRAUD] Critical risk event:', event);
    }
  }

  /** Capture browser metadata for risk scoring */
  captureBrowserMetadata(): Record<string, any> {
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      screenResolution: `${screen.width}x${screen.height}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cookiesEnabled: navigator.cookieEnabled,
      timestamp: new Date().toISOString(),
    };
  }

  /** Get events (for admin/debugging) */
  getEvents(): FraudEvent[] {
    return [...this.events];
  }
}

let _instance: FraudService | null = null;
export function getFraudService(): FraudService {
  if (!_instance) _instance = new FraudService();
  return _instance;
}
