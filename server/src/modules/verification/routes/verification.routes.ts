import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { verificationController } from '../controllers/verification.controller.js';

const router = Router();

router.get('/documents', requireAuth, verificationController.listDocuments.bind(verificationController));
router.post('/documents', requireAuth, verificationController.createDocument.bind(verificationController));
router.get('/status', requireAuth, verificationController.getStatus.bind(verificationController));

export default router;
