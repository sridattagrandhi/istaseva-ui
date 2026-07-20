import { dbQuery, dbTransaction, runDbQuery } from '../../../common/repositories/database.js';

export class MessagesRepository {
  /**
   * Paginated list of a user's conversations, read from the denormalized
   * `conversations` table. This is the hot path hit on every chat screen
   * open, so it MUST be a single indexed query — no UNIONs, no DISTINCT ON.
   *
   * The joined profile lookup is a per-row dictionary fetch keyed by
   * TEXT user_id, which both user_profiles and provider_profiles support
   * after the uuid→text widening migration.
   */
  listConversations(userId: string, limit = 50, offset = 0) {
    return dbQuery(
      `SELECT
         c.other_user_id,
         c.last_message              AS content,
         c.last_message_at           AS created_at,
         c.unread_count,
         COALESCE(up.display_name, pp.display_name) AS participant_name
       FROM conversations c
       LEFT JOIN user_profiles     up ON up.user_id = c.other_user_id
       LEFT JOIN provider_profiles pp ON pp.user_id = c.other_user_id
       WHERE c.user_id = $1
       ORDER BY c.last_message_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, Math.min(Math.max(limit, 1), 100), Math.max(offset, 0)]
    );
  }

  getConversation(userId: string, otherUserId: string, limit = 100, beforeCreatedAt?: string) {
    const cappedLimit = Math.min(Math.max(limit, 1), 200);
    // Cursor pagination on created_at so very long threads don't blow up
    // the response. `beforeCreatedAt` = "give me messages older than this".
    if (beforeCreatedAt) {
      return dbQuery(
        `SELECT *
           FROM messages
          WHERE ((sender_id = $1 AND receiver_id = $2)
              OR (sender_id = $2 AND receiver_id = $1))
            AND created_at < $3
          ORDER BY created_at DESC
          LIMIT $4`,
        [userId, otherUserId, beforeCreatedAt, cappedLimit]
      );
    }
    return dbQuery(
      `SELECT *
         FROM messages
        WHERE (sender_id = $1 AND receiver_id = $2)
           OR (sender_id = $2 AND receiver_id = $1)
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, otherUserId, cappedLimit]
    );
  }

  /**
   * Insert the message and atomically update both participants' conversation
   * rows. One transaction, three writes — keeps the denormalization
   * consistent without requiring a trigger.
   */
  sendMessage(
    userId: string,
    payload: { receiver_id: string; content: string; metadata?: Record<string, unknown> }
  ) {
    return dbTransaction(async (client) => {
      const inserted = await runDbQuery(
        client,
        `INSERT INTO messages (sender_id, receiver_id, content, metadata)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userId, payload.receiver_id, payload.content, JSON.stringify(payload.metadata ?? {})]
      );
      const message = inserted.rows[0];
      if (!message) return inserted;

      // Sender side: thread updated, unread stays at zero (sender has read their own msg).
      await runDbQuery(
        client,
        `INSERT INTO conversations (
           user_id, other_user_id,
           last_message_id, last_message, last_message_at, last_sender_id,
           unread_count, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 0, NOW())
         ON CONFLICT (user_id, other_user_id) DO UPDATE SET
           last_message_id = EXCLUDED.last_message_id,
           last_message    = EXCLUDED.last_message,
           last_message_at = EXCLUDED.last_message_at,
           last_sender_id  = EXCLUDED.last_sender_id,
           updated_at      = NOW()`,
        [userId, payload.receiver_id, message.id, payload.content, message.created_at, userId]
      );

      // Receiver side: thread updated, unread incremented.
      await runDbQuery(
        client,
        `INSERT INTO conversations (
           user_id, other_user_id,
           last_message_id, last_message, last_message_at, last_sender_id,
           unread_count, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 1, NOW())
         ON CONFLICT (user_id, other_user_id) DO UPDATE SET
           last_message_id = EXCLUDED.last_message_id,
           last_message    = EXCLUDED.last_message,
           last_message_at = EXCLUDED.last_message_at,
           last_sender_id  = EXCLUDED.last_sender_id,
           unread_count    = conversations.unread_count + 1,
           updated_at      = NOW()`,
        [payload.receiver_id, userId, message.id, payload.content, message.created_at, userId]
      );

      return inserted;
    });
  }

  /**
   * Has a "booking confirmed" system message already been seeded for this
   * booking? Guards the auto-seed on confirm so retries / repeated payment
   * webhooks don't post duplicate messages into the thread.
   */
  async existsByBookingConfirmation(bookingId: string): Promise<boolean> {
    const result = await dbQuery<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM messages
          WHERE metadata->>'bookingId' = $1
            AND metadata->>'kind' = 'booking_confirmed'
       ) AS exists`,
      [bookingId],
    );
    return Boolean(result.rows[0]?.exists);
  }

  /**
   * Mark a single message as read, and decrement the reader's unread_count
   * for that conversation if the update actually changed state. Guarded so
   * a re-read doesn't drive the counter negative.
   */
  markAsRead(userId: string, messageId: string) {
    return dbTransaction(async (client) => {
      const updated = await runDbQuery<{ id: string; sender_id: string; receiver_id: string }>(
        client,
        `UPDATE messages
            SET is_read = true, updated_at = NOW()
          WHERE id = $1 AND receiver_id = $2 AND is_read = false
          RETURNING id, sender_id, receiver_id`,
        [messageId, userId]
      );
      const row = updated.rows[0];
      if (row) {
        await runDbQuery(
          client,
          `UPDATE conversations
              SET unread_count = GREATEST(unread_count - 1, 0),
                  updated_at   = NOW()
            WHERE user_id = $1 AND other_user_id = $2`,
          [userId, row.sender_id]
        );
      }
      return updated;
    });
  }

  /**
   * Mark all messages in a conversation as read at once — used when a user
   * opens the chat screen. Single UPDATE on messages, single UPDATE on
   * conversations. No N+1.
   */
  markConversationAsRead(userId: string, otherUserId: string) {
    return dbTransaction(async (client) => {
      await runDbQuery(
        client,
        `UPDATE messages
            SET is_read = true, updated_at = NOW()
          WHERE receiver_id = $1 AND sender_id = $2 AND is_read = false`,
        [userId, otherUserId]
      );
      await runDbQuery(
        client,
        `UPDATE conversations
            SET unread_count = 0, updated_at = NOW()
          WHERE user_id = $1 AND other_user_id = $2`,
        [userId, otherUserId]
      );
    });
  }
}

export const messagesRepository = new MessagesRepository();
