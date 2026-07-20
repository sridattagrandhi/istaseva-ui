import type { BaseEventRecord } from '../interfaces/event-provider.interface.js';

export interface AnalyticsEventRecord extends BaseEventRecord {
  eventName: string;
  page?: string;
  deviceId?: string;
  sessionId?: string;
  recommendationContext?: string;
}
