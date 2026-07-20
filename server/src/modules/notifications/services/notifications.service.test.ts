// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../../common/errors/app-error.js';

const repo = {
  listForUser: vi.fn(),
  countUnread: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  insertNotification: vi.fn(),
};

vi.mock('../repositories/notifications.repository.js', () => ({
  notificationsRepository: repo,
}));

// Block out the SQS path: with no queue URL, enqueueToSqs short-circuits and
// we exercise the FCM fallback. fcm.service is dynamically imported so we
// mock the module path used by `import('./fcm.service.js')`.
const sendPushToUserMock = vi.fn();
vi.mock('./fcm.service.js', () => ({
  sendPushToUser: sendPushToUserMock,
}));

vi.mock('../../../common/logging/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../common/config/index.js', () => ({
  config: {
    notification: { sqsQueueUrl: null },
    aws: { region: 'ap-south-1' },
  },
}));

describe('NotificationsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('listForUser returns rows and the unread count', async () => {
    const { notificationsService } = await import('./notifications.service.js');
    repo.listForUser.mockResolvedValue({ rows: [{ id: 'n1' }] });
    repo.countUnread.mockResolvedValue({ rows: [{ count: '3' }] });

    const r = await notificationsService.listForUser({
      userId: 'u1', unreadOnly: false, page: 1, limit: 20,
    });
    expect(r.data).toEqual([{ id: 'n1' }]);
    expect(r.unreadCount).toBe(3);
  });

  it('markRead throws NotFound when no row updated', async () => {
    const { notificationsService } = await import('./notifications.service.js');
    repo.markRead.mockResolvedValue({ rows: [] });
    await expect(notificationsService.markRead('n', 'u')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('send() persists in-app and skips external dispatch when only in_app channel', async () => {
    const { notificationsService } = await import('./notifications.service.js');
    repo.insertNotification.mockResolvedValue(undefined);

    await notificationsService.send({
      userId: 'u1', type: 'system', title: 'hi', message: 'msg',
    });

    expect(repo.insertNotification).toHaveBeenCalledTimes(1);
    expect(sendPushToUserMock).not.toHaveBeenCalled();
  });

  it('send() falls back to synchronous push when SQS is not configured', async () => {
    const { notificationsService } = await import('./notifications.service.js');
    repo.insertNotification.mockResolvedValue(undefined);

    await notificationsService.send({
      userId: 'u1', type: 'system', title: 'hi', message: 'msg',
      channels: ['in_app', 'push'],
    });

    expect(sendPushToUserMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', title: 'hi', body: 'msg',
    }));
  });

  it('send() does not throw if in-app persistence fails', async () => {
    const { notificationsService } = await import('./notifications.service.js');
    repo.insertNotification.mockRejectedValueOnce(new Error('db down'));

    await expect(
      notificationsService.send({ userId: 'u1', type: 'x', title: 't', message: 'm' }),
    ).resolves.toBeUndefined();
  });
});
