/**
 * WebSocket Realtime Provider
 *
 * Connects to a WebSocket server for real-time updates.
 * Replaces Supabase Realtime when running on own infrastructure.
 *
 * Setup:
 * 1. Deploy WebSocket server (or use API Gateway WebSocket)
 * 2. Set VITE_WS_URL in .env
 * 3. Swap in src/config/providers.ts: getRealtimeProvider() → new WebSocketRealtimeProvider()
 */

import type { IRealtimeProvider, RealtimeSubscription } from './realtime.interface';
import { frontendConfig } from '@/config/frontend';
import { apiRequest, getAccessToken } from '@/lib/api-client';

export class WebSocketRealtimeProvider implements IRealtimeProvider {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private listeners: Map<string, Set<(payload: any) => void>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private connecting = false;

  constructor() {
    this.wsUrl = frontendConfig.realtime.wsUrl;
    void this.connect();
  }

  private async connect() {
    // Single-flight: subscribeToChannel() can also trigger a reconnect, so
    // guard against opening two sockets in parallel.
    if (this.connecting) return;
    this.connecting = true;
    try {
      // Don't even attempt a connection for signed-out users. The provider is
      // constructed eagerly (chatService is a singleton), so without this an
      // anonymous page load would fire a burst of guaranteed-401 ticket
      // requests. A later subscribe (post-login) revives us via reconnect.
      const token = await getAccessToken();
      if (!token) {
        this.scheduleReconnect();
        return;
      }

      // SEC-008: never put the bearer token in the WS URL (query strings
      // leak into logs/proxies). Mint a short-lived single-use connect
      // ticket over the authenticated HTTPS API instead.
      const ticketResult = await apiRequest<{ ticket?: string }>('/api/auth/ws-ticket', {
        method: 'POST',
      });
      const ticket = ticketResult.success ? ticketResult.data?.ticket : undefined;
      if (!ticket) {
        // Signed out or backend unreachable — retry with the same backoff
        // the onclose path uses (a later subscribe also revives us).
        this.scheduleReconnect();
        return;
      }

      this.ws = new WebSocket(`${this.wsUrl}?ticket=${encodeURIComponent(ticket)}`);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        // Re-subscribe to all channels
        for (const channel of this.listeners.keys()) {
          this.ws?.send(JSON.stringify({ type: 'subscribe', channel }));
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const { channel, payload } = data;
          const channelListeners = this.listeners.get(channel);
          if (channelListeners) {
            channelListeners.forEach((cb) => cb(payload));
          }
        } catch {
          // Ignore malformed messages
        }
      };

      this.ws.onclose = () => {
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      // WebSocket not available
    } finally {
      this.connecting = false;
    }
  }

  /** Exponential-backoff retry shared by onclose and ticket-mint failures. */
  private scheduleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
      this.reconnectAttempts++;
      setTimeout(() => { void this.connect(); }, delay);
    }
  }

  subscribeToChannel(channel: string, callback: (payload: any) => void): RealtimeSubscription {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
    }
    this.listeners.get(channel)!.add(callback);

    // Send subscribe message
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', channel }));
    } else if (this.ws?.readyState !== WebSocket.CONNECTING) {
      // Socket is dead (e.g. the server rejects unauthenticated connects,
      // so a provider constructed pre-login exhausts its retries). A new
      // subscription is an explicit signal to try again with the current
      // token — onopen re-subscribes every channel in `listeners`.
      this.reconnectAttempts = 0;
      void this.connect();
    }

    return {
      unsubscribe: () => {
        const channelListeners = this.listeners.get(channel);
        if (channelListeners) {
          channelListeners.delete(callback);
          if (channelListeners.size === 0) {
            this.listeners.delete(channel);
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ type: 'unsubscribe', channel }));
            }
          }
        }
      },
    };
  }

  async broadcast(channel: string, event: string, payload: any): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'broadcast', channel, event, payload }));
    }
  }
}
