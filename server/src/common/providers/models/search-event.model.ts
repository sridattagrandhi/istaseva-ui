import type { BaseEventRecord } from '../interfaces/event-provider.interface.js';

export interface SearchEventRecord extends BaseEventRecord {
  searchId?: string;
  query: string;
  category?: string;
  resultCount?: number;
  sortBy?: string;
}
