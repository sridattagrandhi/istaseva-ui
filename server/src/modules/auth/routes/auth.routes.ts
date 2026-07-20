import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { requireAuth } from '../../../common/auth/require-auth.js';

const router = Router();

// Public — the whole point is that the user is locked out. Rate limiting +
// enumeration-safe responses live in the controller.
router.post('/forgot-password', authController.forgotPassword.bind(authController));

// Public — fired after a successful client-side reset so we can alert + audit
// the change. Unauthenticated (the user isn't signed in after a reset link);
// rate-limited + enumeration-safe in the controller.
router.post('/password-changed', authController.passwordChanged.bind(authController));

// Authenticated — "sign out everywhere": revoke all sessions for the caller.
router.post('/logout-all', requireAuth, authController.logoutAll.bind(authController));

// Authenticated — mints the single-use WebSocket connect ticket (SEC-008).
router.post('/ws-ticket', requireAuth, authController.createWsTicket.bind(authController));

export default router;
