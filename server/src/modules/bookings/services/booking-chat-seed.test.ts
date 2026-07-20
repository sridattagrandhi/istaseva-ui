// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the repositories + logger so the seed logic is exercised without a DB.
const getBookingChatParties = vi.fn();
const existsByBookingConfirmation = vi.fn();
const sendMessage = vi.fn();

vi.mock('../repositories/bookings.repository.js', () => ({
  bookingsRepository: { getBookingChatParties: (...a: unknown[]) => getBookingChatParties(...a) },
}));
vi.mock('../../chat/repositories/messages.repository.js', () => ({
  messagesRepository: {
    existsByBookingConfirmation: (...a: unknown[]) => existsByBookingConfirmation(...a),
    sendMessage: (...a: unknown[]) => sendMessage(...a),
  },
}));
vi.mock('../../../common/logging/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { seedBookingConfirmationMessage } = await import('./booking-chat-seed.js');

const parties = (over: Record<string, unknown> = {}) => ({
  rows: [{
    guest_user_id: 'guest-1',
    counterparty_user_id: 'host-1',
    listing_name: 'Trident',
    listing_type: 'stay',
    scheduled_date: '2026-07-16',
    ...over,
  }],
});

beforeEach(() => {
  getBookingChatParties.mockReset();
  existsByBookingConfirmation.mockReset();
  sendMessage.mockReset();
  existsByBookingConfirmation.mockResolvedValue(false);
  sendMessage.mockResolvedValue({ rows: [{ id: 'm1' }] });
});

describe('seedBookingConfirmationMessage', () => {
  it('seeds a provider→guest message with booking metadata', async () => {
    getBookingChatParties.mockResolvedValue(parties());
    await seedBookingConfirmationMessage('bk-1');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [sender, payload] = sendMessage.mock.calls[0];
    expect(sender).toBe('host-1');
    expect(payload.receiver_id).toBe('guest-1');
    expect(payload.content).toContain('Booking confirmed');
    expect(payload.content).toContain('Trident');
    expect(payload.content).toContain('Check-in: 16 Jul 2026'); // stay listing_type
    expect(payload.metadata).toMatchObject({
      bookingId: 'bk-1',
      kind: 'booking_confirmed',
      listingType: 'stay',
      system: true,
    });
  });

  it('falls back to a generic label when the listing has no name', async () => {
    getBookingChatParties.mockResolvedValue(parties({ listing_name: null, scheduled_date: null }));
    await seedBookingConfirmationMessage('bk-1');
    expect(sendMessage.mock.calls[0][1].content).toContain('your booking');
  });

  it('is idempotent — skips when a confirmation message already exists', async () => {
    getBookingChatParties.mockResolvedValue(parties());
    existsByBookingConfirmation.mockResolvedValue(true);
    await seedBookingConfirmationMessage('bk-1');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('skips a self-booking (guest is also the counterparty)', async () => {
    getBookingChatParties.mockResolvedValue(parties({ counterparty_user_id: 'guest-1' }));
    await seedBookingConfirmationMessage('bk-1');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('skips when no booking row is found', async () => {
    getBookingChatParties.mockResolvedValue({ rows: [] });
    await seedBookingConfirmationMessage('missing');
    expect(existsByBookingConfirmation).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('never throws when the repository fails', async () => {
    getBookingChatParties.mockRejectedValue(new Error('db down'));
    await expect(seedBookingConfirmationMessage('bk-1')).resolves.toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
