import type { BaseEventRecord } from '../interfaces/event-provider.interface.js';

export interface CommunicationLogRecord extends BaseEventRecord {
  messageId?: string;
  channel: 'chat' | 'notification' | 'email' | 'sms';
  direction: 'inbound' | 'outbound';
  conversationId?: string;
  resource?: string;
  resourceId?: string;
}
