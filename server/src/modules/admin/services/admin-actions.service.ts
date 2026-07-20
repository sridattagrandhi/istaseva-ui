import type pg from 'pg';
import { logAuditEvent } from '../../../common/logging/audit-log.js';
import {
  adminActionsRepository,
  type AdminActionFilters,
  type AdminActionInsert,
  type AdminActionRow,
} from '../repositories/admin-actions.repository.js';

export interface RecordAdminActionInput extends AdminActionInsert {
  /**
   * Firebase UID of the user the action ultimately concerns (the suspended
   * user, the banned listing's host, the refunded guest). Used as the
   * DynamoDB audit_events partition key so the action shows up in that
   * user's entity timeline. Falls back to the actor when omitted.
   */
  targetUserId?: string | null;
  bookingId?: string | null;
  paymentId?: string | null;
}

/**
 * Every admin mutation goes through here. Postgres `admin_actions` is the
 * source of truth (queryable by actor/action/target/date); the DynamoDB
 * audit_events mirror is fire-and-forget so entity timelines stay complete.
 * Pass `client` to write the Postgres row inside the mutation's transaction.
 */
export const adminActionsService = {
  async record(input: RecordAdminActionInput, client?: pg.PoolClient): Promise<AdminActionRow> {
    const { targetUserId, bookingId, paymentId, ...insert } = input;
    const row = await adminActionsRepository.insert(insert, client);

    logAuditEvent({
      event: input.action,
      user_id: targetUserId ?? input.actorUserId,
      booking_id: bookingId ?? (input.targetType === 'booking' ? input.targetId : null),
      payment_id: paymentId ?? null,
      metadata: {
        ...(input.metadata ?? {}),
        actorUserId: input.actorUserId,
        targetType: input.targetType,
        targetId: input.targetId,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });

    return row;
  },

  async list(filters: AdminActionFilters) {
    return adminActionsRepository.list(filters);
  },
};
