import { NotFoundError } from '../../../common/errors/app-error.js';
import { config } from '../../../common/config/index.js';
import { logger } from '../../../common/logging/logger.js';
import { notificationsRepository } from '../repositories/notifications.repository.js';

export interface SendNotificationParams {
  userId: string;
  type: string;
  title: string;
  message: string;
  link?: string;
  /** Defaults to ['in_app']. Add 'push', 'email', 'sms' as needed. */
  channels?: string[];
  metadata?: Record<string, any>;
}

// Lazy SQS client — only initialised when the queue URL is configured
let sqsClient: any = null;
async function getSqs() {
  if (sqsClient) return sqsClient;
  const { SQSClient } = await import('@aws-sdk/client-sqs');
  sqsClient = new SQSClient({ region: config.aws.region || 'ap-south-1' });
  return sqsClient;
}

async function enqueueToSqs(params: SendNotificationParams): Promise<boolean> {
  const queueUrl = config.notification.sqsQueueUrl;
  if (!queueUrl) return false;
  try {
    const { SendMessageCommand } = await import('@aws-sdk/client-sqs');
    const sqs = await getSqs();
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(params),
      // Use userId as deduplication group so notifications for the same user
      // are processed in order (only matters for FIFO queues, harmless otherwise)
      MessageGroupId: params.userId,
    }));
    return true;
  } catch (err) {
    logger.warn('Failed to enqueue notification to SQS', { err: String(err), userId: params.userId });
    return false;
  }
}

export class NotificationsService {
  async listForUser(params: { userId: string; unreadOnly: boolean; page: number; limit: number }) {
    const offset = (params.page - 1) * params.limit;
    const [result, countResult] = await Promise.all([
      notificationsRepository.listForUser(params.userId, params.unreadOnly, params.limit, offset),
      notificationsRepository.countUnread(params.userId),
    ]);
    return {
      data: result.rows,
      unreadCount: parseInt(countResult.rows[0].count, 10),
    };
  }

  async markRead(notificationId: string, userId: string) {
    const result = await notificationsRepository.markRead(notificationId, userId);
    if (!result.rows[0]) throw new NotFoundError('Notification', notificationId);
    return { data: result.rows[0] };
  }

  async markAllRead(userId: string) {
    await notificationsRepository.markAllRead(userId);
    return { success: true };
  }

  /**
   * Send a notification to a user.
   *
   * Always saves to the notifications table (in-app bell).
   * If SQS is configured, also enqueues for async dispatch (push/email/sms).
   * If SQS is not configured (local dev), dispatches push synchronously as fallback.
   */
  async send(params: SendNotificationParams): Promise<void> {
    const channels = params.channels ?? ['in_app'];

    // 1. Always persist in-app notification (powers the bell icon)
    try {
      await notificationsRepository.insertNotification(params);
    } catch (err) {
      logger.warn('Failed to persist in-app notification', { err: String(err), userId: params.userId });
    }

    // 2. If no external channels requested, we're done
    const externalChannels = channels.filter((c) => c !== 'in_app');
    if (externalChannels.length === 0) return;

    // 3. Enqueue to SQS for the worker to dispatch async (push, email, sms)
    const queued = await enqueueToSqs({ ...params, channels: externalChannels });

    // 4. Fallback for local / non-SQS envs: dispatch external channels
    // synchronously. Without this, every channel except in_app is silently
    // dropped when SQS_NOTIFICATION_QUEUE_URL is unset — which is the default
    // in dev and the reason booking-confirmation emails were never landing.
    if (!queued) {
      if (externalChannels.includes('push')) {
        try {
          const { sendPushToUser } = await import('./fcm.service.js');
          await sendPushToUser({
            userId: params.userId,
            title: params.title,
            body: params.message,
            link: params.link,
            data: params.metadata ? Object.fromEntries(
              Object.entries(params.metadata).map(([k, v]) => [k, String(v)])
            ) : undefined,
          });
        } catch (err) {
          logger.warn('FCM fallback dispatch failed', { err: String(err) });
        }
      }

      if (externalChannels.includes('email')) {
        try {
          const { sendNotificationEmailToUser } = await import('./email.service.js');
          await sendNotificationEmailToUser({
            userId: params.userId,
            type: params.type,
            data: {
              title: params.title,
              message: params.message,
              link: params.link,
              date: params.metadata?.date as string | undefined,
              provider: params.metadata?.providerName as string | undefined,
              guest: params.metadata?.guestName as string | undefined,
              listing: params.metadata?.listingName as string | undefined,
              amount: params.metadata?.amount as string | undefined,
              bookingId: params.metadata?.bookingId as string | undefined,
              pricing: params.metadata?.pricing as any,
              // Forward transport-specific extras when the source booking
              // is a driver listing. Email template renders these conditionally.
              serviceType: params.metadata?.serviceType as string | undefined,
              pickup: params.metadata?.pickup as string | undefined,
              drop: params.metadata?.drop as string | undefined,
              estimatedKm: params.metadata?.estimatedKm as number | undefined,
              // MMT-style booking-detail extras (stays + cancellation policy)
              hotelAddress: params.metadata?.hotelAddress as string | undefined,
              // WS6: drives the "Getting there — message or call your host"
              // note for stays without a street-level address. Was silently
              // dropped by this allowlist before, so the note never rendered
              // in a real sent email despite passing the template tests.
              hasExactAddress: params.metadata?.hasExactAddress as boolean | undefined,
              checkInDate: params.metadata?.checkInDate as string | undefined,
              checkInTime: params.metadata?.checkInTime as string | undefined,
              checkOutDate: params.metadata?.checkOutDate as string | undefined,
              checkOutTime: params.metadata?.checkOutTime as string | undefined,
              nights: params.metadata?.nights as number | undefined,
              guestCount: params.metadata?.guestCount as number | undefined,
              roomType: params.metadata?.roomType as string | undefined,
              roomCount: params.metadata?.roomCount as number | undefined,
              cancellationPolicyText: params.metadata?.cancellationPolicyText as string | undefined,
              bookedOn: params.metadata?.bookedOn as string | undefined,
              providerGstin: params.metadata?.providerGstin as string | undefined,
              platformGstin: params.metadata?.platformGstin as string | undefined,
              paymentMethod: params.metadata?.paymentMethod as string | undefined,
              serviceLocation: params.metadata?.serviceLocation as string | undefined,
              serviceDuration: params.metadata?.serviceDuration as string | undefined,
              selectedServiceName: params.metadata?.selectedServiceName as string | undefined,
              // Visit-provider service bookings: the shop address the
              // customer travels to ("Where to go" row). Never set for stays.
              visitAddress: params.metadata?.visitAddress as string | undefined,
              // Mode-specific transport extras (hours / days / package) and
              // the booking time slot. Render only when the source booking
              // provided them so non-applicable rows stay hidden.
              transportMode: params.metadata?.transportMode as string | undefined,
              transportHours: params.metadata?.transportHours as number | undefined,
              transportDays: params.metadata?.transportDays as number | undefined,
              transportPackage: params.metadata?.transportPackage as string | undefined,
              bookingStartTime: params.metadata?.bookingStartTime as string | undefined,
              bookingEndTime: params.metadata?.bookingEndTime as string | undefined,
              passengers: params.metadata?.passengers as number | undefined,
              selectedSlots: params.metadata?.selectedSlots as string[] | undefined,
            },
          });
        } catch (err) {
          logger.warn('Email fallback dispatch failed', { err: String(err) });
        }
      }
    }
  }
}

export const notificationsService = new NotificationsService();
