import { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../../../common/errors/app-error.js';
import { getEventProvider } from '../../../common/providers/registry.js';
import { adminActionsService } from '../services/admin-actions.service.js';
import { strList } from './admin-bookings.controller.js';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class AdminAuditController {
  /** Postgres admin_actions — every admin mutation, filterable on all axes. */
  async listActions(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const { rows, total } = await adminActionsService.list({
        actorUserId: str(req.query.actor),
        action: str(req.query.action),
        targetType: str(req.query.targetType),
        targetId: str(req.query.targetId),
        // Listing vertical/category facets (comma-separated multi-selects) —
        // only listing-target rows can match while these are active.
        types: strList(req.query.types),
        categories: strList(req.query.categories),
        from: str(req.query.from),
        to: str(req.query.to),
        limit,
        offset,
      });
      res.json({ actions: rows.map(({ total_count: _t, ...row }) => row), total, limit, offset });
    } catch (err) { next(err); }
  }

  /**
   * DynamoDB audit_events passthrough — the per-entity timeline. Query by
   * `userId` (partition key) or by `resource`+`resourceId` (resource-index
   * GSI, e.g. resource=booking&resourceId=<uuid>). One of the two is required.
   */
  async listEvents(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = str(req.query.userId);
      const resource = str(req.query.resource);
      const resourceId = str(req.query.resourceId);
      const timeRange = { from: str(req.query.from), to: str(req.query.to) };
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

      const provider = await getEventProvider();
      let events;
      if (userId) {
        events = await provider.queryByUser('audit_events', userId, timeRange);
      } else if (resource && resourceId) {
        events = await provider.queryByResource('audit_events', resource, resourceId, timeRange);
      } else {
        throw new ValidationError('Provide either userId or resource + resourceId');
      }

      res.json({ events: events.slice(0, limit), truncated: events.length > limit });
    } catch (err) { next(err); }
  }
}

export const adminAuditController = new AdminAuditController();
