import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { safetyController } from '../controllers/safety.controller.js';

const router = Router();

router.get('/alerts', requireAuth, safetyController.listAlerts.bind(safetyController));
router.post('/alerts', requireAuth, safetyController.createAlert.bind(safetyController));
router.post('/checks', requireAuth, safetyController.createCheck.bind(safetyController));

export default router;
