import { z } from 'zod';

/** Body for POST /api/auth/forgot-password. We only need the email; the
 *  reset itself is completed client-side against Firebase using the oobCode
 *  carried by the emailed link. */
export const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(320),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

/** Body for POST /api/auth/password-changed. Fired best-effort by the client
 *  AFTER a successful `confirmPasswordReset` so the server can send a
 *  "your password was changed" security alert and write an audit record —
 *  reset completion is otherwise entirely client-side and invisible to us.
 *  The email is the one Firebase returned from `verifyPasswordResetCode`. */
export const passwordChangedSchema = z.object({
  email: z.string().trim().email().max(320),
});

export type PasswordChangedInput = z.infer<typeof passwordChangedSchema>;
