/**
 * Future implementations:
 * - API Gateway WebSocket
 * - Pusher / Ably
 * - Redis pub-sub bridge
 */
export interface IRealtimeProvider {
  publish(channel: string, event: string, payload: unknown): Promise<void>;
}
