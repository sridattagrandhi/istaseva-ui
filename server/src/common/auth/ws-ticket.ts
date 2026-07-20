/**
 * Single-use WebSocket connect tickets (SEC-008).
 *
 * Bearer tokens used to ride in the WS URL query string (`/ws?token=...`),
 * which leaks long-lived credentials into access logs, proxies, and browser
 * history. Instead, an authenticated client POSTs /api/auth/ws-ticket to
 * mint a short-lived opaque ticket, then connects with `?ticket=...`. A
 * leaked ticket is useless: it expires in seconds and is deleted on first
 * redemption, so it can never authenticate a second connection.
 *
 * Mint (auth module) and redeem (ws-realtime provider) both live here so
 * the key format and TTL cannot drift apart.
 */
import crypto from 'node:crypto';
import { redis } from '../cache/redis.js';

const KEY_PREFIX = 'ws:ticket:';
export const WS_TICKET_TTL_SECONDS = 60;

/** Mint a ticket bound to the authenticated user. 256 bits of entropy. */
export async function mintWsTicket(userId: string): Promise<string> {
  const ticket = crypto.randomBytes(32).toString('base64url');
  await redis.set(`${KEY_PREFIX}${ticket}`, userId, 'EX', WS_TICKET_TTL_SECONDS);
  return ticket;
}

/**
 * Redeem a ticket → userId, or null if unknown/expired. Single-use: the
 * GET+DEL runs inside MULTI/EXEC so two concurrent redemptions of the same
 * ticket cannot both succeed (works on any Redis version, unlike GETDEL).
 */
export async function redeemWsTicket(ticket: string): Promise<string | null> {
  // Cheap shape guard before touching Redis — tickets are 43-char base64url.
  if (!ticket || ticket.length > 128 || !/^[A-Za-z0-9_-]+$/.test(ticket)) return null;
  const key = `${KEY_PREFIX}${ticket}`;
  const results = await redis.multi().get(key).del(key).exec();
  const userId = results?.[0]?.[1];
  return typeof userId === 'string' && userId ? userId : null;
}
