// @vitest-environment node

// SEC-006 regression tests: mass assignment / actor forgery on the safety
// endpoints. Server-owned fields must be non-injectable, and safety records
// may only reference bookings the caller is a party to.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError, NotFoundError } from '../../../common/errors/app-error.js';
import { createSafetyAlertSchema, createSafetyCheckSchema } from '../schemas/safety.schema.js';

const dbQuery = vi.fn();
const logAuditEvent = vi.fn();

vi.mock('../../../common/repositories/database.js', () => ({
  dbQuery: (...args: unknown[]) => dbQuery(...args),
}));

vi.mock('../../../common/logging/audit-log.js', () => ({
  logAuditEvent: (...args: unknown[]) => logAuditEvent(...args),
}));

const ATTACKER = 'attacker-uid';
const CUSTOMER = 'customer-uid';
const PROVIDER_USER = 'provider-uid';
const BOOKING_ID = '11111111-1111-4111-8111-111111111111';

function mockBookingLookup(row: { user_id: string; provider_user_id: string | null } | undefined) {
  dbQuery.mockResolvedValueOnce({ rows: row ? [row] : [] });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('safety schemas (allowlist)', () => {
  it('strips server-owned fields from alert payloads', () => {
    const parsed = createSafetyAlertSchema.parse({
      alert_type: 'sos',
      status: 'resolved',
      emergency_contacts_notified: true,
      user_id: 'someone-else',
    });
    expect(parsed).not.toHaveProperty('status');
    expect(parsed).not.toHaveProperty('emergency_contacts_notified');
    expect(parsed).not.toHaveProperty('user_id');
  });

  it('strips initiated_by from check payloads and rejects bad values', () => {
    const parsed = createSafetyCheckSchema.parse({
      booking_id: BOOKING_ID,
      check_type: 'otp_verification',
      response: 'confirmed',
      severity: 'high',
      initiated_by: 'forged-actor',
    });
    expect(parsed).not.toHaveProperty('initiated_by');

    expect(createSafetyCheckSchema.safeParse({
      booking_id: 'not-a-uuid',
      check_type: 'otp_verification',
      response: 'confirmed',
      severity: 'high',
    }).success).toBe(false);

    expect(createSafetyCheckSchema.safeParse({
      booking_id: BOOKING_ID,
      check_type: 'made_up_check',
      response: 'confirmed',
      severity: 'high',
    }).success).toBe(false);
  });

  it('rejects out-of-range coordinates and unknown alert types', () => {
    expect(createSafetyAlertSchema.safeParse({ alert_type: 'fraud_signal' }).success).toBe(false);
    expect(createSafetyAlertSchema.safeParse({ location_lat: 91 }).success).toBe(false);
  });
});

describe('SafetyService.createCheck', () => {
  it('rejects a caller who is not a party to the booking, without inserting', async () => {
    mockBookingLookup({ user_id: CUSTOMER, provider_user_id: PROVIDER_USER });
    const { safetyService } = await import('./safety.service.js');

    await expect(
      safetyService.createCheck(ATTACKER, {
        booking_id: BOOKING_ID,
        check_type: 'otp_verification',
        response: 'confirmed',
        severity: 'high',
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(dbQuery).toHaveBeenCalledTimes(1); // lookup only, no INSERT
  });

  it('rejects a non-existent booking', async () => {
    mockBookingLookup(undefined);
    const { safetyService } = await import('./safety.service.js');

    await expect(
      safetyService.createCheck(ATTACKER, {
        booking_id: BOOKING_ID,
        check_type: 'otp_verification',
        response: 'confirmed',
        severity: 'high',
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('writes the authenticated caller as initiated_by for a booking party', async () => {
    mockBookingLookup({ user_id: CUSTOMER, provider_user_id: PROVIDER_USER });
    dbQuery.mockResolvedValueOnce({ rows: [{ id: 'check-1' }] });
    const { safetyService } = await import('./safety.service.js');

    await safetyService.createCheck(PROVIDER_USER, {
      booking_id: BOOKING_ID,
      check_type: 'companion_present',
      response: 'yes',
      severity: 'high',
    });

    const [sql, params] = dbQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO safety_checks');
    expect(params[2]).toBe(PROVIDER_USER); // initiated_by = authenticated caller
  });
});

describe('SafetyService.createAlert', () => {
  it('rejects an alert referencing someone else’s booking', async () => {
    mockBookingLookup({ user_id: CUSTOMER, provider_user_id: PROVIDER_USER });
    const { safetyService } = await import('./safety.service.js');

    await expect(
      safetyService.createAlert(ATTACKER, { booking_id: BOOKING_ID, alert_type: 'sos' })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('inserts with server-owned status/notified values, no ownership lookup when bookingless', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: 'alert-1', alert_type: 'sos', booking_id: null }] });
    const { safetyService } = await import('./safety.service.js');

    await safetyService.createAlert(CUSTOMER, { alert_type: 'sos' });

    expect(dbQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = dbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("'open', false"); // status + emergency_contacts_notified are literals
    expect(params[0]).toBe(CUSTOMER);
    expect(params).toHaveLength(6); // no client-controlled status/notified params
    expect(logAuditEvent).toHaveBeenCalledOnce();
  });

  it('allows the booking customer to attach their own booking', async () => {
    mockBookingLookup({ user_id: CUSTOMER, provider_user_id: PROVIDER_USER });
    dbQuery.mockResolvedValueOnce({ rows: [{ id: 'alert-2', booking_id: BOOKING_ID }] });
    const { safetyService } = await import('./safety.service.js');

    const result = await safetyService.createAlert(CUSTOMER, {
      booking_id: BOOKING_ID,
      alert_type: 'unsafe_feeling',
    });
    expect(result.data.id).toBe('alert-2');
  });
});
