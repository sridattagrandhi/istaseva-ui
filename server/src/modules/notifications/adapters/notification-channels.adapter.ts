import { logger } from '../../../common/logging/logger.js';
import type { INotificationProvider, NotificationDispatchRequest } from '../../../common/providers/interfaces/notification-provider.interface.js';

export class NotificationChannelsAdapter implements INotificationProvider {
  async sendEmail(params: NotificationDispatchRequest) {
    logger.info('Email notification queued', { userId: params.userId, title: params.title });
  }

  async sendSms(params: NotificationDispatchRequest) {
    logger.info('SMS notification queued', { userId: params.userId, title: params.title });
  }
}

export const notificationChannelsAdapter = new NotificationChannelsAdapter();
