import { messagesRepository } from '../repositories/messages.repository.js';
import { wsRealtimeProvider } from '../../../common/providers/implementations/realtime/ws-realtime.provider.js';
import { notificationsService } from '../../notifications/services/notifications.service.js';
import { logger } from '../../../common/logging/logger.js';

export class MessagesService {
  async listConversations(userId: string, opts: { limit?: number; offset?: number } = {}) {
    const result = await messagesRepository.listConversations(userId, opts.limit, opts.offset);
    return { data: result.rows };
  }

  async getConversation(
    userId: string,
    otherUserId: string,
    opts: { limit?: number; before?: string } = {}
  ) {
    const result = await messagesRepository.getConversation(userId, otherUserId, opts.limit, opts.before);
    return { data: result.rows };
  }

  async sendMessage(userId: string, payload: { receiver_id: string; content: string; metadata?: Record<string, unknown> }) {
    const result = await messagesRepository.sendMessage(userId, payload);
    const message = result.rows[0];

    if (message) {
      // Realtime delivery to the two participants only (SEC-005): publish
      // to each user's own `user:<id>:messages` channel instead of the old
      // table-wide `table:messages:INSERT` firehose, which delivered every
      // message row to any subscriber and relied on client-side filtering.
      // The ws provider's subscription ACL only permits a client to join
      // its own `user:<uid>:...` channels.
      for (const participantId of new Set([userId, payload.receiver_id])) {
        wsRealtimeProvider.publish(`user:${participantId}:messages`, 'INSERT', { new: message }).catch(() => {
          // Non-critical — message was persisted, realtime is best-effort
        });
      }

      // Send an out-of-app notification (in-app row + push) to the receiver
      // so they're pinged when the app is backgrounded. Fire-and-forget —
      // a notification failure must not break the message send.
      const preview = payload.content.length > 80
        ? `${payload.content.slice(0, 77).trimEnd()}…`
        : payload.content;
      notificationsService.send({
        userId: payload.receiver_id,
        type: 'new_message',
        title: 'New message',
        message: preview,
        link: `/messages?user=${userId}`,
        channels: ['in_app', 'push'],
        metadata: { messageId: message.id, senderId: userId },
      }).catch((err) => {
        // Best-effort — delivery failure must not break the message send.
        logger.warn('new_message notification failed', { err: String(err) });
      });
    }

    return { data: message };
  }

  async markAsRead(userId: string, messageId: string) {
    const result = await messagesRepository.markAsRead(userId, messageId);
    return { data: result.rows[0] || null };
  }

  async markConversationAsRead(userId: string, otherUserId: string) {
    await messagesRepository.markConversationAsRead(userId, otherUserId);
    return { data: { ok: true } };
  }
}

export const messagesService = new MessagesService();
