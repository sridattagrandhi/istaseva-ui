import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Redis as RedisClient } from 'ioredis';
import type { IRealtimeProvider } from '../../interfaces/realtime-provider.interface.js';
import { logger } from '../../../logging/logger.js';
import { redis } from '../../../cache/redis.js';
import { redeemWsTicket } from '../../../auth/ws-ticket.js';

interface WsClient {
  ws: WebSocket;
  userId: string | null;
  channels: Set<string>;
  isAlive: boolean;
}

interface FanoutEnvelope {
  /** UUID of the task that originally published; skip dispatching back to self to avoid double-send. */
  origin: string;
  /** The subscriber-side channel name (e.g. "table:messages:INSERT" or a custom channel). */
  channel: string;
  /** The JSON-encoded payload already formatted for ws.send() — saves re-serialization in each task. */
  message: string;
  /** Optional wildcard alias so publishToTable() can match e.g. "table:messages:*" on receiving tasks. */
  wildcardChannel?: string;
}

/**
 * WebSocket Realtime Provider
 *
 * Cross-task realtime fan-out via Redis pub/sub. Every ECS task:
 *   • maintains its own set of local WS clients
 *   • PUBLISHes every outgoing event to a shared Redis channel
 *   • SUBSCRIBEs to that same channel and dispatches to its local clients
 *
 * This is what lets User A (connected to task 1) receive a message sent by
 * User B (connected to task 2). Without it, realtime silently breaks the
 * moment Fargate scales to >1 task.
 *
 * Fallback: if Redis pub/sub is unavailable, we still dispatch locally so
 * single-task dev/test keeps working. A task can only miss messages from
 * OTHER tasks in that degraded mode — which is exactly how it behaved before.
 */
export class WsRealtimeProvider implements IRealtimeProvider {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WsClient>();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  private readonly instanceId = crypto.randomUUID();
  private subscriber: RedisClient | null = null;
  private subscriberReady = false;
  private static readonly FANOUT_CHANNEL = 'ws:fanout';

  /**
   * Attach to an existing HTTP server for upgrade handling.
   * Call this once during server startup.
   */
  /**
   * Optional voice-route handler. When set, upgrades on /ws/voice are
   * handed off to it instead of being rejected. Kept as an injected dep
   * so this provider stays decoupled from the Gemini Live plumbing.
   */
  private voiceHandler:
    | ((ws: WebSocket, userId: string, displayName?: string, query?: URLSearchParams) => void)
    | null = null;
  setVoiceHandler(
    fn: (ws: WebSocket, userId: string, displayName?: string, query?: URLSearchParams) => void,
  ) {
    this.voiceHandler = fn;
  }

  attach(server: http.Server) {
    this.wss = new WebSocketServer({ noServer: true });
    // Dedicated WebSocketServer for voice: separate instance so its connection
    // lifecycle (and any future heartbeat tuning) doesn't entangle with the
    // realtime fan-out clients. Shares the same HTTP upgrade listener.
    const voiceWss = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (request, socket, head) => {
      const url = new URL(request.url || '/', `http://${request.headers.host}`);

      // Authenticate once for either path — both present a single-use ticket
      // minted by POST /api/auth/ws-ticket (SEC-008). Bearer tokens in the
      // query string are deliberately NOT accepted anymore: URLs land in
      // access logs and proxies, so only a short-lived, one-shot credential
      // may travel there.
      let userId: string | null = null;
      const ticket = url.searchParams.get('ticket');
      if (ticket) {
        try { userId = await redeemWsTicket(ticket); } catch { userId = null; }
      }

      if (url.pathname === '/ws/voice') {
        if (!this.voiceHandler || !userId) {
          // Complete the WS handshake before closing so the browser fires a
          // `close` event with a reason instead of a raw `error` event.
          // Without this, the client sees a hard-to-debug "connection
          // error" with no detail (it was the root cause of the onboarding
          // voice bug). We emit a 1011 (server error) + reason string so
          // the frontend can map it to a useful message.
          const reason = !this.voiceHandler
            ? 'voice_unavailable'   // Gemini Live not configured server-side
            : 'unauthenticated';    // ticket missing / invalid / already used
          try {
            voiceWss.handleUpgrade(request, socket, head, (ws) => {
              try { ws.close(1011, reason); } catch { /* socket may be half-open */ }
            });
          } catch {
            try { socket.destroy(); } catch { /* already closed */ }
          }
          return;
        }
        const query = url.searchParams;
        voiceWss.handleUpgrade(request, socket, head, (ws) => {
          this.voiceHandler!(ws, userId!, undefined, query);
        });
        return;
      }

      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      // SEC-005: realtime requires an authenticated handshake. Complete the
      // WS upgrade before closing (same pattern as /ws/voice above) so the
      // browser gets a close reason instead of an opaque connection error.
      if (!userId) {
        try {
          this.wss!.handleUpgrade(request, socket, head, (ws) => {
            try { ws.close(1008, 'unauthenticated'); } catch { /* socket may be half-open */ }
          });
        } catch {
          try { socket.destroy(); } catch { /* already closed */ }
        }
        return;
      }

      this.wss!.handleUpgrade(request, socket, head, (ws) => {
        this.wss!.emit('connection', ws, request, userId);
      });
    });

    this.wss.on('connection', (ws: WebSocket, _request: http.IncomingMessage, userId: string | null) => {
      const client: WsClient = { ws, userId, channels: new Set(), isAlive: true };
      this.clients.add(client);

      logger.debug('WebSocket client connected', { userId, totalClients: this.clients.size });

      ws.on('pong', () => {
        client.isAlive = true;
      });

      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());

          switch (data.type) {
            case 'subscribe':
              if (typeof data.channel === 'string' && data.channel) {
                // SEC-005: the server decides which channels a user may
                // join — never trust the client-supplied channel name.
                if (this.canSubscribe(client, data.channel)) {
                  client.channels.add(data.channel);
                } else {
                  logger.warn('WebSocket subscription denied', {
                    userId: client.userId,
                    channel: data.channel,
                  });
                  ws.send(JSON.stringify({ type: 'subscription_denied', channel: data.channel }));
                }
              }
              break;
            case 'unsubscribe':
              if (data.channel) {
                client.channels.delete(data.channel);
              }
              break;
            case 'ping':
              ws.send(JSON.stringify({ type: 'pong' }));
              break;
          }
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on('close', () => {
        this.clients.delete(client);
        logger.debug('WebSocket client disconnected', { userId, totalClients: this.clients.size });
      });

      ws.on('error', () => {
        this.clients.delete(client);
      });
    });

    // Heartbeat every 30 seconds — clean up dead connections
    this.heartbeatInterval = setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) {
          client.ws.terminate();
          this.clients.delete(client);
          continue;
        }
        client.isAlive = false;
        client.ws.ping();
      }
    }, 30_000);
    this.heartbeatInterval.unref();

    // Start the cross-task fan-out subscriber (best-effort; non-blocking).
    void this.initSubscriber();

    logger.info('WebSocket server attached at /ws', { instanceId: this.instanceId });
  }

  /**
   * Server-side subscription ACL (SEC-005). Allowlist, not blocklist:
   * a channel is subscribable only when it is namespaced to the
   * authenticated user — `user:<uid>:...` where <uid> is the connection's
   * own userId. Everything else (other users' channels, table-level
   * firehoses like `table:messages:INSERT`, arbitrary strings) is denied.
   *
   * Publishers MUST therefore publish user-scoped events to
   * `user:<uid>:<topic>` channels. Add new allowlist rules here if a
   * genuinely shared (non-user-scoped) channel is ever introduced.
   */
  private canSubscribe(client: WsClient, channel: string): boolean {
    if (!client.userId) return false;
    return channel.startsWith(`user:${client.userId}:`);
  }

  /**
   * Open a dedicated Redis connection in subscribe mode. A subscriber
   * connection can't issue regular commands, so we duplicate() the main
   * `redis` client (inherits host/tls/keyPrefix config).
   */
  private async initSubscriber(): Promise<void> {
    try {
      this.subscriber = redis.duplicate();

      this.subscriber.on('error', (err) => {
        logger.warn('WS fan-out subscriber error', { error: err.message });
      });

      this.subscriber.on('ready', () => {
        logger.info('WS fan-out subscriber ready', { instanceId: this.instanceId });
      });

      this.subscriber.on('message', (_channel, raw) => {
        this.handleFanoutMessage(raw);
      });

      await this.subscriber.subscribe(WsRealtimeProvider.FANOUT_CHANNEL);
      this.subscriberReady = true;
    } catch (err: any) {
      logger.warn('WS fan-out subscriber unavailable — falling back to in-process only', {
        error: err?.message,
      });
      this.subscriberReady = false;
    }
  }

  /**
   * Receive a message originated by another task (or ourselves) and
   * dispatch it to any local clients subscribed to the channel.
   */
  private handleFanoutMessage(raw: string): void {
    let envelope: FanoutEnvelope;
    try {
      envelope = JSON.parse(raw) as FanoutEnvelope;
    } catch {
      return;
    }

    // We already dispatched to our own clients synchronously in publish();
    // skip the echo so we don't double-send.
    if (envelope.origin === this.instanceId) return;

    this.dispatchLocal(envelope.channel, envelope.message, envelope.wildcardChannel);
  }

  /**
   * Synchronously send a pre-serialized message to every local client
   * subscribed to `channel` (or, if provided, the wildcardChannel alias).
   */
  private dispatchLocal(channel: string, message: string, wildcardChannel?: string): void {
    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (client.channels.has(channel) || (wildcardChannel && client.channels.has(wildcardChannel))) {
        client.ws.send(message);
      }
    }
  }

  /**
   * Best-effort PUBLISH to Redis so other tasks can fan the event out to
   * their own clients. Local dispatch has already happened; failures here
   * only affect cross-task delivery.
   */
  private async publishFanout(envelope: FanoutEnvelope): Promise<void> {
    if (!this.subscriberReady) return; // Redis bridge not up — single-task mode
    try {
      await redis.publish(WsRealtimeProvider.FANOUT_CHANNEL, JSON.stringify(envelope));
    } catch (err: any) {
      logger.debug('WS fan-out publish failed (non-critical)', { error: err?.message });
    }
  }

  /**
   * Publish an event to all clients subscribed to the matching channel.
   * Called from services (e.g., after inserting a chat message).
   */
  async publish(channel: string, _event: string, payload: unknown): Promise<void> {
    const message = JSON.stringify({ channel, payload });

    // 1) Local dispatch — zero-latency path for same-task subscribers.
    this.dispatchLocal(channel, message);

    // 2) Cross-task fan-out via Redis.
    void this.publishFanout({ origin: this.instanceId, channel, message });
  }

  /**
   * Broadcast to all clients subscribed to any channel matching a pattern.
   * Useful for table-level broadcasts: publish to "table:messages:INSERT"
   * reaches all clients subscribed to that channel OR to the "table:messages:*"
   * wildcard.
   */
  async publishToTable(table: string, event: 'INSERT' | 'UPDATE' | 'DELETE', payload: unknown): Promise<void> {
    const channel = `table:${table}:${event}`;
    const wildcardChannel = `table:${table}:*`;
    const message = JSON.stringify({ channel, payload });

    this.dispatchLocal(channel, message, wildcardChannel);

    void this.publishFanout({ origin: this.instanceId, channel, message, wildcardChannel });
  }

  async shutdown() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    for (const client of this.clients) {
      client.ws.close();
    }
    this.clients.clear();
    this.wss?.close();

    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe(WsRealtimeProvider.FANOUT_CHANNEL);
        await this.subscriber.quit();
      } catch {
        // Best-effort shutdown; ignore.
      }
      this.subscriber = null;
      this.subscriberReady = false;
    }
  }
}

// Singleton — shared across the app so services can call publish()
export const wsRealtimeProvider = new WsRealtimeProvider();
