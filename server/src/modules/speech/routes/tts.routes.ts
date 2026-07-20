import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { ttsController } from '../controllers/tts.controller.js';

const router = Router();

router.post('/', requireAuth, ttsController.synthesize.bind(ttsController));

export default router;
