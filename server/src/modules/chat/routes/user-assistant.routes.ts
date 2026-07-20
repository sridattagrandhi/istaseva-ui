import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { userAssistantController } from '../controllers/user-assistant.controller.js';

const router = Router();

router.post('/', requireAuth, userAssistantController.chat.bind(userAssistantController));
// Agent-driven booking: creates a hold + Razorpay order in one shot so the
// UI can show a "Confirm & Pay" card inline in chat.
router.post('/prepare-booking', requireAuth, userAssistantController.prepareBooking.bind(userAssistantController));

export default router;
