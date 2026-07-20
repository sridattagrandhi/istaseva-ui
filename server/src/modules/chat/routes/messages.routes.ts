import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { messagesController } from '../controllers/messages.controller.js';

const router = Router();

router.get('/conversations', requireAuth, messagesController.listConversations.bind(messagesController));
router.get('/conversations/:otherUserId', requireAuth, messagesController.getConversation.bind(messagesController));
router.post('/messages', requireAuth, messagesController.sendMessage.bind(messagesController));
router.patch('/messages/:id/read', requireAuth, messagesController.markAsRead.bind(messagesController));
router.patch('/conversations/:otherUserId/read', requireAuth, messagesController.markConversationAsRead.bind(messagesController));

export default router;
