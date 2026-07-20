import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { fraudController } from '../controllers/fraud.controller.js';

const router = Router();

router.post('/signals', requireAuth, fraudController.createSignal.bind(fraudController));

export default router;
