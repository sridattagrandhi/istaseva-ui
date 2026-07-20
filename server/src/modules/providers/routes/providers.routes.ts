import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { providersController } from '../controllers/providers.controller.js';

const router = Router();

router.get('/me/profile', requireAuth, providersController.getMyProfile.bind(providersController));
router.get('/me/earnings', requireAuth, providersController.getMyEarnings.bind(providersController));
router.get('/me/insights', requireAuth, providersController.getMyInsights.bind(providersController));
// Payouts: where the partner wants their money + where their money is.
router.get('/me/payout-account', requireAuth, providersController.getMyPayoutAccount.bind(providersController));
router.put('/me/payout-account', requireAuth, providersController.saveMyPayoutAccount.bind(providersController));
router.get('/me/payouts', requireAuth, providersController.getMyPayouts.bind(providersController));
router.get('/by-user/:userId', requireAuth, providersController.getByUserId.bind(providersController));
router.post('/', requireAuth, providersController.createProfile.bind(providersController));
// Idempotent upsert — used by onboarding which can't know whether the
// caller already has a profile from a previous session.
router.put('/me/profile', requireAuth, providersController.upsertProfile.bind(providersController));

export default router;
