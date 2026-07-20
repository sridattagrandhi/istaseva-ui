export interface NotificationDispatchRequest {
  userId: string;
  title: string;
  message?: string;
  channels?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Future implementations:
 * - SES/SNS
 * - Twilio / SendGrid
 * - Push notification brokers
 */
export interface INotificationProvider {
  sendEmail(params: NotificationDispatchRequest): Promise<void>;
  sendSms(params: NotificationDispatchRequest): Promise<void>;
}
