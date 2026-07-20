export { default } from '../modules/notifications/routes/notifications.routes.js';
export async function sendNotification(params: {
  userId: string;
  type: string;
  title: string;
  message: string;
  link?: string;
  channels?: string[];
  metadata?: Record<string, any>;
}) {
  const { notificationsService } = await import('../modules/notifications/services/notifications.service.js');
  await notificationsService.send(params);
}
