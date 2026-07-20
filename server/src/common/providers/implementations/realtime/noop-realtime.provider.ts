import type { IRealtimeProvider } from '../../interfaces/realtime-provider.interface.js';

export class NoopRealtimeProvider implements IRealtimeProvider {
  async publish(_channel: string, _event: string, _payload: unknown): Promise<void> {
    // Placeholder for future WebSocket / pub-sub integration.
  }
}

export const noopRealtimeProvider = new NoopRealtimeProvider();
