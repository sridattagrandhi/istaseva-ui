import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { usersController } from '../controllers/users.controller.js';

const router = Router();

router.get('/me/profile', requireAuth, usersController.getMyProfile.bind(usersController));
router.patch('/me/profile', requireAuth, usersController.updateMyProfile.bind(usersController));
router.get('/me/consents', requireAuth, usersController.getMyConsents.bind(usersController));
router.put('/me/consents/:type', requireAuth, usersController.putMyConsent.bind(usersController));

// Account lifecycle (PRIV-002 / LEG-017): DSAR export + account deletion.
// Deletion additionally requires a recent sign-in (REAUTH_REQUIRED on stale
// auth_time). Erasure runs after a 48h grace window; the account stays
// usable in that window and the request can be cancelled until the job runs.
router.post('/me/export', requireAuth, usersController.requestMyExport.bind(usersController));
router.get('/me/export', requireAuth, usersController.getMyExport.bind(usersController));
router.post('/me/deletion-request', requireAuth, usersController.requestMyDeletion.bind(usersController));
router.get('/me/deletion-request', requireAuth, usersController.getMyDeletion.bind(usersController));
router.post('/me/deletion-request/cancel', requireAuth, usersController.cancelMyDeletion.bind(usersController));

export default router;
