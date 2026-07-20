import { z } from 'zod';
import { booleanish } from './booleanish.js';

export const notificationSchema = z.object({
  provider: z.enum(['default', 'mock']).default('default'),
  sesFromEmail: z.string().email().default('noreply@istasewa.in'),
  snsSenderId: z.string().min(1).default('IstaSeva'),
  sqsQueueUrl: z.string().url().optional(),
  // SMTP — when SMTP_HOST is set, transactional emails route through
  // nodemailer instead of the SES SDK. Lets us point at any SMTP server
  // (SES SMTP interface, SendGrid, Postmark, Gmail, self-hosted Postfix)
  // without code changes. Leave SMTP_HOST unset to keep the SES SDK path.
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).default(587),
  smtpUser: z.string().min(1).optional(),
  smtpPass: z.string().min(1).optional(),
  smtpFromEmail: z.string().email().optional(),
  // STARTTLS on 587 = secure:false; implicit TLS on 465 = secure:true.
  // booleanish, NOT z.coerce.boolean(): coerce would turn the string "false"
  // into true and silently force TLS-on-connect against plaintext/STARTTLS
  // SMTP servers.
  smtpSecure: booleanish.default(false),
});
