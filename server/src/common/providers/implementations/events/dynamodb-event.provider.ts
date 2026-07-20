import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { config } from '../../../config/index.js';
import type {
  BaseEventRecord,
  EventTableName,
  EventTimeRange,
  IEventProvider,
} from '../../interfaces/event-provider.interface.js';

const client = new DynamoDBClient({
  region: config.aws.region,
  ...(config.events.endpoint ? { endpoint: config.events.endpoint } : {}),
  ...(config.aws.accessKeyId && config.aws.secretAccessKey
    ? {
        credentials: {
          accessKeyId: config.aws.accessKeyId,
          secretAccessKey: config.aws.secretAccessKey,
        },
      }
    : {}),
});

const documentClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

const tableNameMap: Record<EventTableName, string> = {
  audit_events: config.events.auditEventsTable,
  fraud_signals: config.events.fraudSignalsTable,
  api_request_logs: config.events.apiRequestLogsTable,
  search_events: config.events.searchEventsTable,
  analytics_events: config.events.analyticsEventsTable,
  communication_logs: config.events.communicationLogsTable,
  recommendation_signals: config.events.recommendationSignalsTable,
};

function buildSortKey(timestamp: string, itemId: string) {
  return `${timestamp}#${itemId}`;
}

function applyTimeRange(expressionValues: Record<string, unknown>, timeRange?: EventTimeRange) {
  if (!timeRange?.from && !timeRange?.to) {
    return undefined;
  }

  if (timeRange.from && timeRange.to) {
    expressionValues[':from'] = timeRange.from;
    expressionValues[':to'] = `${timeRange.to}#~`;
    return ' BETWEEN :from AND :to';
  }

  if (timeRange.from) {
    expressionValues[':from'] = timeRange.from;
    return ' >= :from';
  }

  expressionValues[':to'] = `${timeRange?.to}#~`;
  return ' <= :to';
}

class DynamoDbEventProvider implements IEventProvider {
  async putEvent(table: EventTableName, item: Record<string, unknown>): Promise<void> {
    const timestamp = typeof item.timestamp === 'string' ? item.timestamp : new Date().toISOString();
    const id =
      (typeof item.eventId === 'string' && item.eventId)
      || (typeof item.signalId === 'string' && item.signalId)
      || (typeof item.requestId === 'string' && item.requestId)
      || (typeof item.searchId === 'string' && item.searchId)
      || randomUUID();

    const preparedItem = {
      ...item,
      timestamp,
      eventId: typeof item.eventId === 'string' ? item.eventId : undefined,
      userId: typeof item.userId === 'string' ? item.userId : 'system',
      sortKey: buildSortKey(timestamp, id),
      resourceKey: item.resource && item.resourceId ? `${item.resource}#${item.resourceId}` : undefined,
    };

    // Both api_request_logs and analytics_events carry a `date` (YYYY-MM-DD)
    // attribute — for analytics_events it is the partition key of the
    // `date-index` GSI the nightly rollup queries one day at a time.
    const needsDate = table === 'api_request_logs' || table === 'analytics_events';

    await documentClient.send(new PutCommand({
      TableName: tableNameMap[table],
      Item: needsDate
        ? {
            ...preparedItem,
            date: typeof item.date === 'string' ? item.date : timestamp.slice(0, 10),
          }
        : preparedItem,
    }));
  }

  async queryByUser<T extends BaseEventRecord = BaseEventRecord>(
    table: EventTableName,
    userId: string,
    timeRange?: EventTimeRange
  ): Promise<T[]> {
    if (table === 'api_request_logs') {
      return [];
    }

    const expressionValues: Record<string, unknown> = {
      ':userId': userId,
    };
    const rangeClause = applyTimeRange(expressionValues, timeRange);

    const result = await documentClient.send(new QueryCommand({
      TableName: tableNameMap[table],
      KeyConditionExpression: `userId = :userId${rangeClause ? ` AND sortKey${rangeClause}` : ''}`,
      ExpressionAttributeValues: expressionValues,
      ScanIndexForward: false,
    }));

    return (result.Items ?? []) as T[];
  }

  async queryByResource<T extends BaseEventRecord = BaseEventRecord>(
    table: EventTableName,
    resource: string,
    resourceId: string,
    timeRange?: EventTimeRange
  ): Promise<T[]> {
    if (table !== 'audit_events') {
      return [];
    }

    const expressionValues: Record<string, unknown> = {
      ':resourceKey': `${resource}#${resourceId}`,
    };
    const rangeClause = applyTimeRange(expressionValues, timeRange);

    const result = await documentClient.send(new QueryCommand({
      TableName: tableNameMap[table],
      IndexName: 'resource-index',
      KeyConditionExpression: `resourceKey = :resourceKey${rangeClause ? ` AND timestamp${rangeClause.replace(/sk/g, 'timestamp')}` : ''}`,
      ExpressionAttributeValues: expressionValues,
      ScanIndexForward: false,
    }));

    return (result.Items ?? []) as T[];
  }

  async queryByDate<T extends BaseEventRecord = BaseEventRecord>(
    table: EventTableName,
    date: string
  ): Promise<T[]> {
    // Only analytics_events carries the `date-index` GSI.
    if (table !== 'analytics_events') {
      return [];
    }

    const items: T[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await documentClient.send(new QueryCommand({
        TableName: tableNameMap[table],
        IndexName: 'date-index',
        // `date` is a DynamoDB reserved word — alias it.
        KeyConditionExpression: '#d = :date',
        ExpressionAttributeNames: { '#d': 'date' },
        ExpressionAttributeValues: { ':date': date },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }));
      items.push(...((result.Items ?? []) as T[]));
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);

    return items;
  }

  /**
   * Account-deletion erasure (PRIV-002): delete every item in the user's
   * partition. Pages the key-only query, then BatchWrites deletes in chunks
   * of 25 (the DynamoDB limit), retrying unprocessed items. Idempotent —
   * a re-run after partial failure deletes whatever remains.
   * api_request_logs is not user-partitioned; it returns 0 and relies on TTL.
   */
  async deleteByUser(table: EventTableName, userId: string): Promise<number> {
    if (table === 'api_request_logs') {
      return 0;
    }

    const tableName = tableNameMap[table];
    let deleted = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const page = await documentClient.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        ProjectionExpression: 'userId, sortKey',
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }));

      const keys = (page.Items ?? []).map((item) => ({
        userId: item.userId as string,
        sortKey: item.sortKey as string,
      }));

      for (let i = 0; i < keys.length; i += 25) {
        let requests = keys.slice(i, i + 25).map((key) => ({ DeleteRequest: { Key: key } }));
        // Retry unprocessed items a few times with linear backoff; anything
        // still unprocessed after that surfaces as an error so the
        // orchestrator retries the whole (idempotent) stage.
        for (let attempt = 0; requests.length > 0; attempt++) {
          if (attempt >= 5) {
            throw new Error(`deleteByUser: ${requests.length} unprocessed deletes for ${table}`);
          }
          if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
          }
          const result = await documentClient.send(new BatchWriteCommand({
            RequestItems: { [tableName]: requests },
          }));
          const unprocessed = result.UnprocessedItems?.[tableName] ?? [];
          deleted += requests.length - unprocessed.length;
          requests = unprocessed as typeof requests;
        }
      }

      exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);

    return deleted;
  }
}

export const dynamoDbEventProvider = new DynamoDbEventProvider();
