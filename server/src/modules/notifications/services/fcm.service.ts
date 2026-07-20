/**
 * Sends Firebase Cloud Messaging push notifications.
 * Uses the firebase-admin SDK which is already initialised for Auth.
 * Works for web (browser), Android, and iOS tokens identically.
 */
import { logger } from '../../../common/logging/logger.js';
import { fcmTokensRepository } from '../repositories/fcm-tokens.repository.js';

let adminApp: any = null;

async function getAdmin() {
  if (adminApp) return adminApp;
  const { default: admin } = await import('firebase-admin');
  if (admin.apps.length > 0) {
    adminApp = admin.apps[0];
    return adminApp;
  }
  // Re-use the service account already configured for Auth
  adminApp = admin.initializeApp();
  return adminApp;
}

export interface FcmPayload {
  userId: string;
  title: string;
  body: string;
  link?: string;
  imageUrl?: string;
  data?: Record<string, string>;
}

export async function sendPushToUser(payload: FcmPayload): Promise<void> {
  let tokens: string[] = [];
  try {
    const result = await fcmTokensRepository.getForUser(payload.userId);
    tokens = result.rows.map((r: any) => r.token);
  } catch (err) {
    logger.warn('FCM: could not fetch tokens', { userId: payload.userId, err: String(err) });
    return;
  }

  if (tokens.length === 0) return;

  const app = await getAdmin();
  const messaging = app.messaging();

  const message = {
    notification: {
      title: payload.title,
      body: payload.body,
      ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
    },
    webpush: payload.link
      ? { fcmOptions: { link: payload.link } }
      : undefined,
    data: {
      ...(payload.link ? { link: payload.link } : {}),
      ...payload.data,
    },
  };

  // sendEachForMulticast lets us handle per-token errors (stale tokens)
  const response = await messaging.sendEachForMulticast({ tokens, ...message });

  // Clean up stale / invalid tokens so we don't keep retrying them
  const staleRemovals: Promise<any>[] = [];
  response.responses.forEach((res: any, idx: number) => {
    if (!res.success) {
      const code = res.error?.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') {
        logger.info('FCM: removing stale token', { token: tokens[idx].slice(0, 20) + '…' });
        staleRemovals.push(fcmTokensRepository.deleteStaleToken(tokens[idx]));
      } else {
        logger.warn('FCM send failed', { code, userId: payload.userId });
      }
    }
  });
  await Promise.allSettled(staleRemovals);

  logger.info('FCM push sent', {
    userId: payload.userId,
    tokenCount: tokens.length,
    successCount: response.successCount,
    failureCount: response.failureCount,
  });
}
