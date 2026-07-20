import { NotFoundError } from '../../../common/errors/app-error.js';
import { usersRepository } from '../repositories/users.repository.js';
import { LEGAL_DOCS_VERSION, MARKETING_CONSENT_VERSION, ANALYTICS_CONSENT_VERSION, AGE_CONFIRMATION_VERSION } from '../legal-docs-version.js';

/** The recorded version stamped onto each consent type's trail row. */
function versionForConsent(consentType: string): string {
  if (consentType === 'terms') return LEGAL_DOCS_VERSION;
  if (consentType === 'analytics') return ANALYTICS_CONSENT_VERSION;
  if (consentType === 'age_confirmation') return AGE_CONFIRMATION_VERSION;
  return MARKETING_CONSENT_VERSION;
}

export class UsersService {
  async getMyProfile(userId: string) {
    const result = await usersRepository.getByUserId(userId);

    if (!result.rows[0]) throw new NotFoundError('User profile', userId);
    return { data: result.rows[0] };
  }

  async updateMyProfile(userId: string, updates: Record<string, unknown>) {
    const result = await usersRepository.updateByUserId(userId, updates);

    if (!result.rows[0]) throw new NotFoundError('User profile', userId);
    return { data: result.rows[0] };
  }

  /** Current consent state: latest row per type from the append-only trail. */
  async getMyConsents(userId: string) {
    const result = await usersRepository.getLatestConsents(userId);
    return { data: result.rows };
  }

  async setMyConsent(input: {
    userId: string;
    consentType: string;
    granted: boolean;
    ipAddress?: string | null;
    userAgent?: string | null;
  }) {
    const result = await usersRepository.insertConsent({
      userId: input.userId,
      consentType: input.consentType,
      // The server is the single source of truth for the recorded version —
      // see legal-docs-version.ts (clients only display their mirror copy).
      version: versionForConsent(input.consentType),
      granted: input.granted,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
    return { data: result.rows[0] };
  }

  /**
   * Server-side marketing-consent gate (LEG-014). Any marketing / promotional
   * send path MUST check this before contacting a user; transactional
   * notifications (booking confirmations, receipts, security) are exempt and
   * do NOT call it. Reads the latest 'marketing' row from the append-only
   * trail — absent means never opted in, so default deny. (There is no
   * marketing sender in the product yet; this is the gate one must use.)
   */
  async hasMarketingConsent(userId: string): Promise<boolean> {
    const result = await usersRepository.getLatestConsents(userId);
    const row = result.rows.find((r) => r.consent_type === 'marketing');
    return !!row?.granted;
  }
}

export const usersService = new UsersService();
