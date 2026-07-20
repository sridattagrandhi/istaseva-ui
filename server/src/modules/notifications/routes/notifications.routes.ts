import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { notificationsController } from '../controllers/notifications.controller.js';
import { fcmTokensRepository } from '../repositories/fcm-tokens.repository.js';

const router = Router();

router.get('/', requireAuth, notificationsController.list.bind(notificationsController));
router.patch('/:id/read', requireAuth, notificationsController.markRead.bind(notificationsController));
router.post('/mark-all-read', requireAuth, notificationsController.markAllRead.bind(notificationsController));

// FCM push token registration
router.post('/fcm-token', requireAuth, async (req, res, next) => {
  try {
    const { token, platform = 'web' } = req.body as { token?: string; platform?: string };
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    const deviceHint = (req.headers['user-agent'] || '').slice(0, 200);
    await fcmTokensRepository.upsert(req.user!.id, token, platform, deviceHint);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/fcm-token', requireAuth, async (req, res, next) => {
  try {
    const { token } = req.body as { token?: string };
    if (!token) { res.status(400).json({ error: 'token is required' }); return; }
    await fcmTokensRepository.deleteToken(req.user!.id, token);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
