import { dbQuery } from '../../../common/repositories/database.js';

const USER_PROFILE_MUTABLE_FIELDS = new Set([
  'display_name',
  'avatar_url',
  'bio',
  'phone',
  'location',
  'preferred_language',
]);

export class UsersRepository {
  getByUserId(userId: string) {
    return dbQuery(
      'SELECT * FROM user_profiles WHERE user_id = $1 LIMIT 1',
      [userId]
    );
  }

  /**
   * Find an existing account where BOTH the email (case-insensitive) AND the
   * phone match the same profile — used to link a host-on-behalf booking to
   * the guest's own account so it surfaces in their dashboard. Requiring both
   * prevents mis-linking on a phone collision or a shared/typo'd email; if
   * either is missing or they belong to different accounts, no row is
   * returned and the booking stays owned by the host.
   *
   * Phone comparison is country-code aware: profiles store E.164-style values
   * ("+919876543210" — Login prepends the country code) while a host at the
   * desk usually types the local 10 digits. Both sides are stripped to digits
   * and compared on their LAST 10 (the Indian subscriber number), which makes
   * "+91 98765 43210", "09876543210" and "9876543210" all equal. Anything
   * shorter than 10 digits can't match. Email must ALSO match, so the looser
   * phone rule can't mis-link on its own.
   */
  findByEmailAndPhone(email: string | null | undefined, phone: string | null | undefined) {
    const phoneDigits = (phone ?? '').replace(/\D/g, '');
    if (!email?.trim() || phoneDigits.length < 10) {
      return Promise.resolve({ rows: [] as Array<{ user_id: string; email: string | null; phone: string | null }> });
    }
    return dbQuery<{ user_id: string; email: string | null; phone: string | null }>(
      `SELECT user_id, email, phone FROM user_profiles
       WHERE email IS NOT NULL AND lower(email) = lower($1)
         AND phone IS NOT NULL
         AND length(regexp_replace(phone, '\\D', '', 'g')) >= 10
         AND RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = RIGHT($2, 10)
       LIMIT 1`,
      [email.trim(), phoneDigits],
    );
  }

  /**
   * Append-only consent trail (consent_records, added in migration
   * 20260411123000 and unused until now). Current state = latest row per
   * consent_type; a toggle-off writes a granted=false row rather than
   * deleting history — DPDP wants an auditable record of when consent was
   * given and withdrawn.
   */
  insertConsent(input: {
    userId: string;
    consentType: string;
    version: string;
    granted: boolean;
    ipAddress?: string | null;
    userAgent?: string | null;
  }) {
    return dbQuery(
      `INSERT INTO consent_records (user_id, consent_type, version, granted, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, consent_type, version, granted, created_at`,
      [input.userId, input.consentType, input.version, input.granted, input.ipAddress ?? null, input.userAgent ?? null],
    );
  }

  /** Latest row per consent_type for the user (covered by idx_consent_records_user). */
  getLatestConsents(userId: string) {
    return dbQuery<{ consent_type: string; version: string; granted: boolean; created_at: string }>(
      `SELECT DISTINCT ON (consent_type) consent_type, version, granted, created_at
       FROM consent_records
       WHERE user_id = $1
       ORDER BY consent_type, created_at DESC`,
      [userId],
    );
  }

  updateByUserId(userId: string, updates: Record<string, unknown>) {
    const entries = Object.entries(updates).filter(([key]) => USER_PROFILE_MUTABLE_FIELDS.has(key));

    if (entries.length === 0) {
      return this.getByUserId(userId);
    }

    const assignments = entries.map(([key], index) => `"${key}" = $${index + 1}`);
    const values = entries.map(([, value]) => value);
    values.push(userId);

    return dbQuery(
      `UPDATE user_profiles
       SET ${assignments.join(', ')}, updated_at = NOW()
       WHERE user_id = $${values.length}
       RETURNING *`,
      values
    );
  }
}

export const usersRepository = new UsersRepository();
