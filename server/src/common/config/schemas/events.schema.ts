import { z } from 'zod';

export const eventsSchema = z.object({
  provider: z.enum(['dynamodb', 'mock']).default('dynamodb'),
  endpoint: z.string().url().optional(),
  auditEventsTable: z.string().min(1).default('instaserve-audit-events'),
  fraudSignalsTable: z.string().min(1).default('instaserve-fraud-signals'),
  apiRequestLogsTable: z.string().min(1).default('instaserve-api-request-logs'),
  searchEventsTable: z.string().min(1).default('instaserve-search-events'),
  analyticsEventsTable: z.string().min(1).default('instaserve-analytics-events'),
  communicationLogsTable: z.string().min(1).default('instaserve-communication-logs'),
  recommendationSignalsTable: z.string().min(1).default('instaserve-recommendation-signals'),
});
