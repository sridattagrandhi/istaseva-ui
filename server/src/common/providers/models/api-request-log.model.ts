import type { BaseEventRecord } from '../interfaces/event-provider.interface.js';

export interface ApiRequestLogRecord extends BaseEventRecord {
  requestId?: string;
  date: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
}
