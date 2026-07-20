import { Request, Response, NextFunction } from 'express';
import { AppError, ValidationError } from '../../../common/errors/app-error.js';
import { consumeRateLimit } from '../../../common/cache/redis.js';
import { logger } from '../../../common/logging/logger.js';
import { forgotPasswordSchema, passwordChangedSchema } from '../schemas/password-reset.schema.js';
import { requestPasswordReset, notifyPasswordChanged, logoutAllDevices } from '../services/auth.service.js';
import { mintWsTicket, WS_TICKET_TTL_SECONDS } from '../../../common/auth/ws-ticket.js';

// Reset requests are cheap to fire but expensive to abuse (email spam,
// enumeration probing). Cap tightly per-email AND per-IP; tripping either
// returns 429. Windows are 15 min to match the general auth limiter.
const RESET_WINDOW_SECONDS = 15 * 60;
const RESET_MAX_PER_EMAIL = 3;
const RESET_MAX_PER_IP = 10;

// The password-changed ping fires at most once per real reset, but it's an
// unauthenticated "email this address" endpoint, so cap it the same way as
// forgot-password to blunt alert-spam / probing.
const CHANGED_MAX_PER_EMAIL = 3;
const CHANGED_MAX_PER_IP = 10;

export class AuthController {
  /**
   * POST /api/auth/forgot-password — public.
   *
   * Always responds `{ success: true }` when the input is a valid email,
   * regardless of whether an account exists, so it can't enumerate users.
   * Delivery happens out-of-band via the notifications pipeline.
   */
  async forgotPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = forgotPasswordSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      const email = parsed.data.email.toLowerCase();

      const ip = req.ip || 'unknown';
      const [byEmail, byIp] = await Promise.all([
        consumeRateLimit(`forgot-password:email:${email}`, RESET_MAX_PER_EMAIL, RESET_WINDOW_SECONDS),
        consumeRateLimit(`forgot-password:ip:${ip}`, RESET_MAX_PER_IP, RESET_WINDOW_SECONDS),
      ]);
      if (!byEmail.allowed || !byIp.allowed) {
        throw new AppError(429, 'Too many reset requests. Please try again later.', 'RATE_LIMITED');
      }

      // `delivered` reports whether our own email pipeline sent the branded
      // link — NOT whether the account exists (both report the same). The
      // client falls back to Firebase's built-in sender when delivered=false
      // (e.g. SES not configured in dev), so a link always reaches the user.
      let delivered = false;
      try {
        ({ delivered } = await requestPasswordReset(email));
      } catch (err) {
        logger.error('forgotPassword: unexpected service error', { err: String(err) });
      }

      res.json({ success: true, delivered });
    } catch (err) { next(err); }
  }

  /**
   * POST /api/auth/password-changed — public.
   *
   * Best-effort security signal the client fires after `confirmPasswordReset`
   * succeeds (reset completion is client-side, so the server can't observe it
   * otherwise). Writes an audit record and sends a "your password was changed"
   * alert. Always responds `{ success: true }` regardless of whether the
   * account exists, so it can't enumerate users; rate-limited per-email AND
   * per-IP. Never fails the caller — the reset already succeeded.
   */
  async passwordChanged(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = passwordChangedSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      const email = parsed.data.email.toLowerCase();

      const ip = req.ip || 'unknown';
      const [byEmail, byIp] = await Promise.all([
        consumeRateLimit(`password-changed:email:${email}`, CHANGED_MAX_PER_EMAIL, RESET_WINDOW_SECONDS),
        consumeRateLimit(`password-changed:ip:${ip}`, CHANGED_MAX_PER_IP, RESET_WINDOW_SECONDS),
      ]);
      if (!byEmail.allowed || !byIp.allowed) {
        throw new AppError(429, 'Too many requests. Please try again later.', 'RATE_LIMITED');
      }

      try {
        await notifyPasswordChanged(email, { via: 'reset', ip });
      } catch (err) {
        // notifyPasswordChanged is already best-effort internally; guard anyway
        // so a notification hiccup never turns a completed reset into an error.
        logger.error('passwordChanged: unexpected service error', { err: String(err) });
      }

      res.json({ success: true });
    } catch (err) { next(err); }
  }

  /**
   * POST /api/auth/logout-all — authenticated.
   *
   * "Sign out everywhere": revokes every session for the caller and primes the
   * revocation cache so other devices' still-unexpired ID tokens stop working
   * right away. The client signs out locally after this resolves.
   */
  async logoutAll(req: Request, res: Response, next: NextFunction) {
    try {
      await logoutAllDevices(req.user!.id);
      res.json({ success: true });
    } catch (err) { next(err); }
  }

  /**
   * POST /api/auth/ws-ticket — authenticated (SEC-008).
   *
   * Mints a short-lived single-use ticket the client presents in the
   * WebSocket URL (`/ws?ticket=...` / `/ws/voice?ticket=...`) instead of
   * putting the long-lived bearer token in the query string, where it
   * would leak into access logs and proxies.
   */
  async createWsTicket(req: Request, res: Response, next: NextFunction) {
    try {
      const ticket = await mintWsTicket(req.user!.id);
      res.json({ ticket, expiresInSeconds: WS_TICKET_TTL_SECONDS });
    } catch (err) { next(err); }
  }
}

export const authController = new AuthController();
