import { dbQuery } from '../../../common/repositories/database.js';

export class NotificationsRepository {
  listForUser(userId: string, unreadOnly: boolean, limit: number, offset: number) {
    let sql = 'SELECT * FROM notifications WHERE user_id = $1';
    const params: any[] = [userId];

    if (unreadOnly) {
      sql += ' AND is_read = false';
    }

    sql += ' ORDER BY created_at DESC LIMIT $2 OFFSET $3';
    params.push(limit, offset);

    return dbQuery(sql, params);
  }

  countUnread(userId: string) {
    return dbQuery(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [userId]
    );
  }

  markRead(notificationId: string, userId: string) {
    return dbQuery(
      'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING *',
      [notificationId, userId]
    );
  }

  markAllRead(userId: string) {
    return dbQuery(
      'UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false',
      [userId]
    );
  }

  insertNotification(params: {
    userId: string;
    type: string;
    title: string;
    message: string;
    link?: string;
    metadata?: Record<string, any>;
  }) {
    return dbQuery(
      `INSERT INTO notifications (user_id, type, title, message, link, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [params.userId, params.type, params.title, params.message, params.link, JSON.stringify(params.metadata || {})]
    );
  }
}

export const notificationsRepository = new NotificationsRepository();
