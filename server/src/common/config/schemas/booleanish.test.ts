// @vitest-environment node

// Regression tests for the SMTP_SECURE boolean-coercion footgun: with
// z.coerce.boolean(), the env string "false" coerced to true (Boolean("false")
// === true), silently enabling TLS-on-connect. booleanish parses the string
// value explicitly.

import { describe, it, expect } from 'vitest';
import { booleanish } from './booleanish.js';
import { notificationSchema } from './notification.schema.js';
import { authSchema } from './auth.schema.js';

describe('booleanish', () => {
  it('parses "true"/"false" strings to the matching boolean', () => {
    expect(booleanish.parse('true')).toBe(true);
    expect(booleanish.parse('false')).toBe(false);
  });

  it('is case/whitespace tolerant and passes booleans through', () => {
    expect(booleanish.parse(' TRUE ')).toBe(true);
    expect(booleanish.parse('False')).toBe(false);
    expect(booleanish.parse(true)).toBe(true);
    expect(booleanish.parse(false)).toBe(false);
  });

  it('rejects garbage instead of silently coercing it', () => {
    expect(booleanish.safeParse('yes').success).toBe(false);
    expect(booleanish.safeParse('1').success).toBe(false);
    expect(booleanish.safeParse('').success).toBe(false);
  });
});

describe('smtpSecure env parsing (notification schema)', () => {
  const base = {};

  it('SMTP_SECURE="false" stays false (the original footgun)', () => {
    expect(notificationSchema.parse({ ...base, smtpSecure: 'false' }).smtpSecure).toBe(false);
  });

  it('SMTP_SECURE="true" parses to true', () => {
    expect(notificationSchema.parse({ ...base, smtpSecure: 'true' }).smtpSecure).toBe(true);
  });

  it('defaults to false when unset', () => {
    expect(notificationSchema.parse(base).smtpSecure).toBe(false);
  });
});

describe('passwordReset.mobileDeepLink env parsing (auth schema)', () => {
  const base = { firebase: {}, jwt: { secret: 's' }, passwordReset: {} };

  it('"false" stays false and "true" parses to true', () => {
    expect(
      authSchema.parse({ ...base, passwordReset: { mobileDeepLink: 'false' } }).passwordReset
        .mobileDeepLink
    ).toBe(false);
    expect(
      authSchema.parse({ ...base, passwordReset: { mobileDeepLink: 'true' } }).passwordReset
        .mobileDeepLink
    ).toBe(true);
  });
});
