import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { onboardingChatController } from '../controllers/onboarding-chat.controller.js';

const router = Router();

router.post('/', requireAuth, onboardingChatController.chat.bind(onboardingChatController));
router.post('/enhance-description', requireAuth, onboardingChatController.enhanceDescription.bind(onboardingChatController));

export default router;
