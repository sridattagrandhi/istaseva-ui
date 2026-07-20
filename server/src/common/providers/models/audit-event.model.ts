import type { BaseEventRecord } from '../interfaces/event-provider.interface.js';

export interface AuditEventRecord extends BaseEventRecord {
  eventId?: string;
  action: string;
  resource: string;
  resourceId: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  bookingId?: string | null;
  paymentId?: string | null;
}
