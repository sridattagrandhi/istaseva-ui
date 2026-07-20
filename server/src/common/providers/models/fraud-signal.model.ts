import type { BaseEventRecord } from '../interfaces/event-provider.interface.js';

export type FraudRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface FraudSignalRecord extends BaseEventRecord {
  signalId?: string;
  eventType: string;
  riskLevel: FraudRiskLevel;
  deviceId?: string;
  ipAddress?: string;
  sessionId?: string;
}
