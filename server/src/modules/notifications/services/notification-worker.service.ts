/**
 * SQS Notification Worker
 *
 * Runs inside the same ECS container as the API server (no extra Fargate task).
 * Polls SQS every 5 seconds, dispatches messages to push/email/sms channels,
 * deletes the message on success. On failure the message becomes visible again
 * after the queue's visibility timeout — SQS retries 3× before routing to the DLQ.
 *
 * Start with: notificationWorker.start()
 * Stop with:  notificationWorker.stop()   (called on SIGTERM)
 */
import { logger } from '../../../common/logging/logger.js';
import { config } from '../../../common/config/index.js';
import { AppError } from '../../../common/errors/app-error.js';
import { sendPushToUser } from './fcm.service.js';
import { sendNotificationEmailToUser } from './email.service.js';

const POLL_INTERVAL_MS = 5_000;
const MAX_MESSAGES_PER_POLL = 10;
const VISIBILITY_TIMEOUT_S = 60; // must match queue setting

interface NotificationJob {
  userId: string;
  type: string;
  title: string;
  message: string;
  link?: string;
  channels?: string[];
  metadata?: Record<string, any>;
}

async function getSqsClient() {
  const { SQSClient } = await import('@aws-sdk/client-sqs');
  return new SQSClient({ region: config.aws.region || 'ap-south-1' });
}

async function dispatch(job: NotificationJob): Promise<void> {
  const channels = job.channels ?? ['push'];
  const errors: string[] = [];

  for (const channel of channels) {
    try {
      if (channel === 'push') {
        await sendPushToUser({
          userId: job.userId,
          title: job.title,
          body: job.message,
          link: job.link,
          data: job.metadata
            ? Object.fromEntries(Object.entries(job.metadata).map(([k, v]) => [k, String(v)]))
            : undefined,
        });
      } else if (channel === 'email') {
        await sendNotificationEmailToUser({
          userId: job.userId,
          type: job.type,
          data: {
            title: job.title,
            message: job.message,
            link: job.link,
            date: job.metadata?.date as string | undefined,
            provider: job.metadata?.providerName as string | undefined,
            guest: job.metadata?.guestName as string | undefined,
            listing: job.metadata?.listingName as string | undefined,
            amount: job.metadata?.amount as string | undefined,
            bookingId: job.metadata?.bookingId as string | undefined,
            pricing: job.metadata?.pricing as any,
            // Forward MMT-style booking-detail extras + cancellation policy.
            serviceType: job.metadata?.serviceType as string | undefined,
            pickup: job.metadata?.pickup as string | undefined,
            drop: job.metadata?.drop as string | undefined,
            estimatedKm: job.metadata?.estimatedKm as number | undefined,
            hotelAddress: job.metadata?.hotelAddress as string | undefined,
            // WS6: stay directions note — keep in lockstep with
            // notifications.service.ts's inline-dispatch forwarding.
            hasExactAddress: job.metadata?.hasExactAddress as boolean | undefined,
            checkInDate: job.metadata?.checkInDate as string | undefined,
            checkInTime: job.metadata?.checkInTime as string | undefined,
            checkOutDate: job.metadata?.checkOutDate as string | undefined,
            checkOutTime: job.metadata?.checkOutTime as string | undefined,
            nights: job.metadata?.nights as number | undefined,
            guestCount: job.metadata?.guestCount as number | undefined,
            roomType: job.metadata?.roomType as string | undefined,
            roomCount: job.metadata?.roomCount as number | undefined,
            cancellationPolicyText: job.metadata?.cancellationPolicyText as string | undefined,
            bookedOn: job.metadata?.bookedOn as string | undefined,
            providerGstin: job.metadata?.providerGstin as string | undefined,
            platformGstin: job.metadata?.platformGstin as string | undefined,
            paymentMethod: job.metadata?.paymentMethod as string | undefined,
            serviceLocation: job.metadata?.serviceLocation as string | undefined,
            serviceDuration: job.metadata?.serviceDuration as string | undefined,
            selectedServiceName: job.metadata?.selectedServiceName as string | undefined,
            // Visit-provider service bookings: the shop address ("Where to
            // go" row). Never set for stays.
            visitAddress: job.metadata?.visitAddress as string | undefined,
            // Mode-specific transport extras + booking time slot. Matches
            // notifications.service.ts's inline-dispatch forwarding so the
            // SQS-worker path renders the same rows.
            transportMode: job.metadata?.transportMode as string | undefined,
            transportHours: job.metadata?.transportHours as number | undefined,
            transportDays: job.metadata?.transportDays as number | undefined,
            transportPackage: job.metadata?.transportPackage as string | undefined,
            bookingStartTime: job.metadata?.bookingStartTime as string | undefined,
            bookingEndTime: job.metadata?.bookingEndTime as string | undefined,
            passengers: job.metadata?.passengers as number | undefined,
            selectedSlots: job.metadata?.selectedSlots as string[] | undefined,
          },
        });
      } else if (channel === 'sms') {
        // SNS SMS — wire when ready
        logger.info('NOTIFICATION_SMS (SNS SMS not yet configured)', {
          userId: job.userId,
          title: job.title,
        });
      }
    } catch (err) {
      errors.push(`${channel}: ${String(err)}`);
    }
  }

  if (errors.length > 0) {
    throw new AppError(500, `Dispatch partial failure: ${errors.join('; ')}`, 'DISPATCH_PARTIAL_FAILURE');
  }
}

class NotificationWorker {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sqs: any = null;

  async start(): Promise<void> {
    const queueUrl = config.notification.sqsQueueUrl;
    if (!queueUrl) {
      logger.info('Notification worker disabled — SQS_NOTIFICATION_QUEUE_URL not set');
      return;
    }
    this.sqs = await getSqsClient();
    this.running = true;
    logger.info('Notification worker started', { queueUrl });
    this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    logger.info('Notification worker stopped');
  }

  private poll(): void {
    if (!this.running) return;
    this.processBatch()
      .catch((err) => logger.error('Notification worker poll error', { err: String(err) }))
      .finally(() => {
        if (this.running) {
          this.timer = setTimeout(() => this.poll(), POLL_INTERVAL_MS);
        }
      });
  }

  private async processBatch(): Promise<void> {
    const { ReceiveMessageCommand, DeleteMessageCommand } = await import('@aws-sdk/client-sqs');
    const queueUrl = config.notification.sqsQueueUrl!;

    const response = await this.sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: MAX_MESSAGES_PER_POLL,
      WaitTimeSeconds: 5, // long polling — reduces empty receives
      VisibilityTimeout: VISIBILITY_TIMEOUT_S,
    }));

    const messages = response.Messages ?? [];
    if (messages.length === 0) return;

    logger.info(`Notification worker: received ${messages.length} message(s)`);

    await Promise.allSettled(
      messages.map(async (msg: any) => {
        let job: NotificationJob;
        try {
          job = JSON.parse(msg.Body) as NotificationJob;
        } catch {
          logger.warn('Notification worker: invalid message body, deleting', { msgId: msg.MessageId });
          await this.deleteMessage(queueUrl, msg.ReceiptHandle);
          return;
        }

        try {
          await dispatch(job);
          await this.deleteMessage(queueUrl, msg.ReceiptHandle);
          logger.info('Notification dispatched', { userId: job.userId, type: job.type });
        } catch (err) {
          // Leave on queue — SQS retries up to maxReceiveCount (3), then DLQ
          logger.warn('Notification dispatch failed, leaving on queue for retry', {
            userId: job.userId,
            type: job.type,
            err: String(err),
          });
        }
      })
    );
  }

  private async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    const { DeleteMessageCommand } = await import('@aws-sdk/client-sqs');
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  }
}

export const notificationWorker = new NotificationWorker();
