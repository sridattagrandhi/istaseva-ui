/**
 * Audit Log Service
 * 
 * Records trust-sensitive actions for auditability.
 * Currently in-memory; ready for audit_logs table.
 */

import type { AuditLogEntry, UUID } from '@/types/domain';
import { getAnalyticsProvider } from '@/config/providers';

export class AuditService {
  private analytics = getAnalyticsProvider();
  private logs: AuditLogEntry[] = [];

  /** Log an auditable action */
  log(params: {
    userId?: UUID;
    action: string;
    resource: string;
    resourceId?: UUID;
    metadata?: Record<string, any>;
  }): void {
    const entry: AuditLogEntry = {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      userId: params.userId,
      action: params.action,
      resource: params.resource,
      resourceId: params.resourceId,
      metadata: params.metadata,
      createdAt: new Date().toISOString(),
    };

    this.logs.push(entry);
    this.analytics.track('audit_event', {
      action: params.action,
      resource: params.resource,
    });
  }

  /** Get recent audit entries */
  getRecentLogs(limit = 50): AuditLogEntry[] {
    return this.logs.slice(-limit);
  }
}

let _instance: AuditService | null = null;
export function getAuditService(): AuditService {
  if (!_instance) _instance = new AuditService();
  return _instance;
}
