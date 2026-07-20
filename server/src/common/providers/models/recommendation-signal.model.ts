import type { BaseEventRecord } from '../interfaces/event-provider.interface.js';

export interface RecommendationSignalRecord extends BaseEventRecord {
  signalId?: string;
  signalType: string;
  subjectType: 'listing' | 'provider' | 'category' | 'search';
  subjectId: string;
  weight?: number;
}
