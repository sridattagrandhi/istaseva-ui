/**
 * Mixpanel Analytics Provider
 *
 * Production analytics using Mixpanel.
 * Can be swapped for Amplitude, Segment, or custom analytics.
 *
 * Setup:
 * 1. Create Mixpanel project
 * 2. Set VITE_MIXPANEL_TOKEN in .env
 * 3. Swap in src/config/providers.ts: getAnalyticsProvider() → new MixpanelAnalyticsProvider()
 */

import type { IAnalyticsProvider } from './analytics.interface';
import { frontendConfig } from '@/config/frontend';
import { hasTrackingConsent, onTrackingConsentChange } from '@/lib/tracking-consent';

export class MixpanelAnalyticsProvider implements IAnalyticsProvider {
  private token: string;
  private apiUrl = 'https://api.mixpanel.com';
  private queue: Array<{ type: string; data: any }> = [];
  private flushInterval: number;

  constructor() {
    this.token = frontendConfig.analytics.mixpanelToken || '';
    // Batch-flush events every 5 seconds
    this.flushInterval = window.setInterval(() => this.flush(), 5000);
    // CONSENT (LEG-014): drop anything queued before a decline lands.
    onTrackingConsentChange((state) => {
      if (state !== 'granted') this.queue = [];
    });
  }

  track(event: string, properties?: Record<string, any>): void {
    if (!hasTrackingConsent()) return; // LEG-014: no third-party analytics pre-consent
    this.queue.push({
      type: 'track',
      data: {
        event,
        properties: {
          ...properties,
          token: this.token,
          time: Math.floor(Date.now() / 1000),
          $insert_id: crypto.randomUUID(),
        },
      },
    });
  }

  identify(userId: string, traits?: Record<string, any>): void {
    if (!hasTrackingConsent()) return; // LEG-014
    this.queue.push({
      type: 'engage',
      data: {
        $token: this.token,
        $distinct_id: userId,
        $set: traits || {},
      },
    });
  }

  page(name: string, properties?: Record<string, any>): void {
    this.track('Page View', { page: name, ...properties });
  }

  private async flush(): Promise<void> {
    if (!hasTrackingConsent()) return; // LEG-014: belt-and-braces at the network edge
    if (this.queue.length === 0 || !this.token) return;

    const batch = this.queue.splice(0, 50);
    const trackEvents = batch.filter((e) => e.type === 'track').map((e) => e.data);
    const engageEvents = batch.filter((e) => e.type === 'engage').map((e) => e.data);

    const requests: Promise<any>[] = [];

    if (trackEvents.length > 0) {
      requests.push(
        fetch(`${this.apiUrl}/track`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(trackEvents),
        }).catch(() => {})
      );
    }

    if (engageEvents.length > 0) {
      requests.push(
        fetch(`${this.apiUrl}/engage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(engageEvents),
        }).catch(() => {})
      );
    }

    await Promise.all(requests);
  }
}
