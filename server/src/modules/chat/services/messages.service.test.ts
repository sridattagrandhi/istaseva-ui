// @vitest-environment node
/**
 * Functional wiring test for chat realtime delivery (SEC-005).
 *
 * Proves the product behaviour, not just the provider primitive: when a
 * message is sent, messagesService publishes it to BOTH participants' own
 * `user:<id>:messages` channels and nothing else. This is what lets the
 * receiver's client (which subscribes to `user:<receiverId>:messages`, the
 * only channel the ws ACL lets it join) actually receive the message —
 * without reintroducing the old `table:messages:INSERT` firehose.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendMessageMock = vi.fn();
const publishMock = vi.fn(async () => {});
const publishToTableMock = vi.fn(async () => {});
const notificationsSendMock = vi.fn(async () => {});

vi.mock('../repositories/messages.repository.js', () => ({
  messagesRepository: { sendMessage: (...a: unknown[]) => sendMessageMock(...a) },
}));
vi.mock('../../../common/providers/implementations/realtime/ws-realtime.provider.js', () => ({
  wsRealtimeProvider: {
    publish: (...a: unknown[]) => publishMock(...a),
    publishToTable: (...a: unknown[]) => publishToTableMock(...a),
  },
}));
vi.mock('../../notifications/services/notifications.service.js', () => ({
  notificationsService: { send: (...a: unknown[]) => notificationsSendMock(...a) },
}));

import { messagesService } from './messages.service.js';

describe('messagesService.sendMessage — realtime delivery wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageMock.mockResolvedValue({
      rows: [{ id: 'msg-1', sender_id: 'alice', receiver_id: 'bob', content: 'hi bob' }],
    });
  });

  it('publishes to BOTH participants\' per-user channels and never the table firehose', async () => {
    await messagesService.sendMessage('alice', { receiver_id: 'bob', content: 'hi bob' });

    const channels = publishMock.mock.calls.map((c) => c[0]).sort();
    expect(channels).toEqual(['user:alice:messages', 'user:bob:messages']);

    // The payload the receiver's client will see (shape must stay `{ new: row }`).
    const bobCall = publishMock.mock.calls.find((c) => c[0] === 'user:bob:messages');
    expect(bobCall?.[2]).toEqual({ new: { id: 'msg-1', sender_id: 'alice', receiver_id: 'bob', content: 'hi bob' } });

    // The old table-wide firehose must NOT be used anymore.
    expect(publishToTableMock).not.toHaveBeenCalled();
  });

  it('notifies the receiver (out-of-app push/in-app), not the sender', async () => {
    await messagesService.sendMessage('alice', { receiver_id: 'bob', content: 'hi bob' });
    expect(notificationsSendMock).toHaveBeenCalledTimes(1);
    expect(notificationsSendMock.mock.calls[0][0]).toMatchObject({ userId: 'bob', type: 'new_message' });
  });

  it('a self-message (sender === receiver) publishes to a single channel, not twice', async () => {
    sendMessageMock.mockResolvedValue({
      rows: [{ id: 'msg-2', sender_id: 'alice', receiver_id: 'alice', content: 'note to self' }],
    });
    await messagesService.sendMessage('alice', { receiver_id: 'alice', content: 'note to self' });
    const channels = publishMock.mock.calls.map((c) => c[0]);
    expect(channels).toEqual(['user:alice:messages']); // de-duped by the Set
  });

  it('does not publish when the insert returns no row', async () => {
    sendMessageMock.mockResolvedValue({ rows: [] });
    await messagesService.sendMessage('alice', { receiver_id: 'bob', content: '' });
    expect(publishMock).not.toHaveBeenCalled();
    expect(notificationsSendMock).not.toHaveBeenCalled();
  });
});
