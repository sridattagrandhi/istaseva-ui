import { dbQuery } from '../../../common/repositories/database.js';

export class FcmTokensRepository {
  upsert(userId: string, token: string, platform: string, deviceHint?: string) {
    return dbQuery(
      `INSERT INTO public.fcm_tokens (user_id, token, platform, device_hint)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, token) DO UPDATE
         SET platform = EXCLUDED.platform,
             device_hint = EXCLUDED.device_hint,
             updated_at = NOW()
       RETURNING *`,
      [userId, token, platform, deviceHint ?? null]
    );
  }

  deleteToken(userId: string, token: string) {
    return dbQuery(
      'DELETE FROM public.fcm_tokens WHERE user_id = $1 AND token = $2',
      [userId, token]
    );
  }

  deleteStaleToken(token: string) {
    return dbQuery(
      'DELETE FROM public.fcm_tokens WHERE token = $1',
      [token]
    );
  }

  getForUser(userId: string) {
    return dbQuery(
      'SELECT token, platform FROM public.fcm_tokens WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId]
    );
  }
}

export const fcmTokensRepository = new FcmTokensRepository();
