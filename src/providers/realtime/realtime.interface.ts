/**
 * Realtime Provider Interface
 * 
 * MIGRATION: Implement for WebSocket, Pusher, Ably, or custom.
 */

export interface RealtimeSubscription {
  unsubscribe(): void;
}

export interface IRealtimeProvider {
  /** Subscribe to a custom channel */
  subscribeToChannel(
    channel: string,
    callback: (payload: any) => void
  ): RealtimeSubscription;

  /** Broadcast a message to a channel */
  broadcast(channel: string, event: string, payload: any): Promise<void>;
}
