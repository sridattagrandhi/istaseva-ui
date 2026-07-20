/**
 * Analytics Provider Interface
 * 
 * MIGRATION: Implement for Mixpanel, Amplitude, Segment, or custom.
 */

export interface IAnalyticsProvider {
  track(event: string, properties?: Record<string, any>): void;
  identify(userId: string, traits?: Record<string, any>): void;
  page(name: string, properties?: Record<string, any>): void;
}
