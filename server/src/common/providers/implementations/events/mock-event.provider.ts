import type {
  BaseEventRecord,
  EventTableName,
  EventTimeRange,
  IEventProvider,
} from '../../interfaces/event-provider.interface.js';

type EventStore = Map<EventTableName, Record<string, unknown>[]>;

function withinRange(timestamp: string, timeRange?: EventTimeRange) {
  if (!timeRange?.from && !timeRange?.to) return true;

  const value = new Date(timestamp).getTime();
  if (timeRange.from && value < new Date(timeRange.from).getTime()) return false;
  if (timeRange.to && value > new Date(timeRange.to).getTime()) return false;
  return true;
}

class MockEventProvider implements IEventProvider {
  private readonly store: EventStore = new Map();

  async putEvent(table: EventTableName, item: Record<string, unknown>): Promise<void> {
    const current = this.store.get(table) ?? [];
    current.push({ ...item });
    this.store.set(table, current);
  }

  async queryByUser<T extends BaseEventRecord = BaseEventRecord>(
    table: EventTableName,
    userId: string,
    timeRange?: EventTimeRange
  ): Promise<T[]> {
    const items = this.store.get(table) ?? [];
    return items.filter((item) => (
      item.userId === userId && typeof item.timestamp === 'string' && withinRange(item.timestamp, timeRange)
    )) as T[];
  }

  async queryByResource<T extends BaseEventRecord = BaseEventRecord>(
    table: EventTableName,
    resource: string,
    resourceId: string,
    timeRange?: EventTimeRange
  ): Promise<T[]> {
    const items = this.store.get(table) ?? [];
    return items.filter((item) => (
      item.resource === resource
      && item.resourceId === resourceId
      && typeof item.timestamp === 'string'
      && withinRange(item.timestamp, timeRange)
    )) as T[];
  }

  async queryByDate<T extends BaseEventRecord = BaseEventRecord>(
    table: EventTableName,
    date: string
  ): Promise<T[]> {
    const items = this.store.get(table) ?? [];
    return items.filter((item) => item.date === date) as T[];
  }

  async deleteByUser(table: EventTableName, userId: string): Promise<number> {
    const items = this.store.get(table) ?? [];
    const kept = items.filter((item) => item.userId !== userId);
    this.store.set(table, kept);
    return items.length - kept.length;
  }
}

export const mockEventProvider = new MockEventProvider();
