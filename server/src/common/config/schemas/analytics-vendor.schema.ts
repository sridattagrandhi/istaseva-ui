import { z } from 'zod';

/**
 * Third-party analytics vendor credentials, used ONLY for privacy plumbing
 * (account-deletion vendor-erasure requests, PRIV-002). The web client talks
 * to Mixpanel directly with its own VITE_MIXPANEL_TOKEN; the server never
 * sends analytics events.
 *
 *  - MIXPANEL_PROJECT_TOKEN — same project token the web client uses.
 *  - MIXPANEL_GDPR_TOKEN    — Mixpanel OAuth token for the GDPR/deletion API
 *    (Mixpanel account settings → Data & Privacy).
 *
 * Both unset (the default) = Mixpanel not in use → deletion requests no-op.
 */
export const analyticsVendorSchema = z.object({
  mixpanelProjectToken: z.string().optional(),
  mixpanelGdprToken: z.string().optional(),
});
