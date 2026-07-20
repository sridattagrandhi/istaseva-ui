import { config } from '../../../common/config/index.js';
import { logger } from '../../../common/logging/logger.js';

/**
 * Vendor-erasure request to Mixpanel (PRIV-002: "vendor deletion/retention
 * requests"). The web client identifies users to Mixpanel with the Firebase
 * UID as $distinct_id, so account deletion asks Mixpanel to erase that id
 * via its GDPR deletion-task API.
 *
 * Result shape distinguishes three outcomes for the audit trail:
 *  - { requested: false, reason: 'not_configured' } — Mixpanel isn't in use.
 *  - { requested: true, taskId }                    — deletion task accepted.
 *  - throws                                         — configured but failed;
 *    the caller lets the deletion job fail so the sweeper retries (vendor
 *    erasure must not be silently dropped once the vendor is live).
 */
export async function requestMixpanelDeletion(
  userId: string,
): Promise<{ requested: boolean; reason?: string; taskId?: string }> {
  const { mixpanelProjectToken, mixpanelGdprToken } = config.analyticsVendor;
  if (!mixpanelProjectToken || !mixpanelGdprToken) {
    return { requested: false, reason: 'not_configured' };
  }

  const response = await fetch(
    `https://mixpanel.com/api/app/data-deletions/v3.0/?token=${encodeURIComponent(mixpanelProjectToken)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mixpanelGdprToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ distinct_ids: [userId], compliance_type: 'GDPR' }),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Mixpanel deletion request failed: ${response.status} ${body.slice(0, 300)}`);
  }

  const payload = (await response.json().catch(() => ({}))) as { results?: { task_id?: string } };
  const taskId = payload.results?.task_id;
  logger.info('Mixpanel deletion task created', { userId, taskId });
  return { requested: true, taskId };
}
