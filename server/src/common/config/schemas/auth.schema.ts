import { z } from 'zod';
import { booleanish } from './booleanish.js';

export const authSchema = z.object({
  provider: z.enum(['jwt', 'firebase']).default('jwt'),
  firebase: z.object({
    projectId: z.string().optional(),
    serviceAccountPath: z.string().optional(), // local dev: path to service-account.json file
    serviceAccountJson: z.string().optional(), // ECS / production: JSON string from Secrets Manager
  }),
  jwt: z.object({
    secret: z.string().min(1),
  }),
  /** Password-reset link generation. The web `/reset-password` page always
   *  works; mobile in-app deep-linking is opt-in and only kicks in when
   *  `mobileDeepLink` is enabled AND the target Firebase Dynamic Links /
   *  App Links config exists. Left off, the reset link lands on the web
   *  page for both surfaces. */
  passwordReset: z.object({
    webPath: z.string().default('/reset-password'),
    mobileDeepLink: booleanish.default(false),
    iosBundleId: z.string().optional(),
    androidPackageName: z.string().optional(),
    dynamicLinkDomain: z.string().optional(),
  }),
});
