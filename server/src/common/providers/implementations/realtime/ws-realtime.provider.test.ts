// @vitest-environment node
/**
 * SEC-005 + SEC-008 regression tests — WebSocket realtime authorization.
 *
 * The invariants under test:
 *   1. /ws upgrades authenticate via a single-use ticket; missing/invalid
 *      tickets are rejected (close 1008). Bearer tokens in the query string
 *      are NOT accepted (SEC-008).
 *   2. Tickets are single-use: a second connection with the same ticket is
 *      rejected (SEC-008).
 *   3. subscribe is ACL'd server-side: a client may only join its own
 *      `user:<uid>:...` channels. Cross-user and table-firehose
 *      subscriptions are denied and receive no published events (SEC-005).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';

// The provider and the ticket helper pull in the shared ioredis client at
// module load; stub it with a Map-backed store so tests don't need a real
// Redis. duplicate() returns a subscriber whose subscribe() resolves,
// keeping the local-dispatch path intact. multi().get().del().exec() mirrors
// the atomic single-use redemption in ws-ticket.ts.
vi.mock('../../../cache/redis.js', () => {
  const store = new Map<string, string>();
  const fakeSubscriber = {
    on: vi.fn(),
    subscribe: vi.fn(async () => 1),
    unsubscribe: vi.fn(async () => 1),
    quit: vi.fn(async () => 'OK'),
  };
  return {
    redis: {
      duplicate: () => fakeSubscriber,
      publish: vi.fn(async () => 1),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      multi() {
        const ops: Array<() => unknown> = [];
        const chain = {
          get(key: string) {
            ops.push(() => store.get(key) ?? null);
            return chain;
          },
          del(key: string) {
            ops.push(() => (store.delete(key) ? 1 : 0));
            return chain;
          },
          async exec() {
            return ops.map((fn) => [null, fn()] as [null, unknown]);
          },
        };
        return chain;
      },
    },
  };
});

import { WsRealtimeProvider } from './ws-realtime.provider.js';
import { mintWsTicket } from '../../../auth/ws-ticket.js';

interface Frame {
  type?: string;
  channel?: string;
  payload?: unknown;
}

let server: http.Server;
let provider: WsRealtimeProvider;
let port: number;

function connectRaw(query: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Mint a fresh ticket for the user and open an authenticated connection. */
async function connectAs(userId: string): Promise<WebSocket> {
  const ticket = await mintWsTicket(userId);
  return connectRaw(`?ticket=${ticket}`);
}

function awaitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

/** Resolve with the next JSON frame, or null if none arrives within ms. */
function nextMessage(ws: WebSocket, ms = 200): Promise<Frame | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      resolve(null);
    }, ms);
    const onMsg = (raw: Buffer) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    };
    ws.once('message', onMsg);
  });
}

function subscribe(ws: WebSocket, channel: string) {
  ws.send(JSON.stringify({ type: 'subscribe', channel }));
}

beforeAll(async () => {
  server = http.createServer();
  provider = new WsRealtimeProvider();
  provider.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await provider.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('WsRealtimeProvider — connection auth (SEC-005 / SEC-008)', () => {
  it('rejects an unauthenticated /ws upgrade with close 1008', async () => {
    const ws = await connectRaw(''); // no ticket
    const closed = await awaitClose(ws);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe('unauthenticated');
  });

  it('rejects an invalid ticket the same way', async () => {
    const ws = await connectRaw('?ticket=not-a-real-ticket');
    const closed = await awaitClose(ws);
    expect(closed.code).toBe(1008);
  });

  it('does NOT accept a bearer token in the query string (SEC-008)', async () => {
    const ws = await connectRaw('?token=some-firebase-id-token');
    const closed = await awaitClose(ws);
    expect(closed.code).toBe(1008);
  });

  it('tickets are single-use: a replayed ticket cannot authenticate twice (SEC-008)', async () => {
    const ticket = await mintWsTicket('user-alice');
    const first = await connectRaw(`?ticket=${ticket}`);
    // First connection succeeds — prove it by subscribing to own channel.
    subscribe(first, 'user:user-alice:messages');
    await new Promise((r) => setTimeout(r, 50));
    await provider.publish('user:user-alice:messages', 'INSERT', { new: { id: 'm0' } });
    expect(await nextMessage(first)).not.toBeNull();

    // Replay: same ticket again must be rejected.
    const replay = await connectRaw(`?ticket=${ticket}`);
    const closed = await awaitClose(replay);
    expect(closed.code).toBe(1008);
    first.close();
  });
});

describe('WsRealtimeProvider — subscription ACL (SEC-005)', () => {
  it('allows a user to subscribe to their own user:<uid>: channel and receive events', async () => {
    const alice = await connectAs('user-alice');
    subscribe(alice, 'user:user-alice:messages');
    // Give the subscribe frame a beat to be processed server-side.
    await new Promise((r) => setTimeout(r, 50));

    await provider.publish('user:user-alice:messages', 'INSERT', { new: { id: 'm1' } });
    const msg = await nextMessage(alice);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe('user:user-alice:messages');
    expect(msg!.payload).toEqual({ new: { id: 'm1' } });
    alice.close();
  });

  it("denies subscribing to another user's channel and delivers nothing", async () => {
    const bob = await connectAs('user-bob');
    subscribe(bob, 'user:user-alice:messages'); // attacker → victim channel
    const denial = await nextMessage(bob);
    expect(denial).toEqual({ type: 'subscription_denied', channel: 'user:user-alice:messages' });

    await provider.publish('user:user-alice:messages', 'INSERT', { new: { id: 'secret' } });
    const leaked = await nextMessage(bob);
    expect(leaked).toBeNull();
    bob.close();
  });

  it('denies table-level firehose subscriptions', async () => {
    const bob = await connectAs('user-bob');
    subscribe(bob, 'table:messages:INSERT');
    const denial = await nextMessage(bob);
    expect(denial).toEqual({ type: 'subscription_denied', channel: 'table:messages:INSERT' });

    await provider.publishToTable('messages', 'INSERT', { new: { id: 'secret' } });
    const leaked = await nextMessage(bob);
    expect(leaked).toBeNull();
    bob.close();
  });

  it('denies arbitrary non-user-scoped channels (e.g. bare assistant chip channels)', async () => {
    const bob = await connectAs('user-bob');
    subscribe(bob, 'assistant:some-request-id:tools');
    const denial = await nextMessage(bob);
    expect(denial?.type).toBe('subscription_denied');

    // The user-scoped chip channel of ANOTHER user is also denied.
    subscribe(bob, 'user:user-alice:assistant:some-request-id:tools');
    const denial2 = await nextMessage(bob);
    expect(denial2?.type).toBe('subscription_denied');
    bob.close();
  });

  it('still honours ping/pong and unsubscribe for authenticated clients', async () => {
    const alice = await connectAs('user-alice');
    alice.send(JSON.stringify({ type: 'ping' }));
    const pong = await nextMessage(alice);
    expect(pong).toEqual({ type: 'pong' });

    subscribe(alice, 'user:user-alice:messages');
    await new Promise((r) => setTimeout(r, 50));
    alice.send(JSON.stringify({ type: 'unsubscribe', channel: 'user:user-alice:messages' }));
    await new Promise((r) => setTimeout(r, 50));
    await provider.publish('user:user-alice:messages', 'INSERT', { new: { id: 'm2' } });
    const afterUnsub = await nextMessage(alice);
    expect(afterUnsub).toBeNull();
    alice.close();
  });
});
